import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ==================== usage 扩展推送接线（ext.usage_state → sessionUsage 桶） ====================
//
// 服务端 usage 扩展（seedagent extensions/usage）经 extension-events 双投递线 + 观察
// 者线推送全量用量：推送线（GenerationTask.afterResponse 每条终态 provider 消息）+
// 快照线（attach collect）+ 观察者线（run_end/compaction_end）。客户端在 useChatState
// 订阅该事件，载荷直接写入对应会话桶——ChatHeader 连接指示器 tooltip 随之实时刷新。
// GET /usage 轮询端点已删除，客户端无任何 usage 拉取通道。
//
// 注：useChatState.ts 为模块级单例且依赖 Vue/router，无法在 node 环境 import，
// 沿用 attach-idle-done-refresh.test.ts 的源码结构断言模式。

const repoRoot = path.resolve(__dirname, '..')
const chatStateSource = readFileSync(path.join(repoRoot, 'src/composables/useChatState.ts'), 'utf8')

test('useChatState 订阅 ext.usage_state（两仓事件名契约）并经 onExtensionEvent 总线', () => {
    assert.match(
        chatStateSource,
        /import \{[^}]*onExtensionEvent[^}]*\} from '\.\/extension-events'/,
        '应从 ./extension-events 导入 onExtensionEvent（与既有 emitExtensionEvent 同源）',
    )
    assert.match(
        chatStateSource,
        /onExtensionEvent\('ext\.usage_state'/,
        "订阅事件名必须与服务端 USAGE_STATE_EVENT 同值（'ext.usage_state'），改名须两仓同步",
    )
})

test('订阅处理器：载荷形状守卫后按事件 sessionKey 写入会话桶', () => {
    // 截取订阅块（onExtensionEvent('ext.usage_state' 起 1200 字符）
    const start = chatStateSource.indexOf("onExtensionEvent('ext.usage_state'")
    assert.ok(start >= 0, '未找到 ext.usage_state 订阅块')
    const block = chatStateSource.slice(start, start + 1200)

    // 归属检查：事件 sessionKey 决定写入哪个会话桶（跨会话事件写自己的桶，不误伤当前会话）
    assert.match(block, /if \(!key[^\n]*\) return/, '无 sessionKey 的事件必须丢弃（attach 前的孤儿事件）')
    assert.match(block, /isUsagePayload\(data\)/, '载荷必须经形状守卫（ext.* 事件是外部输入）')
    assert.match(block, /getSessionData\(key\)\.sessionUsage = data/, '应整体替换会话桶的 sessionUsage（服务端权威快照语义）')
})

test('isUsagePayload 守卫覆盖 SessionUsage 全部必需字段', () => {
    const start = chatStateSource.indexOf('function isUsagePayload')
    assert.ok(start >= 0, '未找到 isUsagePayload 守卫函数')
    const guard = chatStateSource.slice(start, start + 1600)

    // 数值字段（SessionUsage 必需）
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'contextWindow']) {
        assert.match(guard, new RegExp(`typeof d\\.${field} === 'number'`), `守卫应校验 ${field} 为 number`)
    }
    // 可空字段（compaction 后 contextTokens 可能 null；无窗口模型 percent 为 null）
    assert.match(guard, /d\.contextTokens === null \|\| typeof d\.contextTokens === 'number'/, 'contextTokens 应允许 null')
    assert.match(guard, /d\.percent === null \|\| typeof d\.percent === 'number'/, 'percent 应允许 null')
    assert.match(guard, /typeof d\.autoCompactEnabled === 'boolean'/, 'autoCompactEnabled 应校验为 boolean')
})

test('GET /usage 轮询通道已删净：无 fetchSessionUsage 残留，数据源唯 ext.usage_state', () => {
    // 服务端 GET /:sessionId/usage 端点已随 usage 扩展落地而删除——客户端不得残留
    // 任何对旧端点的调用（404 静默失败毫无声息，属最脏的退化形态）
    assert.doesNotMatch(chatStateSource, /fetchSessionUsage/, 'fetchSessionUsage 函数及调用点应已全删')
    assert.doesNotMatch(chatStateSource, /\/api\/chat\/\$\{targetKey\}\/usage/, '不得残留旧 /usage 端点调用')
    // 唯一数据源 = ext.usage_state 订阅；SessionUsage 类型保留（守卫/桶形状用）
    assert.match(chatStateSource, /interface SessionUsage/, 'SessionUsage 类型应保留（守卫与桶形状）')
    assert.match(chatStateSource, /getSessionData\(key\)\.sessionUsage = data/, '唯一写入口 = 扩展事件订阅')
})

test('消费端连线：sessionUsage computed 暴露 + ChatHeader tooltip 读取（重命名会静默孤儿化整个桶）', () => {
    // 生产端：useChatState 返回对象必须暴露 sessionUsage（useChatState.ts 底部 return）
    const returnIdx = chatStateSource.lastIndexOf('sessionUsage,')
    assert.ok(returnIdx > 0, '返回对象应暴露 sessionUsage')
    // 消费端：ChatHeader 的 usageTipLines computed 读 chatState.sessionUsage
    const header = readFileSync(path.join(repoRoot, 'src/components/chat/ChatHeader.vue'), 'utf8')
    assert.match(header, /chatState\.sessionUsage/, 'ChatHeader tooltip 应读 sessionUsage（连接指示器下方数据源）')
})
