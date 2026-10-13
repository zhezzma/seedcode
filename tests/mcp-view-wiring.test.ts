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

test('授权启动等待态：/oauth/start 立即返回 + authStarting 指示 + 新 URL 就绪自动打开', () => {
    // 等待态单飞（任一启动中全局禁用两处按钮）+ spinner/文案切换
    assert.match(view, /const authStarting = ref<string \| null>\(null\)/)
    assert.ok(view.split(':disabled="authStarting !== null"').length >= 3, 'both authorize buttons must disable while any starting')
    assert.match(view, /authStarting === item\.id \? t\('mcp\.authStarting'\) : t\('mcp\.openAuth'\)/)
    // 只开本轮新 URL（旧 URL 在新流程 resetOauth 前的快照里仍可见）；超时软提示而非报错
    assert.match(view, /const previousUrl = servers\.value\.find\(\(s\) => s\.id === item\.id\)\?\.authorizationUrl/)
    assert.match(view, /if \(url && url !== previousUrl\)/)
    assert.match(view, /const deadline = Date\.now\(\) \+ 30_000/)
    assert.match(view, /toast\.info\(t\('mcp\.authOpenSlow'\)\)/)
    // POST 失败即收场，不空转轮询
    assert.match(view, /api-client 已弹真实原因 toast，直接收场不空转/)
})

test('OAuth 回调手动补投：调 /oauth/complete 提交粘贴 URL，并展示应到的回调地址', () => {
    // 端点拼接过 encodeURIComponent，body 形状 { url }
    assert.match(
        view,
        /apiPost<\{ server\?: McpServerItem \}>\(\s*`\/api\/mcp\/servers\/\$\{encodeURIComponent\(item\.id\)\}\/oauth\/complete`,\s*\{ url \},/,
        'must POST { url } to /oauth/complete with encoded id',
    )
    // 粘贴面仅在拿到回调地址投影时出现（用户据此核对应等什么样的跳转地址）
    assert.match(view, /v-if="item\.oauthRedirectUrl"/)
    assert.match(view, /data-testid="mcp-oauth-paste-input"/)
    assert.match(view, /data-testid="mcp-oauth-paste-submit"/)
    // 提交按服务器隔离 + 全局单飞防重；成功后停止轮询，未收敛继续轮询（锚定 else 分支，
    // openAuthorization 里同款 startPolling 调用不应满足此断言）
    assert.match(view, /const callbackInputs = ref<Record<string, string>>\(\{\}\)/)
    assert.match(view, /const submittingCallback = ref<string \| null>\(null\)/)
    assert.match(view, /startPolling\(item\.id\)\s*\n\s*toast\.info\(t\('mcp\.authSubmitted'\)\)/)
    assert.match(view, /:disabled="submittingCallback !== null \|\|/)
})

test('MCP 编辑表单覆盖全部 OAuth 细化字段（McpOAuthSettings 全选项表单化）', () => {
    for (const testid of [
        'mcp-form-oauth-client-id',
        'mcp-form-oauth-client-secret',
        'mcp-form-callback-port',
        'mcp-form-callback-timeout',
        'mcp-form-callback-url',
        'mcp-form-oauth-scope',
        'mcp-form-client-name',
        'mcp-form-auth-metadata-url',
    ]) {
        assert.ok(view.includes(`data-testid="${testid}"`), `missing ${testid}`)
    }
    // dcr/cimd 单选在位
    assert.match(view, /form\.clientRegistration = 'cimd'/)
    assert.match(view, /form\.clientRegistration = 'dcr'/)
    // 序列化覆盖全部字段（不再是裸 { type: 'oauth' }，也不再依赖 extraAuth 透传）
    assert.match(utils, /clientRegistration: 'cimd' as const/)
    assert.match(utils, /\{ callbackUrl \}/)
    assert.doesNotMatch(utils, /extraAuth/)
})

test('OAuth 表单 i18n 键 zh/en 双侧齐全（细化字段与错误文案）', () => {
    for (const source of [zh, en]) {
        for (const key of [
            'oauthClientId:',
            'oauthClientSecret:',
            'oauthSecretMaskedHint:',
            'callbackPort:',
            'callbackPortInvalid:',
            'callbackTimeoutMs:',
            'callbackTimeoutInvalid:',
            'callbackTimeoutMsHint:',
            'callbackUrl:',
            'callbackUrlInvalid:',
            'callbackPortMismatch:',
            'callbackUrlHint:',
            'oauthScope:',
            'oauthScopeHint:',
            'clientName:',
            'clientNameHint:',
            'clientRegistration:',
            'clientRegistrationDcr:',
            'clientRegistrationCimd:',
            'cimdConflict:',
            'cimdCallbackUrl:',
            'cimdHint:',
            'authServerMetadataUrl:',
            'authMetadataUrlInvalid:',
            'authServerMetadataUrlHint:',
        ]) {
            assert.ok(source.includes(key), `missing mcp.form.${key}`)
        }
    }
})

test('手动补投 i18n 键 zh/en 双侧齐全', () => {
    for (const source of [zh, en]) {
        for (const key of [
            'authRedirectHint:',
            'authPasteHint:',
            'authPastePlaceholder:',
            'authPasteSubmit:',
            'authCompleted:',
            'authSubmitted:',
        ]) {
            assert.ok(source.includes(key), `missing mcp.${key}`)
        }
    }
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

test('编辑表单掩码提示：SECRET_MASK 从 utils/mcp 契约导入，掩码态提示双 locale 有文案', () => {
    // 掩码常量必须单点定义在 utils/mcp（wire 契约），视图内不得重复定义
    assert.match(utils, /export const SECRET_MASK = '\*\*\*'/)
    assert.match(view, /SECRET_MASK/)
    assert.doesNotMatch(view, /const SECRET_MASK/)
    assert.match(view, /v-if="form\.apiKeyValue === SECRET_MASK/)
    assert.match(zh, /apiKeyMaskedHint: '[^']*\*\*\*/)
    assert.match(en, /apiKeyMaskedHint: '[^']*\*\*\*/)
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
            'authStarting:',
            'authOpenSlow:',
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
