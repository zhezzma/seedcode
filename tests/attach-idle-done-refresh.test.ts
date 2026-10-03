import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ==================== attach 空闲 done 的全量刷新去重（/messages + /entries + /usage） ====================
//
// 根因：切换到未缓存的空闲会话时，loadChatHistory 刚拉完全量数据（/messages +
// finally 里的 /entries + /usage），紧随其后的 attach 对空闲会话立即回
// message_state -> done，done 分支又把同一批请求原样重拉一遍（间隔仅一个 RTT，
// 返回数据相同），每次首切一个会话多发 3 个冗余请求。
//
// 修复：精确区分两种 done——
//   1. attach 空闲 done：全程未见流活动且历史刚全量加载过（historyLoadedAt 新鲜）
//      → 跳过 done 分支的消息/树重拉（resetStreamState 保留；usage 仍轻量补拉——
//      它是唯一没有其他追平通道的请求，loadChatHistory finally 里那次失败时靠这里兜底）
//   2. 真实流 done（attach 期间见过流活动，或非 attach 的 chat/retry/edit 流）
//      → 必须刷新：最后一条消息、树、usage 都在这次落地，任何时间窗都不能压
//   3. 空闲 done 但历史非新鲜（缓存会话切回）→ 必须刷新：这是追平离开期间
//      变化的唯一通道
//
// 注：useChatState.ts 为模块级单例且依赖 Vue/router，无法在 node 环境 import，
// 沿用 session-switch-aborts-sse.test.ts 的源码结构断言模式。

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

test('handleSSEEvent 接受 skipSettledRefresh 选项，done 分支据此跳过重拉但保留 resetStreamState', () => {
    const fn = extractConst(chatStateSource, 'handleSSEEvent')

    // 签名带可选 options
    assert.match(fn, /options\?: \{ skipSettledRefresh\?: boolean \}/, 'handleSSEEvent 应接受 skipSettledRefresh 选项')

    // done 分支内：resetStreamState 无条件在前，跳过判断在后（流状态清理不能省）
    const doneIdx = fn.indexOf("case 'done':")
    assert.ok(doneIdx >= 0, "case 'done' not found")
    const resetIdx = fn.indexOf('resetStreamState(sessionData)', doneIdx)
    const guardIdx = fn.indexOf('options?.skipSettledRefresh', doneIdx)
    assert.ok(resetIdx >= 0, 'done 分支应保留 resetStreamState')
    assert.ok(guardIdx >= 0, 'done 分支应有 skipSettledRefresh 守卫')
    assert.ok(resetIdx < guardIdx, 'resetStreamState 必须在跳过判断之前（无条件执行）')

    // 守卫之后的完整刷新链路仍在（真实流 done 依赖它）
    const afterGuard = fn.slice(guardIdx)
    assert.match(afterGuard, /apiGet<\{ messages: ChatMessage\[\] \}>/, 'done 分支应保留 /messages 重拉')
    assert.match(afterGuard, /fetchSessionTree\(targetKey\)/, 'done 分支应保留 /entries 刷新')
    assert.match(afterGuard, /fetchSessionUsage\(targetKey\)/, 'done 分支应保留 /usage 刷新')

    // 跳过分支内仍轻量补拉 usage：/messages + /entries 由 loadChatHistory 的
    // try/finally 刚刚落地，唯 usage 在 finally 那次失败时没有其他追平通道
    const skipBranch = fn.slice(guardIdx, fn.indexOf('// 静默刷新消息', guardIdx))
    assert.match(skipBranch, /fetchSessionUsage\(targetKey\)/, '跳过 done 时应补拉 /usage（唯一无兜底的请求）')
    assert.match(skipBranch, /break/, '跳过分支必须在此截断，不得落到 /messages + /entries 重拉')
})

test('attachToSessionIfNeeded 应跟踪 streaming 状态并仅对「空闲 done + 历史新鲜」跳过刷新', () => {
    const fn = extractFunction(chatStateSource, 'attachToSessionIfNeeded')

    // 闭包内跟踪是否见过 streaming（isStreaming / compacting 都算）
    assert.match(fn, /attachSawStreaming = false/, '进入 attach 前应初始化 attachSawStreaming')
    assert.match(fn, /attachSawStreaming = true/, 'message_state 报告 streaming/compacting 时应置位')
    const sawInitIdx = fn.indexOf('attachSawStreaming = false')
    const sseIdx = fn.indexOf('attachSessionSSE(')
    assert.ok(sawInitIdx >= 0 && sseIdx >= 0 && sawInitIdx < sseIdx, 'attachSawStreaming 必须在创建 SSE 连接前初始化')

    // 加固：message_state 之外的任何事件（真实流 delta/error 等）也算见过流——
    // 防「快照说空闲但随后来了流事件、其 done 被误跳过」的运行间隙竞态
    assert.match(
        fn,
        /if \(event\.event !== 'done'\) \{\s*attachSawStreaming = true\s*\}/,
        'message_state/done 之外的任何事件都应置位 attachSawStreaming',
    )

    // 跳过条件必须同时满足：done 事件 && 全程未见 streaming && 历史刚加载过。
    // 缺一不可：真实流 done 有新数据；非新鲜说明可能错过变化（缓存切回场景）
    assert.match(
        fn,
        /event\.event === 'done' && !attachSawStreaming\s*&&\s*isHistoryLoadFresh\(targetKey\)/,
        '跳过条件应为 done && 未见过 streaming && 历史加载新鲜'
    )
    assert.match(fn, /skipSettledRefresh/, '应把 skipSettledRefresh 传给 handleSSEEvent')
})

