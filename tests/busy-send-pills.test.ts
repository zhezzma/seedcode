import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8')

const chatInputSource = read('src/components/chat/ChatInput.vue')
const homeViewSource = read('src/views/HomeView.vue')
const settingSource = read('src/stores/setting.ts')
const zhSource = read('src/i18n/zh.ts')
const enSource = read('src/i18n/en.ts')

/** 截取 `const <name> = ...` 到下一个顶层 `\nconst ` 的文本（function 声明不截断切片） */
function extractFn(source: string, name: string): string {
    const start = source.indexOf(`const ${name} = `)
    assert.ok(start >= 0, `function ${name} not found`)
    const end = source.indexOf('\nconst ', start + 1)
    return source.slice(start, end === -1 ? undefined : end)
}

test('ChatInput: busy + 有文字时渲染 steer/follow 双胶囊按钮并携带显式 mode 发送', () => {
    // 双通道分支必须以「busy + 输入框有文字」为条件，且两个按钮各自携带显式 mode
    assert.match(chatInputSource, /v-if="isBusy && inputText\.trim\(\)"/)
    assert.match(chatInputSource, /onSend\('steer'\)/)
    assert.match(chatInputSource, /onSend\('follow'\)/)
    // emit 签名携带可选 mode
    assert.match(chatInputSource, /\(e: 'send', mode\?: BusySendBehavior\)/)
})

test('ChatInput: 原 send/stop 按钮退为 v-else 分支（不再承担 busy+有文字 的发送）', () => {
    const sendArea = chatInputSource.slice(chatInputSource.indexOf('<!-- Send'))
    assert.ok(sendArea.includes('v-else'), 'single send/stop button must be the else branch of the dual-pill branch')
    // 停止图标条件保持不变：busy + 无文字 → StopIcon
    assert.match(sendArea, /StopIcon v-if="isBusy && !inputText\.trim\(\)"/)
})

test('ChatInput: 主色高亮跟随 busySendBehavior 设置（steer→warning / follow→primary）', () => {
    const emphasized = extractFn(chatInputSource, 'busySteerEmphasized')
    assert.match(emphasized, /settingsStore\.busySendBehavior === 'steer'/)
    assert.match(chatInputSource, /busySteerEmphasized \? 'btn-warning/)
    assert.match(chatInputSource, /!busySteerEmphasized \? 'btn-primary/)
})

test('HomeView: handleSend 显式 mode 优先，无 mode 回落 busySendBehavior（Enter 默认通道）', () => {
    const fn = extractFn(homeViewSource, 'handleSend')
    assert.match(fn, /mode\?: BusySendBehavior/)
    assert.match(fn, /mode === 'steer' \|\| mode === 'follow' \? mode : settingsStore\.busySendBehavior/)
    // 回落逻辑驱动 steerMessage/followMessage 分流（与旧行为一致）
    assert.match(fn, /sendMode === 'follow'\s*\n\s*\? await chatState\.followMessage\(inputText\)/)
    assert.match(fn, /: await chatState\.steerMessage\(inputText\)/)
})

test('设置项保留：busySendBehavior 仍在 store 中作为发送键默认通道（未被误删）', () => {
    assert.match(settingSource, /busySendBehavior: BusySendBehavior/)
    assert.match(settingSource, /busySendBehavior: 'follow'/)
})

test('i18n: chat.busySend 四键在 zh/en 均存在（$t 字符串路径无类型保护，防静默缺键）', () => {
    for (const key of ['steer', 'follow', 'steerTitle', 'followTitle']) {
        assert.match(zhSource, new RegExp(`busySend: \\{[\\s\\S]*?${key}: `))
        assert.match(enSource, new RegExp(`busySend: \\{[\\s\\S]*?${key}: `))
    }
})
