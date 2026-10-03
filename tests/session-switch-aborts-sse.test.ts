import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ==================== 切走会话时 abort 该会话的 SSE 连接 ====================
//
// 根因：浏览器 HTTP/1.1 对同一 host 的并发连接上限为 6 条。useChatState 为每个
// 运行中的 session 长期持有 SSE 连接（sseConnections 按 session 保留，切走不
// abort），≥5 个运行中会话即耗尽配额 → 后续所有请求（发消息/切会话/全部 API）
// 静默排队（DevTools Stalled），只有刷新页面才恢复。
//
// 修复：setSessionKey / createNewSession 切走会话时断开旧会话的 SSE 连接，使客
// 户端任意时刻只持有当前会话的 1~2 条连接，与运行中 session 数量解耦。
// 服务端断连不杀 run，切回时 attachToSessionIfNeeded 以 afterEntryId 增量重放 +
// partialText 追平 UI。
//
// 注：useChatState.ts 为模块级单例且依赖 Vue/router，无法在 node 环境 import，
// 沿用 pending-queue-wiring.test.ts 的源码结构断言模式。

const repoRoot = path.resolve(__dirname, '..')
const chatStateSource = readFileSync(path.join(repoRoot, 'src/composables/useChatState.ts'), 'utf8')

/** 截取 `const <name> = ...` 到下一个顶层 `\nconst ` 的文本 */
function extractConst(source: string, name: string): string {
    const start = source.indexOf(`const ${name} = `)
    assert.ok(start >= 0, `const ${name} not found`)
    const end = source.indexOf('\nconst ', start + 1)
    return source.slice(start, end === -1 ? undefined : end)
}

/** 截取 `function <name>` 到下一个顶层 `\nfunction ` 的文本 */
function extractFunction(source: string, name: string): string {
    const start = source.indexOf(`function ${name}`)
    assert.ok(start >= 0, `function ${name} not found`)
    const end = source.indexOf('\nfunction ', start + 1)
    return source.slice(start, end === -1 ? undefined : end)
}

test('setSessionKey 切到不同会话时 abort 旧会话的 SSE 连接', () => {
    const fn = extractConst(chatStateSource, 'setSessionKey')

    // 必须在覆盖 state.sessionKey 之前捕获旧 key（覆盖后就找不回了）
    const captureIdx = fn.indexOf('const previousKey = state.sessionKey')
    const assignIdx = fn.indexOf('state.sessionKey = key')
    assert.ok(captureIdx >= 0, 'setSessionKey 应先捕获 previousKey = state.sessionKey')
    assert.ok(assignIdx >= 0, 'setSessionKey 应存在 state.sessionKey = key')
    assert.ok(captureIdx < assignIdx, 'previousKey 必须在 state.sessionKey = key 之前捕获')

    // 只有真正切换（previousKey 存在且 !== key）才 abort：
    // 首次进入（sessionKey 为空串）与原地重进同一会话都不得误伤
    assert.match(fn, /if \(previousKey && previousKey !== key\)/)
    // 修复的核心行为：真正发起 abort（只断本地流，不请求服务端停止）。缺失此行时
    // 套件仍会通过 —— 这正是最可能被未来“顺手简化”掉的回归点
    assert.match(fn, /abortSessionSSE\(previousKey\)/)

    // 不得 abort 目标会话 key 自身的连接：切回一个正在流式的会话时，
    // 必须保留其现有 SSE（attachToSessionIfNeeded 依赖 sseConnections.has 判断跳过）
    assert.ok(!fn.includes('abortSessionSSE(key)'), '禁止 abort 目标会话 key 自身的 SSE')
})

