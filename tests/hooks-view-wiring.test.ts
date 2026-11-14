import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * 钩子管理页 wiring 测试（SFC 源码断言，写法照 tests/mcp-view-wiring.test.ts）。
 *
 * 页面结构与样式照抄 CronView：格子卡片 + <dialog> modal 表单。
 * 覆盖 vue-tsc 查不出的功能性接线：
 *   1. /api/extensions/hooks 的列表 payload 是 { hooks }，不是裸数组；
 *   2. 删除走 useConfirm（不用原生 window.confirm）；
 *   3. 新建/编辑走 modal（showModal/close），不走 URL 参数；
 *   4. 事件切换后用 maxTimeoutFor 钳制 timeoutSec（否则切到 ServerStop 必报 timeoutInvalid）；
 *   5. 格子布局与 CronView 同款类名（grid-cols-1 / md:2 / xl:3）；
 *   6. 导航/路由/文案接线（zh/en 双侧）。
 */
const testDir = path.dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(path.resolve(testDir, '..', rel), 'utf8')

const view = read('src/views/HooksView.vue')
const cronView = read('src/views/CronView.vue')
const navigation = read('src/config/navigation.ts')
const router = read('src/router/index.ts')
const zh = read('src/i18n/zh.ts')
const en = read('src/i18n/en.ts')

