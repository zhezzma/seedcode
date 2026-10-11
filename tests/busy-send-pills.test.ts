import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_COMMANDS, isClientInterceptedCommand } from '../src/composables/clientCommands.ts'
import { DELIVERY_COMMANDS } from '../src/utils/command-invocation.ts'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8')

const chatInputSource = read('src/components/chat/ChatInput.vue')
const homeViewSource = read('src/views/HomeView.vue')
const settingSource = read('src/stores/setting.ts')
const zhSource = read('src/i18n/zh.ts')
const enSource = read('src/i18n/en.ts')
const commandInvocationSource = read('src/utils/command-invocation.ts')

/** 截取 `const <name> = ...` 到下一个顶层 `\nconst ` 的文本（function 声明不截断切片） */
function extractFn(source: string, name: string): string {
    const start = source.indexOf(`const ${name} = `)
    assert.ok(start >= 0, `function ${name} not found`)
    const end = source.indexOf('\nconst ', start + 1)
    return source.slice(start, end === -1 ? undefined : end)
}

test('ChatInput: busy + 有文字且非命令文本时渲染 steer/follow 双胶囊按钮并携带显式 mode 发送', () => {
    // 双通道分支必须以「busy + 输入框有文字 + 非命令文本」为条件，且两个按钮各自携带显式 mode
    assert.match(chatInputSource, /v-if="isBusy && inputText\.trim\(\) && !busyCommandText"/)
    assert.match(chatInputSource, /onSend\('steer'\)/)
    assert.match(chatInputSource, /onSend\('follow'\)/)
    // emit 签名携带可选 mode
    assert.match(chatInputSource, /\(e: 'send', mode\?: BusySendBehavior\)/)
    // 小屏只显图标时等宽等高成正圆（与相邻 btn-circle btn-sm 同尺寸），sm+ 恢复胶囊；两个按钮都要有
    assert.equal((chatInputSource.match(/w-8 p-0 sm:w-auto sm:px-3/g) || []).length, 2)
})

