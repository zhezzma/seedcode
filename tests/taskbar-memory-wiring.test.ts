// tests/taskbar-memory-wiring.test.ts
// TaskBar 关闭记忆的 wiring 结构断言（useTaskBarState 依赖 vue 响应性 + useChatState 单例，
// node --test 无法直接实例化——与 pending-queue-wiring.test.ts 同模式：钉住源码关键形状）。
//
// 背景bug：关闭面板后切到无清单会话再切回，面板复活。
// 两条可达路径，本测试钉住对应的三道防线：
// 1. 跨会话污染：snapshot watch 回调若用「当前 chatState.sessionKey」配「上一会话的 panelMem」，
//    切换 flush 中会把旧记忆撞上新快照并落盘（无清单会话 seen 为空时必现）。
//    防线 = 元组 watch [snapshot, sessionKey] 同源求值 + memOwner 归属兜底 + 回调内用解构 key 落盘。
// 2. 空 seen 关闭：快照稳定期挂载（路由往返 HomeView 重挂、sessionsMap 存活）时非 immediate 的
//    snapshot watch 从未触发，dismiss 只翻 dismissed 会把 seen:[] 落盘；
//    切走再切回的首次快照触发即把已关步骤误判为新步骤（复活）。
//    防线 = dismiss 用 unionSeen 把当前活步骤 id 固化进 seen。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const source = readFileSync(path.join(repoRoot, 'src/composables/useTaskBarState.ts'), 'utf8')

test('taskbar 记忆：snapshot 与 sessionKey 同源求值（元组 watch），落盘用解构 key 而非 chatState.sessionKey', () => {
    // 元组 watch：key 与 snap 同一 job 求值，跨会话切换的任何 flush 时序下都不会错配
    assert.match(source, /watch\(\[snapshot, \(\) => chatState\.sessionKey\]/)
    // 回调解构出 key，apply/落盘都使用它
    assert.match(source, /，?\s*\[snap, key\]\)? =>/)
    assert.match(source, /savePanelMemory\(key, next\)/)
    // 回调内不允许再读 chatState.sessionKey 落盘（时序假设清零）
    const watchBody = source.slice(source.indexOf('watch([snapshot'), source.indexOf('function dismiss'))
    assert.ok(!/savePanelMemory\(chatState\.sessionKey/.test(watchBody), 'snapshot watch 内禁止用 chatState.sessionKey 落盘')
})

test('taskbar 记忆：memOwner 归属兜底——写入前发现归属不符即同步重载', () => {
    // 元组 watch 之外的窗口（快照 null→null 不变时元组 watch 不触发）由 sessionKey watch 重载；
    // 元组 watch 内再校验一次归属，两个 watcher 谁先谁后都能保证写入时归属一致
    assert.match(source, /const memOwner = ref\(chatState\.sessionKey\)/)
    assert.match(source, /if \(memOwner\.value !== key\) \{[\s\S]*?panelMem\.value = loadPanelMemory\(key\)/)
    // sessionKey watch 本体仍负责重载（处理 null→null 窗口）
    assert.match(source, /watch\(\(\) => chatState\.sessionKey, \(key\) => \{[\s\S]*?memOwner\.value = key[\s\S]*?panelMem\.value = loadPanelMemory\(key\)/)
})

test('taskbar 记忆：dismiss 把当前活步骤 id 固化进 seen（防空 seen 关闭后的复活）', () => {
    assert.match(source, /unionSeen\(panelMem\.value\.seen, tasks\.value\.map\(\(t\) => t\.id\)\)/)
    // dismissed 翻转与 seen 固化同帧落盘
    assert.match(source, /panelMem\.value = \{ \.\.\.panelMem\.value, seen, dismissed: true \}/)
})

test('taskbar 记忆：工具名字面量仍与服务端唯一真相源同值（tasklist）', () => {
    const snapshotSource = readFileSync(path.join(repoRoot, 'src/utils/taskbar-snapshot.ts'), 'utf8')
    assert.match(snapshotSource, /m\.toolName !== 'tasklist'/)
})
