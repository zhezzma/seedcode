import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * MCP 管理页 wiring 测试（SFC 源码断言，对齐本仓 view-header-mobile-nav 模式）。
 *
 * 覆盖代码评审中两处 vue-tsc 查不出的功能性致命伤的回归：
 *   1. /api/mcp/servers 与 /tools 的 payload 是 { servers } / { tools, state }，
 *      不是裸数组——曾因类型断言成数组导致整页白屏/工具抽屉脏数据；
 *   2. OAuth 打开浏览器必须走 openExternalLink（Tauri WebView 内 window.open
 *      不可靠），删除确认必须走 useConfirm（不用原生 window.confirm）。
 * 另覆盖轮询清理、请求代次、ViewHeader 属性等结构性不变量。
 */
const testDir = path.dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(path.resolve(testDir, '..', rel), 'utf8')

const view = read('src/views/McpView.vue')
const utils = read('src/utils/mcp.ts')
const zh = read('src/i18n/zh.ts')
const en = read('src/i18n/en.ts')

test('列表接口按 { servers } 形状解包（不是裸数组）', () => {
    assert.match(
        view,
        /apiGet<\{ servers\?: McpServerItem\[\] \}>\('\/api\/mcp\/servers'/,
        'list endpoint must be typed as { servers } payload',
    )
    assert.match(view, /servers\.value = Array\.isArray\(res\?\.servers\) \? res\.servers : \[\]/)
})

test('工具接口按 { tools, state } 形状解包', () => {
    assert.match(view, /apiGet<\{\s*tools\?: Array<\{ name: string; description\?: string \}>;\s*state\?: McpServerState\s*\}>\(/)
    assert.match(view, /tools\.value = res\?\.tools \?\? \[\]/)
})

test('OAuth 授权链接走 openExternalLink，不用 window.open', () => {
    assert.match(view, /import \{ openExternalLink \} from '\.\.\/utils\/external-link'/)
    assert.match(view, /if \(!openExternalLink\(url\)\)/)
    assert.doesNotMatch(view, /window\.open\(/)
})

test('删除确认走 useConfirm，不用原生 window.confirm', () => {
    assert.match(view, /import \{ useConfirm \} from '\.\.\/composables\/useConfirm'/)
    assert.match(view, /const \{ confirm \} = useConfirm\(\)/)
    assert.match(view, /if \(!\(await confirm\(/)
    assert.doesNotMatch(view, /window\.confirm\(/)
})

test('轮询定时器在 onUnmounted 全清（无泄漏）', () => {
    assert.match(view, /onUnmounted\(\(\) => \{[\s\S]{0,120}stopAllPolling\(\)/)
    assert.match(view, /const pollTimers = new Map<string, ReturnType<typeof setInterval>>\(\)/)
    // 挂载异步加载期间不得起定时器（alive 守卫）
    assert.match(view, /if \(!alive\) return/)
})

test('工具抽屉请求有代次保护（后到覆盖先到）', () => {
    assert.match(view, /let toolsSeq = 0/)
    assert.match(view, /const seq = \+\+toolsSeq/)
    assert.match(view, /if \(seq !== toolsSeq\) return/)
})

test('所有服务端 id 拼接都过 encodeURIComponent', () => {
    const urlBuilds = view.match(/\/api\/mcp\/servers\/\$\{[^}]+\}/g) ?? []
    assert.ok(urlBuilds.length >= 7, 'expected all server paths to interpolate encodeURIComponent(id)')
    for (const build of urlBuilds) {
        assert.match(build, /encodeURIComponent\(/, `path build must encode id: ${build}`)
    }
})

test('ViewHeader 传 wc-pad 与 is-main-page（悬浮窗键避让 + 移动端返回箭头）', () => {
    assert.match(view, /<ViewHeader :title="t\('mcp\.title'\)" is-main-page wc-pad>/)
})

test('编辑保存保留未知传输字段（env/inheritEnv/headers 不丢）', () => {
    assert.match(utils, /extraTransport: Record<string, unknown>/)
    assert.match(utils, /transport: \{ \.\.\.form\.extraTransport, \.\.\.transport \}/)
})

test('mcp.* i18n 键 zh/en 双侧齐全', () => {
    for (const rel of ['src/i18n/zh.ts', 'src/i18n/en.ts']) {
        const source = rel.endsWith('zh.ts') ? zh : en
        for (const key of [
            'title:',
            'add:',
            'empty:',
            'allAgents:',
            'authRequired:',
            'openAuth:',
            'confirmDelete:',
            'loadFailed:',
            'authOpenFailed:',
            "state: {",
        ]) {
            assert.ok(source.includes(key), `${rel} missing mcp.${key}`)
        }
    }
    // 插值参数一致（删除确认带名称占位）
    for (const source of [zh, en]) {
        assert.match(source, /confirmDelete: '[^']*\{name\}/)
    }
})
