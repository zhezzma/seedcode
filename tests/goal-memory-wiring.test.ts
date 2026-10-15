// tests/goal-memory-wiring.test.ts
// GoalBar 关闭记忆的 wiring 结构断言（useGoalState 依赖 vue 响应性 + useChatState 单例，
// node --test 无法直接实例化——同 taskbar-memory-wiring.test.ts 模式：钉住源码关键形状）。
//
// 背景bug：applyGoalStateToMemory 曾把 null 快照并入「停止」重置——刷新/导航的加载窗口
// （sessionKey 已切、历史未到、goalState=null）会把 dismiss 记忆重置并落盘，历史到达后
// 状态条误判为新 goal 复活。防线 = null 原引用返回（纯函数，锚在 goal-snapshot.test.ts）
// + 本文件钉住的 wiring 三道防线（与 taskbar 同构）：
// 1. 跨会话污染：元组 watch [goalState, sessionKey] 同源求值 + memOwner 归属兜底
//    + 回调内用解构 key 落盘。
// 2. 空 seen 关闭：快照稳定期挂载时非 immediate 的 goalState watch 从未触发，
//    dismiss 固化当前运行周期 startedAt，切走再切回不会误判为新 goal（复活）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const source = readFileSync(path.join(repoRoot, 'src/composables/useGoalState.ts'), 'utf8')

test('goal 记忆：goalState 与 sessionKey 同源求值（元组 watch），落盘用解构 key 而非 chatState.sessionKey', () => {
    // 元组 watch：key 与 snap 同一 job 求值，跨会话切换的任何 flush 时序下都不会错配
    assert.match(source, /watch\(\[goalState, \(\) => chatState\.sessionKey\]/)
    // 回调解构出 key，apply/落盘都使用它
    assert.match(source, /，?\s*\[snap, key\]\)? =>/)
    assert.match(source, /savePanelMemory\(key, next\)/)
    // 回调内不允许再读 chatState.sessionKey 落盘（时序假设清零）
    const watchBody = source.slice(source.indexOf('watch([goalState'), source.indexOf('function dismiss'))
    assert.ok(!/savePanelMemory\(chatState\.sessionKey/.test(watchBody), 'goalState watch 内禁止用 chatState.sessionKey 落盘')
})

test('goal 记忆：memOwner 归属兜底——写入前发现归属不符即同步重载', () => {
    // 元组 watch 之外的窗口（快照 null→null 不变时元组 watch 不触发）由 sessionKey watch 重载；
    // 元组 watch 内再校验一次归属，两个 watcher 谁先谁后都能保证写入时归属一致
    assert.match(source, /const memOwner = ref\(chatState\.sessionKey\)/)
    assert.match(source, /if \(memOwner\.value !== key\) \{[\s\S]*?panelMem\.value = loadPanelMemory\(key\)/)
    // sessionKey watch 本体仍负责重载（处理 null→null 窗口）
    assert.match(source, /watch\(\(\) => chatState\.sessionKey, \(key\) => \{[\s\S]*?memOwner\.value = key[\s\S]*?panelMem\.value = loadPanelMemory\(key\)/)
})

test('goal 记忆：dismiss 把当前运行周期 startedAt 固化进 seen（防空 seen 关闭后的复活）', () => {
    // goal 版 unionSeen 对位：固化 goalState.value?.startedAt（无快照回落原 seen）
    assert.match(source, /goalState\.value\?\.startedAt \?\? panelMem\.value\.seenStartedAt/)
    // dismissed 翻转与 seen 固化同帧落盘
    assert.match(source, /panelMem\.value = \{ seenStartedAt, dismissed: true \}/)
})

test('goal 记忆：事件名字面量仍与服务端唯一真相源同值（ext.goal_state，前缀契约）', () => {
    // 数据通道：服务端 emitExtensionEvent('ext.goal_state') ↔ 客户端 onExtensionEvent('ext.goal_state')，
    // 两仓同步锚（客户端钉自家 source；服务端侧由 agent-end 测试钉发射）；
    // ext. 前缀 = 两仓扩展事件契约（服务端 contracts/extension-events.ts）
    assert.match(source, /onExtensionEvent\('ext\.goal_state'/)
    // 快照线形状守卫在统一应用口前方（非法载荷拒绝应用）
    assert.match(source, /isGoalStatePayload\(data\)/)
})

test('goal 记忆：null 与停止快照均不重置（BUG 回归锚——加载窗口/刷新不得吞 dismiss 记忆）', () => {
    // 纯函数防线在本文件的布线锚之外，这里钉住状态机源码形状：
    // null 与 enabled=false 均先行返回，不得重置
    const snapshotSource = readFileSync(path.join(repoRoot, 'src/utils/goal-snapshot.ts'), 'utf8')
    const body = snapshotSource.slice(
        snapshotSource.indexOf('export function applyGoalStateToMemory'),
        snapshotSource.indexOf('export function applyGoalStateToMemory') + 800,
    )
    assert.match(body, /if \(!state\) return mem/)
    assert.match(body, /if \(!state\.enabled\) return mem/)
    assert.doesNotMatch(body, /!state\.enabled.*\{.*seenStartedAt: null/)
})
