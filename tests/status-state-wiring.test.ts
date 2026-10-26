import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ==================== status 扩展推送接线（ext.status_state → sessionStatus 桶） ====================
//
// 服务端 status 扩展（seedagent extensions/status）经 extension-events 双投递线 + 观察
// 者线推送全量状态：推送线（GenerationTask.afterResponse 每条终态 provider 消息）+
// 快照线（attach collect）+ 观察者线（run_end/compaction_end）。客户端在 useChatState
// 订阅该事件，载荷（服务端拼好的展示行数组：token 统计 / 模型与思考等级 / CPU·内存·
// 磁盘，显示段由服务端设置表单控制）直接写入对应会话桶——ChatHeader 连接指示器
// tooltip 随之实时刷新，客户端纯渲染零拼接。GET /usage 轮询端点已删除，客户端无任何
// 状态数据拉取通道。
//
// 注：useChatState.ts 为模块级单例且依赖 Vue/router，无法在 node 环境 import，
// 沿用 attach-idle-done-refresh.test.ts 的源码结构断言模式。

const repoRoot = path.resolve(__dirname, '..')
const chatStateSource = readFileSync(path.join(repoRoot, 'src/composables/useChatState.ts'), 'utf8')

test('useChatState 订阅 ext.status_state（两仓事件名契约）并经 onExtensionEvent 总线', () => {
    assert.match(
        chatStateSource,
        /import \{[^}]*onExtensionEvent[^}]*\} from '\.\/extension-events'/,
        '应从 ./extension-events 导入 onExtensionEvent（与既有 emitExtensionEvent 同源）',
    )
    assert.match(
        chatStateSource,
        /onExtensionEvent\('ext\.status_state'/,
        "订阅事件名必须与服务端 STATUS_STATE_EVENT 同值（'ext.status_state'），改名须两仓同步",
    )
})

test('订阅处理器：载荷形状守卫后按事件 sessionKey 写入会话桶', () => {
    // 截取订阅块（onExtensionEvent('ext.status_state' 起 1200 字符）
    const start = chatStateSource.indexOf("onExtensionEvent('ext.status_state'")
    assert.ok(start >= 0, '未找到 ext.status_state 订阅块')
    const block = chatStateSource.slice(start, start + 1200)

    // 归属检查：事件 sessionKey 决定写入哪个会话桶（跨会话事件写自己的桶，不误伤当前会话）
    assert.match(block, /if \(!key[^\n]*\) return/, '无 sessionKey 的事件必须丢弃（attach 前的孤儿事件）')
    assert.match(block, /isStatusPayload\(data\)/, '载荷必须经形状守卫（ext.* 事件是外部输入）')
    assert.match(block, /getSessionData\(key\)\.sessionStatus = data/, '应整体替换会话桶的 sessionStatus（服务端权威快照语义）')
})

test('isStatusPayload 守卫只验 lines 字符串数组（服务端冻结形状）', () => {
    const start = chatStateSource.indexOf('function isStatusPayload')
    assert.ok(start >= 0, '未找到 isStatusPayload 守卫函数')
    const guard = chatStateSource.slice(start, start + 800)

    assert.match(guard, /Array\.isArray\(lines\)/, '守卫应校验 lines 为数组')
    assert.match(guard, /lines\.every\(\(line\) => typeof line === 'string'\)/, '守卫应校验每行为 string')
})

test('GET /usage 轮询通道已删净：无 fetchSessionUsage 残留，数据源唯 ext.status_state', () => {
    // 服务端 GET /:sessionId/usage 端点已随原 usage 扩展落地而删除——客户端不得残留
    // 任何对旧端点的调用（404 静默失败毫无声息，属最脏的退化形态）
    assert.doesNotMatch(chatStateSource, /fetchSessionUsage/, 'fetchSessionUsage 函数及调用点应已全删')
    assert.doesNotMatch(chatStateSource, /\/api\/chat\/\$\{targetKey\}\/usage/, '不得残留旧 /usage 端点调用')
    // 唯一数据源 = ext.status_state 订阅；SessionStatus 类型保留（守卫/桶形状用）
    assert.match(chatStateSource, /interface SessionStatus/, 'SessionStatus 类型应保留（守卫与桶形状）')
    assert.match(chatStateSource, /getSessionData\(key\)\.sessionStatus = data/, '唯一写入口 = 扩展事件订阅')
})

test('消费端连线：sessionStatus computed 暴露 + ChatHeader tooltip 纯渲染（重命名会静默孤儿化整个桶）', () => {
    // 生产端：useChatState 返回对象必须暴露 sessionStatus（useChatState.ts 底部 return）
    const returnIdx = chatStateSource.lastIndexOf('sessionStatus,')
    assert.ok(returnIdx > 0, '返回对象应暴露 sessionStatus')
    // 消费端：ChatHeader 的 statusTipLines computed 读 chatState.sessionStatus 并纯映射 lines
    const header = readFileSync(path.join(repoRoot, 'src/components/chat/ChatHeader.vue'), 'utf8')
    assert.match(header, /chatState\.sessionStatus\?\.lines/, 'ChatHeader tooltip 应读 sessionStatus.lines（连接指示器下方数据源）')
    // 纯渲染约束：客户端不得残留任何拼接逻辑（formatTokens/buildUsageTip 已移回服务端，
    // 模型/思考行也不得回退为从会话行拼装）
    assert.doesNotMatch(header, /formatTokens|buildUsageTip|autoCompact|thinkingOff|currentSession/, '客户端不得残留状态行拼接逻辑')
})