test('createNewSession 置空 sessionKey 前 abort 当前会话的 SSE 连接', () => {
    const fn = extractConst(chatStateSource, 'createNewSession')
    const abortIdx = fn.indexOf('abortSessionSSE(state.sessionKey)')
    const assignIdx = fn.indexOf("state.sessionKey = ''")
    assert.ok(abortIdx >= 0, 'createNewSession 应 abort 当前会话的 SSE')
    assert.ok(assignIdx >= 0, 'createNewSession 应置空 state.sessionKey')
    assert.ok(abortIdx < assignIdx, '必须在置空 sessionKey 之前 abort（置空后就拿不到旧 key）')
})

test('abortSessionSSE 只断开目标会话的本地 SSE，不请求服务端中止（不杀 run）', () => {
    const fn = extractFunction(chatStateSource, 'abortSessionSSE')
    assert.match(fn, /sseConnections\.get\(targetKey\)/)
    assert.match(fn, /sse\.abort\(\)/)
    assert.match(fn, /sseConnections\.delete\(targetKey\)/)
    // 切走 ≠ 中止：服务端 run 继续跑完，切回靠 attach 增量重放追平。
    // 请求服务端中止是 abortChat（用户显式停止）的职责，切换会话不得顺带停止任务——
    // 包括直接调用（apiPost/apiGet）和间接委托 abortChat() 两条路径
    assert.ok(!fn.includes('apiPost'), '切换会话不得请求服务端中止')
    assert.ok(!fn.includes('apiGet'), '切换会话不得发起额外请求')
    assert.ok(!fn.includes('abortChat'), '切换会话不得委托 abortChat（会顺带请求服务端停止任务）')
})

// ==================== 回归守卫（既有行为，防后续“顺手简化”破坏） ====================

test('回归：同会话 sendMessage/retry/edit 发起新流前仍 abort 该会话旧流', () => {
    // 这些是同 key 替换（旧流让位新流），与切换会话的 abort 语义互补，缺一不可
    const send = extractConst(chatStateSource, 'sendMessage')
    assert.match(send, /const existingSSE = sseConnections\.get\(targetKey\)/, 'sendMessage 应查同会话旧流')
    assert.match(send, /existingSSE\.abort\(\)/, 'sendMessage 应 abort 同会话旧流')
    // retry/edit 已合并进共享骨架 beginBranchRewriteSSE：abort 旧流收口在骨架内，
    // 两条路径必须经由骨架（绕过骨架 = 绕过 abort 旧流 + 流状态重置）。
    // 骨架切片止于 \nconst retryMessage，保证断言落在骨架本体而非其后的函数
    const skeletonStart = chatStateSource.indexOf('function beginBranchRewriteSSE')
    assert.ok(skeletonStart >= 0, 'beginBranchRewriteSSE 骨架应存在')
    const skeletonEnd = chatStateSource.indexOf('\nconst retryMessage', skeletonStart)
    assert.ok(skeletonEnd > skeletonStart, '骨架切片终点应有效（indexOf 不得返回 -1）')
    const skeleton = chatStateSource.slice(skeletonStart, skeletonEnd)
    assert.match(skeleton, /const existingSSE = sseConnections\.get\(targetKey\)/, '骨架应查同会话旧流')
    assert.match(skeleton, /existingSSE\.abort\(\)/, '骨架应 abort 同会话旧流')
    for (const name of ['retryMessage', 'editMessage']) {
        assert.match(extractConst(chatStateSource, name), /beginBranchRewriteSSE\(targetKey/, `${name} 应经由共享骨架（含 abort 旧流）`)
    }
})

test('回归：切回会话仍走 attachToSessionIfNeeded 增量重放追平 UI', () => {
    // abort 后切回的恢复链路依赖：setSessionKey 未加载分支 + loadChatHistory 均调用 attach
    const setKey = extractConst(chatStateSource, 'setSessionKey')
    assert.match(setKey, /attachToSessionIfNeeded\(key\)/)
    const load = extractConst(chatStateSource, 'loadChatHistory')
    assert.match(load, /attachToSessionIfNeeded\(sessionId\)/)
})