test('列表接口按 { hooks } 形状解包（不是裸数组）', () => {
    assert.match(
        view,
        /apiGet<\{ hooks\?: HookItem\[\] \}>\('\/api\/extensions\/hooks'/,
        'list endpoint must be typed as { hooks } payload',
    )
    assert.match(view, /hooks\.value = Array\.isArray\(res\?\.hooks\) \? res\.hooks : \[\]/)
})

test('新建走 POST，编辑走 PUT（带 encodeURIComponent），开关也走 PUT 且失败回滚', () => {
    assert.match(view, /apiPost\('\/api\/extensions\/hooks',/)
    assert.match(view, /apiPut\(`\/api\/extensions\/hooks\/\$\{encodeURIComponent\(/)
    assert.match(view, /toggleEnabled[\s\S]{0,400}apiPut\(`\/api\/extensions\/hooks/)
    assert.match(view, /item\.enabled = previous/)
})

test('删除走 apiDelete 且确认走 useConfirm（不用原生 window.confirm）', () => {
    assert.match(view, /apiDelete\(`\/api\/extensions\/hooks\/\$\{encodeURIComponent\(/)
    assert.match(view, /import \{ useConfirm \} from '\.\.\/composables\/useConfirm'/)
    assert.match(view, /const \{ confirm \} = useConfirm\(\)/)
    assert.match(view, /if \(!\(await confirm\(/)
    assert.doesNotMatch(view, /window\.confirm\(/)
})

test('新建/编辑走 dialog modal（照 CronView 的 job_modal），不走 URL 参数', () => {
    assert.match(view, /<dialog id="hook_modal" class="modal">/)
    assert.match(view, /getElementById\('hook_modal'\) as HTMLDialogElement/)
    assert.match(view, /modal\?\.showModal\(\)/)
    assert.match(view, /modal\?\.close\(\)/)
    assert.match(view, /hookFormFromItem\(item\)/)
    // modal 框架类名与 CronView 逐字一致
    assert.match(cronView, /<div class="modal-box w-full max-w-2xl">/)
    assert.match(view, /<div class="modal-box w-full max-w-2xl">/)
    // 旧的 ?edit= 查询参数模式已移除
    assert.doesNotMatch(view, /route\.query\.edit/)
    assert.doesNotMatch(view, /from 'vue-router'/)
})

test('保存前过 validateHookForm，事件切换用 maxTimeoutFor 钳制 timeoutSec', () => {
    assert.match(view, /validateHookForm\(form\.value\)/)
    assert.match(view, /maxTimeoutFor\(/)
    assert.match(view, /pointer-events-none opacity-50/)
})

test('agents 列表请求写法同 McpView（/api/agents，静默）', () => {
    assert.match(view, /apiGet<Array<\{ id: string; name: string \}>>\('\/api\/agents', true\)/)
})

test('不写死颜色（只用 daisyUI 语义类）', () => {
    assert.doesNotMatch(view, /-\[#|\bbg-black\b|\btext-black\b|\bbg-white\b|\btext-white\b/)
})

test('格子卡片样式照抄 CronView（grid + 卡片类名逐字一致，整卡可点编辑）', () => {
    const gridClass = 'grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
    assert.match(cronView, new RegExp(gridClass.replaceAll(' ', '\\s+')))
    assert.match(view, new RegExp(gridClass.replaceAll(' ', '\\s+')))
    // 卡片主体类名与 CronView 一致（含 hover 过渡与整卡点击）
    const cardClass = 'card bg-base-200 shadow-sm border border-base-300 cursor-pointer hover:border-primary transition-colors hover:shadow-md group h-full'
    assert.match(cronView, new RegExp(cardClass.replaceAll(' ', '\\s+')))
    assert.match(view, new RegExp(cardClass.replaceAll(' ', '\\s+')))
    assert.match(view, /@click="openEdit\(item\)"/)
    // 开关/编辑/删除按钮与 CronView 的类名一致，且 stop 冒泡不触发整卡点击
    assert.match(view, /@click\.stop="toggleEnabled\(item\)"/)
    assert.match(view, /@click\.stop="removeHook\(item\)"/)
})

test('ViewHeader 带 is-main-page 和 wc-pad，头部加号按钮照 CronView', () => {
    assert.match(view, /<ViewHeader [^>]*is-main-page[^>]*wc-pad|<ViewHeader [^>]*wc-pad[^>]*is-main-page/)
    assert.match(view, /class="btn btn-ghost btn-circle btn-xs"/)
})

test('高级折叠区用 daisyUI collapse，默认展开', () => {
    assert.match(view, /collapse collapse-arrow/)
    assert.match(view, /<details class="collapse collapse-arrow" open/)
})

test('导航：hooks 项在 cron 之后，BoltIcon 双套图标', () => {
    assert.match(navigation, /route: 'hooks'/)
    assert.match(navigation, /BoltIcon/)
    assert.match(navigation, /BoltIcon as BoltIconSolid/)
    const hooksIndex = navigation.indexOf("route: 'hooks'")
    const cronIndex = navigation.indexOf("route: 'cron'")
    assert.ok(hooksIndex > cronIndex, `hooks(${hooksIndex}) must come after cron(${cronIndex})`)
})

test('路由：hooks 指向 HooksView，位于 cron 之后', () => {
    assert.match(router, /name: 'hooks'/)
    assert.match(router, /HooksView/)
    const hooksIndex = router.indexOf("name: 'hooks'")
    const cronIndex = router.indexOf("name: 'cron'")
    assert.ok(hooksIndex > cronIndex, `hooks(${hooksIndex}) must come after cron(${cronIndex})`)
})

test('文案：zh/en 都有 hooks 段与 sidebar.hooks，zh 含逐字文案', () => {
    for (const source of [zh, en]) {
        assert.match(source, /    hooks: \{/)
        assert.match(source, /hooks: '[^']*'/)
        assert.match(source, /clickToDisable/)
        assert.match(source, /clickToEnable/)
    }
    for (const text of [
        '尚未安装钩子',
        '新建钩子，以在任务生命周期事件中运行命令。',
        '新建钩子',
        '编辑钩子',
        '事件',
        '运行方式',
        'Shell 命令',
        '进程',
        '作用域',
        '匹配器',
        '命令',
        '参数',
        '每行一个 argv 参数。',
        'Shell',
        '系统默认',
        '后台运行',
        '高级',
        '超时时间（秒）',
        '超时时间，单位秒。',
        '状态消息',
        '自定义字段 JSON',
        '保存',
        '点击禁用',
        '点击启用',
    ]) {
        assert.ok(zh.includes(text), `zh missing verbatim text: ${text}`)
    }
    // 已删除的键不得残留（modal 化后不再使用）
    for (const source of [zh, en]) {
        const hooksSection = source.slice(source.indexOf('    hooks: {'), source.indexOf('    mcp: {'))
        assert.doesNotMatch(hooksSection, /installed:/, 'installed key should be removed')
        assert.doesNotMatch(hooksSection, /moreActions:/, 'moreActions key should be removed')
        assert.doesNotMatch(hooksSection, /editDesc:/, 'editDesc key should be removed')
    }
    // spec §5.7 的提示与警示文案
    for (const text of [
        '留空时匹配该事件的所有工具。',
        '该事件不使用匹配器',
        '关闭时，触发点会等钩子结束（最长到超时时间）再继续',
        '服务启动后运行，不等待',
        '关机流程会等它结束，最长 30 秒',
    ]) {
        assert.ok(zh.includes(text), `zh missing spec text: ${text}`)
    }
})