test('loadChatHistory 成功拉到消息后应记录 historyLoadedAt（跳过判定的依据）', () => {
    const fn = extractConst(chatStateSource, 'loadChatHistory')
    const assignIdx = fn.indexOf('sd.chatMessages = result?.messages || []')
    const recordIdx = fn.indexOf('historyLoadedAt.set(sessionId, performance.now())')
    assert.ok(assignIdx >= 0, 'loadChatHistory 应写入 chatMessages')
    assert.ok(recordIdx >= 0, 'loadChatHistory 应记录 historyLoadedAt（单调时钟）')
    assert.ok(assignIdx < recordIdx, 'historyLoadedAt 必须在消息写入成功之后记录（失败不得置新鲜）')
})

test('isHistoryLoadFresh 基于时间窗口判断历史新鲜度', () => {
    const fn = extractFunction(chatStateSource, 'isHistoryLoadFresh')
    assert.match(fn, /historyLoadedAt\.get\(targetKey\)/)
    assert.match(fn, /HISTORY_LOAD_FRESH_MS/, '应存在显式的新鲜窗口常量')
    assert.match(
        fn,
        /performance\.now\(\) - loadedAt/,
        '应使用单调时钟：Date.now() 会被 NTP 回拨/休眠恢复拉长窗口（危险方向：非新鲜被误判新鲜，跳过本该追平的刷新）',
    )
})

// ==================== 回归守卫（既有行为，防“顺手简化”破坏） ====================

test('回归：loadChatHistory 的 finally 仍拉 /entries + /usage（流式 attach 的 done 遥遥无期，首屏靠它）', () => {
    const load = extractConst(chatStateSource, 'loadChatHistory')
    assert.match(load, /fetchSessionTree\(targetKey\)/)
    assert.match(load, /fetchSessionUsage\(targetKey\)/)
})

test('回归：非 attach 的 SSE 流（sendMessage/retry/edit 共享骨架）不得传 skipSettledRefresh——真实流 done 必须全量刷新', () => {
    for (const name of ['sendMessage', 'retryMessage', 'editMessage']) {
        const fn = extractConst(chatStateSource, name)
        assert.ok(!fn.includes('skipSettledRefresh'), `${name} 的 done 必须触发全量刷新，不得跳过`)
    }
    // retry/edit 的 handleSSEEvent 调用点已收口进共享骨架 beginBranchRewriteSSE，
    // 阴性守卫必须跟着收口：未来给骨架加第四参（options）会静默绕过本不变量。
    // 骨架切片止于 \nconst retryMessage，保证断言落在骨架本体而非其后的函数
    const skeletonStart = chatStateSource.indexOf('function beginBranchRewriteSSE')
    assert.ok(skeletonStart >= 0, 'beginBranchRewriteSSE 骨架应存在')
    const skeletonEnd = chatStateSource.indexOf('\nconst retryMessage', skeletonStart)
    assert.ok(skeletonEnd > skeletonStart, '骨架切片终点应有效（indexOf 不得返回 -1）')
    const skeleton = chatStateSource.slice(skeletonStart, skeletonEnd)
    assert.ok(!skeleton.includes('skipSettledRefresh'), '骨架（retry/edit 共用）的 done 必须触发全量刷新，不得跳过')
    // 精确匹配无第四参的调用形态：多传任何实参都会导致本正则失配而报警
    assert.match(skeleton, /\n\s*handleSSEEvent\(event\.event, event\.data, targetKey\)\s*\n/, '骨架的 handleSSEEvent 调用不得携带 options（第四参）')
})

test('回归：fetchSessionUsage 本体保持直接请求（重复抑制只属于 attach 空闲 done 跳过机制）', () => {
    const fn = extractConst(chatStateSource, 'fetchSessionUsage')
    assert.ok(
        !fn.includes('usageFetchAt'),
        '不得引入时间窗去重门禁（如 usageFetchAt 缓存时间戳）：跳过机制只覆盖 attach 空闲 done，别处去重会让 usage 失去追平通道',
    )
    assert.match(fn, /apiGet<SessionUsage>/, 'fetchSessionUsage 本体应保持直接请求')
})
