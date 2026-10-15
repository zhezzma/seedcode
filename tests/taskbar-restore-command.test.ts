// tests/taskbar-restore-command.test.ts
// /taskbar 客户端命令的 wiring 结构断言（同 taskbar-memory-wiring.test.ts 模式：
// useTaskBarState 依赖 vue 响应性，node --test 无法直接实例化，钉住源码关键形状）。
//
// 背景bug：TaskBar 被 ✕ 关闭后无任何途径再次显示（服务端同名扩展命令在 rpc 宿主下
// 是静默 no-op）。方案：HomeView 在 handleSend 顶层拦截 /taskbar，纯客户端 restore。
//
// 两条关键顺序假设，本测试钉住对应防线：
// 1. /taskbar 拦截必须位于 busy 分支之前：纯 UI 操作 busy 时放行——
//    若落到 busy gating 之后，会被 commandNotAvailableWhileBusy 拦下。
// 2. TaskBar 必须响应 expandRequest（展开清单 + taskbar-flash 脉冲）：面板已显示
//    且已展开时 expanded 置位是 no-op，脉冲保证命令在任何状态下都有可见反馈。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const homeViewSource = readFileSync(path.join(repoRoot, 'src/views/HomeView.vue'), 'utf8')
const taskBarStateSource = readFileSync(path.join(repoRoot, 'src/composables/useTaskBarState.ts'), 'utf8')
const taskBarSource = readFileSync(path.join(repoRoot, 'src/components/chat/TaskBar.vue'), 'utf8')

/**
 * 截取 restore() 函数体后再断言：无界懒匹配（[\s\S]*?）可能跨函数命中
 * 后文的同形文本而假通过（如 dismiss 里的同款 savePanelMemory 行），
 * 先用首尾锚点切片把断言窗口封闭在 restore 体内。
 */
function restoreBody(): string {
    const start = taskBarStateSource.indexOf('function restore(): boolean {')
    assert.ok(start > -1, 'useTaskBarState 缺少 restore()')
    const end = taskBarStateSource.indexOf('\n    return { snapshot, tasks, counts', start)
    assert.ok(end > start, 'restore() 结尾锚点丢失（结构变更后须同步本测试）')
    return taskBarStateSource.slice(start, end)
}

test('/taskbar：HomeView 拦截位于 busy 分支之前（纯 UI 操作 busy 时放行）', () => {
    const intercept = homeViewSource.indexOf('/^\\/taskbar(?:\\s|$)/i')
    assert.ok(intercept > -1, 'HomeView 必须存在 /taskbar 客户端拦截')
    // 从拦截位置向后找 busy 锚点：/taskbar 块自己的注释里可能引用锚点名，不算数
    const busyBranch = homeViewSource.indexOf('Case 1: Busy + no text', intercept)
    assert.ok(busyBranch > -1, 'handleSend 的 busy 分支锚点缺失（结构变更后须同步本测试）')
    assert.ok(intercept < busyBranch, '/taskbar 拦截必须在 busy gating 之前，否则 busy 时被误拦')
})

test('/taskbar：restore 无活步骤返回 false，调用方提示而非静默', () => {
    const body = restoreBody()
    assert.match(body, /counts\.value\.total === 0/)
    assert.match(body, /return false/)
    assert.match(homeViewSource, /!taskBarState\.restore\(\)[\s\S]{0,80}?t\('home\.noTaskBar'\)/)
})

test('/taskbar：restore 翻转 dismissed 并落盘 + 广播展开（断言封闭在函数体内）', () => {
    const body = restoreBody()
    assert.match(body, /panelMem\.value = \{ \.\.\.panelMem\.value, dismissed: false \}/)
    assert.match(body, /savePanelMemory\(chatState\.sessionKey, panelMem\.value\)/)
    assert.match(body, /expandRequest\.value\+\+/)
})

test('/taskbar：TaskBar 响应 expandRequest——展开清单 + taskbar-flash 脉冲（任何状态都有可见反馈）', () => {
    assert.match(taskBarStateSource, /const expandRequest = ref\(0\)/)
    assert.match(taskBarSource, /watch\(expandRequest, \(\) => \{[\s\S]{0,160}?expanded\.value = true/)
    // 脉冲：面板已显示且已展开时 expanded 置位是 no-op，背景闪烁兜底可见反馈
    assert.match(taskBarSource, /'taskbar-flash': flashed/)
    assert.match(taskBarSource, /@keyframes taskbar-flash/)
})

test('/taskbar：useTaskBarState 为模块级单例（HomeView 与 TaskBar 共享同一份 panelMem）', () => {
    // 若退化为每次调用新建状态，restore() 翻转的内存态落不到 TaskBar 渲染的那份上
    assert.match(taskBarStateSource, /const _taskBarState = buildTaskBarState\(\)/)
    assert.match(taskBarStateSource, /export function useTaskBarState\(\) \{[\s\S]{0,60}?return _taskBarState/)
})
