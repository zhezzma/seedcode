import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ==================== 子代理轨迹推送接线（ext.subagent_trace → 抽屉增量） ====================
//
// 服务端 subagents 扩展在轨迹侧车覆写同刻扇出增量（offset/total 与只读路由同源）。
// 客户端抽屉：打开时一次性 GET 全量（offset 0），运行中增量走推送；轮询自旋链删除，
// poll 保留为一次性缺口拉平路径。
//
// 注：SubagentTraceDrawer.vue 依赖 vue 响应性单例，无法在 node 环境 import，
// 沿用源码结构断言模式。

const repoRoot = path.resolve(__dirname, '..')
const drawer = readFileSync(path.join(repoRoot, 'src/components/chat/SubagentTraceDrawer.vue'), 'utf8')

test('抽屉订阅 ext.subagent_trace（两仓事件名契约）并经 onExtensionEvent 总线', () => {
    assert.match(
        drawer,
        /import \{ onExtensionEvent \} from '\.\.\/\.\.\/composables\/extension-events'/,
        '应从 composables/extension-events 导入 onExtensionEvent',
    )
    assert.match(
        drawer,
        /onExtensionEvent\('ext\.subagent_trace'/,
        "订阅事件名必须与服务端 SUBAGENT_TRACE_EVENT 同值（'ext.subagent_trace'），改名须两仓同步",
    )
})

test('订阅处理器：归属（key=parentSessionId + subId）与载荷形状守卫', () => {
    const start = drawer.indexOf("onExtensionEvent('ext.subagent_trace'")
    assert.ok(start >= 0, '未找到 ext.subagent_trace 订阅块')
    const block = drawer.slice(start, start + 1400)

    assert.match(block, /key !== t\.parentSessionId/, '跨会话事件必须丢弃（推送按父会话流投递）')
    assert.match(block, /d\.subId !== subId/, 'subId 不匹配的事件必须丢弃（多 tab 轨迹共存）')
    assert.match(block, /typeof d\.total !== 'number'/, 'total 必须是 number（游标权威）')
    assert.match(block, /typeof d\.baseOffset !== 'number'/, 'baseOffset 必须是 number（三态判定依据）')
    assert.match(block, /!Array\.isArray\(d\.entries\)/, 'entries 必须是数组')
})

test('applyTraceDelta 委托纯函数游标：重叠续接/缺口/收缩统一处理 + 对账兜底', () => {
    // 三态判定核心在 src/utils/subagent-trace-cursor.ts（行为级测试见
    // tests/subagent-trace-cursor.test.ts）；抽屉侧断言委托关系与结果分派
    assert.match(
        drawer,
        /import \{ resolveTraceDelta \} from '\.\.\/\.\.\/utils\/subagent-trace-cursor'/,
        '三态判定应委托纯函数模块（行为级测试覆盖处）',
    )
    const start = drawer.indexOf('function applyTraceDelta')
    assert.ok(start >= 0, '未找到 applyTraceDelta 统一应用口')
    const fn = drawer.slice(start, start + 1200)
    assert.match(fn, /resolveTraceDelta\(\{ total, baseOffset, traceOffset \}\)/, '应委托纯函数判定')
    assert.match(fn, /filter\(\(e: TraceEntry\) => e\.type === 'message'\)/, '只渲染 message 条目（与旧 poll 同规则）')

    // 缺口/收缩 → 全量重拉（单一正确路径）；poll 本体不再自旋
    assert.match(drawer, /=== 'resync'\) \{\s*void reload\(\)/, 'resync 应触发全量重拉')
    assert.doesNotMatch(drawer, /scheduleNext/, '轮询自旋链（scheduleNext）应已删除')
    assert.doesNotMatch(drawer, /pollDelay/, '退避间隔变量应随轮询链一并删除')

    // SSE 缺席期间的活性兜底（审核 Important #1）：慢速对账定时器
    assert.match(drawer, /RECONCILE_INTERVAL_MS = 8000/, '对账间隔应存在')
    assert.match(drawer, /setInterval\(\(\) => \{\s*if \(!trace\.current\.value\) \{ stopReconcile\(\); return \}\s*void poll\(\)/, '对账 tick 应调 poll 且随抽屉关闭自停')
    assert.match(drawer, /stopReconcile\(\)\s*unsubscribeTracePush\(\)/, '卸载应停对账 + 退订推送')
})

test('初始载入保留一次性 GET（快照线不携带大轨迹，首屏仍走 offset 全量）', () => {
    assert.match(
        drawer,
        /\/api\/extensions\/subagents\/sessions\/\$\{t\.parentSessionId\}\/subagents\/\$\{subId\}\?offset=/,
        '一次性 GET 路径应保留（首载 + 缺口拉平）',
    )
    // 请求 offset 必须取发送时刻的游标快照（响应期间可能被推送推进 → 重叠切片依赖它）
    assert.match(drawer, /const requestedOffset = traceOffset/, '发送时刻游标快照应存在')
})