test('ChatInput: busyCommandText 覆盖全部「mode 不消费」路径（服务端命令表 + 客户端注册表派生），不污染 isCommandInvocation', () => {
    // 与 HomeView.handleSend 的全部拦截点同源：
    // - 顶部 trim() 后路由（前导空白粘贴场景不得漂移）；
    // - 服务端命令：startsWith('/') 门禁 + isCommandInvocation（表未加载回退 null）；
    //   ! 前缀被 startsWith 门禁排除在外（仍走 mode）；
    // - 客户端命令：从 clientCommands 注册表派生（isClientInterceptedCommand），
    //   新增命令只改注册表，UI 自动跟随——禁止在 UI 谓词里写死命令名。
    // isCommandInvocation 镜像后端语义、另有调用方（自动命名守卫等），
    // 客户端命令不得写入 util。
    const fn = extractFn(chatInputSource, 'busyCommandText')
    assert.match(fn, /const text = inputText\.value\.trim\(\)/)
    assert.match(fn, /if \(!text\.startsWith\('\/'\)\) return false/)
    assert.match(fn, /isCommandInvocation\(text, commandsLoaded\.value \? allCommands\.value\.map\(cmd => cmd\.name\) : null\)/)
    assert.match(fn, /isClientInterceptedCommand\(text\)/)
    assert.ok(!/['"]\/(?:tree|todos|goal)['"]/.test(fn), 'busyCommandText must not hardcode client command names')
    assert.match(chatInputSource, /import \{ isClientInterceptedCommand \} from '\.\.\/\.\.\/composables\/clientCommands'/)
    assert.match(chatInputSource, /import \{ isCommandInvocation \} from '\.\.\/\.\.\/utils\/command-invocation'/)
    // util 保持纯后端语义：客户端命令不得混入
    assert.ok(!commandInvocationSource.includes('/tree'), 'client command /tree must not leak into isCommandInvocation')
    assert.ok(!commandInvocationSource.includes('todos'), 'client command /todos must not leak into isCommandInvocation')
})

test('isClientInterceptedCommand: 语义与 HomeView 拦截分支逐字对齐（tree 精确区分大小写 / todos 前缀忽略大小写）', () => {
    // /tree：HomeView isTreeCommand = inputText.trim() === '/tree'（区分大小写、无参数）
    assert.equal(isClientInterceptedCommand('/tree'), true)
    assert.equal(isClientInterceptedCommand('/tree '), true) // 调用方容忍未修剪文本（内部 trim）
    assert.equal(isClientInterceptedCommand('/tree extra'), false)
    assert.equal(isClientInterceptedCommand('/Tree'), false)
    // /todos：HomeView todosCommand = /^\/todos(?:\s|$)/i（前缀、忽略大小写）
    assert.equal(isClientInterceptedCommand('/todos'), true)
    assert.equal(isClientInterceptedCommand('/todos xxx'), true)
    assert.equal(isClientInterceptedCommand('/TODOS'), true)
    assert.equal(isClientInterceptedCommand('/todosX'), false)
    // 服务端命令与非命令不命中
    assert.equal(isClientInterceptedCommand('/steer xxx'), false)
    assert.equal(isClientInterceptedCommand('/compact'), false)
    assert.equal(isClientInterceptedCommand('tree'), false)
    assert.equal(isClientInterceptedCommand(''), false)
})

test('注册表↔HomeView 对齐：每个标注 intercept 的客户端命令在 handleSend 中都有对应拦截分支', () => {
    for (const cmd of CLIENT_COMMANDS.filter(c => c.intercept)) {
        if (cmd.intercept === 'exact') {
            assert.match(homeViewSource, new RegExp(`=== '/${cmd.name}'`), `client command /${cmd.name} (exact) has no handleSend branch`)
        } else {
            assert.match(homeViewSource, new RegExp(`\\/${cmd.name}\\(\\?:\\\\s\\|\\$\\)`), `client command /${cmd.name} (prefix) has no handleSend branch`)
        }
    }
    assert.ok(CLIENT_COMMANDS.some(c => c.intercept === 'exact'), 'registry should have at least one exact command wired')
    assert.ok(CLIENT_COMMANDS.some(c => c.intercept === 'prefix'), 'registry should have at least one prefix command wired')
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

test('busy 单源：isBusy 只在 useChatMessages 派生，ChatInput 不再本地重推', () => {
    const chatMessagesSource = read('src/composables/useChatMessages.ts')
    // 唯一定义点：busy 语义变更（如纳入 compacting）只改这里
    assert.match(chatMessagesSource, /const isBusy = computed\(\(\) => state\.chatSending \|\| Boolean\(state\.chatRunId\)\)/)
    // ChatInput 直信 props，不得再本地 OR 同样的信号（旧冗余分叉点；注释提及不算，只锁 isBusy 计算属性）
    assert.doesNotMatch(chatInputSource, /isBusy = computed\([^)]*(?:chatSending|chatRunId)/)
})

test('命令清单单源：HomeView 的 delivery/busyAllowed 正则由共享常量派生，且 delivery ⊆ / 命令下拉', () => {
    assert.match(commandInvocationSource, /export const DELIVERY_COMMANDS/)
    assert.match(commandInvocationSource, /export const BUSY_ALLOWED_COMMANDS/)
    assert.match(homeViewSource, /DELIVERY_COMMANDS/)
    assert.match(homeViewSource, /BUSY_ALLOWED_COMMANDS/)
    // HomeView 不得再保留手写命令名清单
    assert.ok(!homeViewSource.includes("['goal']"), 'busyAllowed must be imported, not hardcoded')
    assert.ok(!homeViewSource.includes('follow-up|steer|abort'), 'delivery alternation must be derived, not hardcoded')
    // delivery 命令在 / 命令下拉可见（COMMANDS 列表）；abort 例外——仅经输入文本触发，
    // 不入下拉菜单（与下拉 COMMANDS 现状一致）
    const chatInputComposable = read('src/composables/useChatInput.ts')
    for (const name of DELIVERY_COMMANDS.filter(n => n !== 'abort')) {
        assert.ok(chatInputComposable.includes(`'/${name}'`), `/\${name} missing from COMMANDS dropdown`)
    }
})

test('i18n: chat.busySend 四键在 zh/en 均存在（$t 字符串路径无类型保护，防静默缺键）', () => {
    for (const key of ['steer', 'follow', 'steerTitle', 'followTitle']) {
        assert.match(zhSource, new RegExp(`busySend: \\{[\\s\\S]*?${key}: `))
        assert.match(enSource, new RegExp(`busySend: \\{[\\s\\S]*?${key}: `))
    }
})
