import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ==================== notify 会话开关推送接线（ext.notify_state → 铃铛状态） ====================
//
// 服务端 notify 扩展双投递线（seedagent extensions/notify/state-event.ts）：
// - 快照线：attach/刷新/切会话时随帧恢复该会话的通知开关现态
// - 扇出口：POST toggle 落地后即时扇出（多窗口同步）
// ChatHeader 订阅该事件驱动铃铛；原 GET /settings/sessions/:id 轮询端点已删。
//
// 注：ChatHeader.vue 依赖 vue/router 单例，无法在 node 环境 import，
// 沿用源码结构断言模式（同 attach-idle-done-refresh.test.ts）。

const repoRoot = path.resolve(__dirname, '..')
const headerSource = readFileSync(path.join(repoRoot, 'src/components/chat/ChatHeader.vue'), 'utf8')

test('ChatHeader 订阅 ext.notify_state（两仓事件名契约）并经 onExtensionEvent 总线', () => {
    assert.match(
        headerSource,
        /import \{ onExtensionEvent \} from '\.\.\/\.\.\/composables\/extension-events'/,
        '应从 composables/extension-events 导入 onExtensionEvent',
    )
    assert.match(
        headerSource,
        /onExtensionEvent\('ext\.notify_state'/,
        "订阅事件名必须与服务端 NOTIFY_STATE_EVENT 同值（'ext.notify_state'），改名须两仓同步",
    )
})

test('订阅处理器：会话归属 + 布尔形状守卫后写入铃铛状态', () => {
    const start = headerSource.indexOf("onExtensionEvent('ext.notify_state'")
    assert.ok(start >= 0, '未找到 ext.notify_state 订阅块')
    const block = headerSource.slice(start, start + 900)

    // 归属：事件 sessionKey 必须等于当前会话（铃铛是会话级状态，跨会话事件不得误写）
    assert.match(block, /key !== chatState\.sessionKey/, '跨会话事件必须丢弃（notifyEnabled 是当前会话的铃铛）')
    assert.match(block, /typeof d\.enabled !== 'boolean'/, 'enabled 必须是布尔（外部输入守卫）')
    assert.match(block, /notifyEnabled\.value = d\.enabled/, '应写入铃铛状态')
})

test('GET 轮询通道已删净：无 loadNotifyStatus / settings GET 残留', () => {
    assert.doesNotMatch(headerSource, /loadNotifyStatus/, 'loadNotifyStatus 函数应已删除')
    assert.doesNotMatch(
        headerSource,
        /apiGet[^\n]*notify\/settings\/sessions/,
        '不得残留对已删除 GET 端点的调用（POST toggle 保留）',
    )
    // POST toggle（按钮线）保留：铃铛点击仍是权威写入口
    assert.match(
        headerSource,
        /apiPost<\{ enabled: boolean \}>\(\s*`\/api\/extensions\/notify\/settings\/sessions/,
        'POST toggle 应保留（按钮线）',
    )
})

test('会话切换时重置铃铛状态（快照线随 attach 恢复，防跨会话串显）', () => {
    // 原 watch 触发 loadNotifyStatus；现改为重置 false，等 attach 快照线送达现态
    const watchIdx = headerSource.indexOf('watch(')
    assert.ok(watchIdx >= 0, 'watch 未找到')
    const watchBlock = headerSource.slice(watchIdx, watchIdx + 400)
    assert.match(watchBlock, /chatState\.sessionKey/, 'watch 应跟踪 sessionKey')
    assert.match(watchBlock, /notifyEnabled\.value = false/, '切换时应重置铃铛（防上一会话状态闪现）')
})
