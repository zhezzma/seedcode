// tests/goalbar-restore-command.test.ts
// /goalbar 客户端命令的 wiring 结构断言（同 tasklist-restore-command.test.ts 模式：
// useGoalState 依赖 vue 响应性，node --test 无法直接实例化，钉住源码关键形状）。
//
// 背景：GoalBar 被 ✕ 关闭后需有途径再次显示。/goal 是服务端真命令（裸 /goal = 帮助）
// 不能劫持，故用独立客户端命令 /goalbar。
//
// 两条关键顺序/反馈假设，本测试钉住对应防线：
// 1. /goalbar 拦截必须位于 busy 分支之前：纯 UI 操作 busy 时放行——
//    若落到 busy gating 之后，会被 commandNotAvailableWhileBusy 拦下。
// 2. GoalBar 必须响应 expandRequest（展开详情 + goalbar-flash 脉冲）：状态条已显示
//    且已展开时命令仍需可见反馈。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_COMMANDS } from '../src/composables/clientCommands.ts'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const homeViewSource = readFileSync(path.join(repoRoot, 'src/views/HomeView.vue'), 'utf8')
const goalStateSource = readFileSync(path.join(repoRoot, 'src/composables/useGoalState.ts'), 'utf8')
const goalBarSource = readFileSync(path.join(repoRoot, 'src/components/chat/GoalBar.vue'), 'utf8')

/**
 * 截取 restore() 函数体后再断言：无界懒匹配（[\s\S]*?）可能跨函数命中
 * 后文的同形文本而假通过（如 dismiss 里的同款 savePanelMemory 行），
 * 先用首尾锚点切片把断言窗口封闭在 restore 体内。
 */
function restoreBody(): string {
    const start = goalStateSource.indexOf('function restore(): boolean {')
    assert.ok(start > -1, 'useGoalState 缺少 restore()')
    const end = goalStateSource.indexOf('\n    return { goalState', start)
    assert.ok(end > start, 'restore() 结尾锚点丢失（结构变更后须同步本测试）')
    return goalStateSource.slice(start, end)
}

test('注册表：/goalbar 客户端命令存在且为 prefix 拦截；/goal 命令名不被劫持', () => {
    const cmd = CLIENT_COMMANDS.find(c => c.name === 'goalbar')
    assert.ok(cmd, 'CLIENT_COMMANDS 缺少 goalbar')
    assert.equal(cmd.intercept, 'prefix')
    assert.ok(!CLIENT_COMMANDS.some(c => c.name === 'goal'), '/goal 是服务端真命令（裸 /goal = 帮助），客户端不得同名劫持')
})

test('/goalbar：HomeView 拦截位于 busy 分支之前（纯 UI 操作 busy 时放行）', () => {
    const intercept = homeViewSource.indexOf('/^\\/goalbar(?:\\s|$)/i')
    assert.ok(intercept > -1, 'HomeView 必须存在 /goalbar 客户端拦截')
    // 从拦截位置向后找 busy 锚点：/goalbar 块自己的注释里可能引用锚点名，不算数
    const busyBranch = homeViewSource.indexOf('Case 1: Busy + no text', intercept)
    assert.ok(busyBranch > -1, 'handleSend 的 busy 分支锚点缺失（结构变更后须同步本测试）')
    assert.ok(intercept < busyBranch, '/goalbar 拦截必须在 busy gating 之前，否则 busy 时被误拦')
})

test('/goalbar：restore 无 goal 状态返回 false，调用方提示而非静默', () => {
    const body = restoreBody()
    // 运行中或已停止均可恢复（停止态有恢复按钮）；仅完全无 goal-state 时返回 false
    assert.match(body, /if \(!goalState\.value\) return false/)
    assert.match(homeViewSource, /!goalbarState\.restore\(\)[\s\S]{0,80}?t\('home\.noGoalRunning'\)/)
})

test('/goalbar：restore 翻转 dismissed 并落盘 + 广播展开（断言封闭在函数体内）', () => {
    const body = restoreBody()
    assert.match(body, /panelMem\.value = \{ \.\.\.panelMem\.value, dismissed: false \}/)
    assert.match(body, /savePanelMemory\(chatState\.sessionKey, panelMem\.value\)/)
    assert.match(body, /expandRequest\.value\+\+/)
})

test('/goalbar：GoalBar 响应 expandRequest——展开详情 + goalbar-flash 脉冲（任何状态都有可见反馈）', () => {
    assert.match(goalStateSource, /const expandRequest = ref\(0\)/)
    assert.match(goalBarSource, /watch\(expandRequest, \(\) => \{[\s\S]{0,160}?expanded\.value = true/)
    // 脉冲：状态条已显示且已展开时 expanded 置位是 no-op，背景闪烁兜底可见反馈
    assert.match(goalBarSource, /'goalbar-flash': flashed/)
    assert.match(goalBarSource, /@keyframes goalbar-flash/)
})

test('/goalbar：useGoalState 为模块级单例（HomeView 与 GoalBar 共享同一份 panelMem）', () => {
    // 若退化为每次调用新建状态，restore() 翻转的内存态落不到 GoalBar 渲染的那份上
    assert.match(goalStateSource, /const _goalState = buildGoalState\(\)/)
    assert.match(goalStateSource, /export function useGoalState\(\) \{[\s\S]{0,60}?return _goalState/)
})
