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

test('操作区 = 主行（开关/编辑）+ ⋮ 溢出菜单，工具入口在工具数徽标上', () => {
    // 卡片头：名称与操作同行（justify-between），放不下整行换行（不再窄屏强制纵排）
    assert.match(view, /flex flex-wrap items-center justify-between gap-x-2 gap-y-1/)
    // 其余收进溢出菜单（触屏上 icon-only 语义不可读）
    assert.match(view, /<EllipsisVerticalIcon class="w-4 h-4" \/>/)
    for (const key of ["t('mcp.connect')", "t('mcp.disconnect')", "t('mcp.ping')", "t('mcp.authorize')", "t('mcp.resources')", "t('mcp.prompts')", "t('mcp.invalidate')", "t('common.delete')"]) {
        assert.ok(view.includes(key), `溢出菜单缺少动作项：${key}`)
    }
    // 工具入口：工具数徽标本身是按钮（不再在主行平铺工具按钮）
    assert.match(view, /:title="t\('mcp\.tools'\)" data-testid="mcp-tools" @click="openTools\(item\)"/)
    assert.match(view, /<WrenchScrewdriverIcon class="w-3 h-3" \/>/)
    // 菜单项点选后必须走 withMenuClose 收起 details 型 dropdown
    assert.match(view, /function withMenuClose\(event: Event, action: \(\) => void\)/)
    assert.ok(view.split('withMenuClose($event,').length >= 7, 'all menu items must close the dropdown')
    // 点击菜单外任意处自动收起（details 原生不响应外部点击，需 document 级监听 + 卸载清理）
    assert.match(view, /function closeOpenDropdowns\(event: Event\)/)
    assert.match(view, /document\.querySelectorAll\('details\.dropdown\[open\]'\)/)
    assert.match(view, /document\.addEventListener\('click', closeOpenDropdowns\)/)
    assert.match(view, /document\.removeEventListener\('click', closeOpenDropdowns\)/)
})

test('菜单项按 enabled/state 门控（禁用不显示连接/授权，未连接不显示断开/探活/资源/提示）', () => {
    assert.match(view, /v-if="item\.enabled && item\.state !== 'connected'"/, 'connect hidden when disabled or connected')
    assert.match(view, /v-if="item\.enabled && isOAuthServer\(item\)"/, 'authorize hidden when disabled')
    assert.match(view, /v-if="item\.state === 'connected' && item\.capabilities\?\.resources"/, 'resources need connection')
    assert.match(view, /v-if="item\.state === 'connected' && item\.capabilities\?\.prompts"/, 'prompts need connection')
})

test('启停切换后轮询收敛（后端 reconcile 异步，PUT 后快照可能仍旧状态）', () => {
    assert.match(view, /await apiPut\(`\/api\/mcp\/servers\/\$\{encodeURIComponent\(item\.id\)\}`, \{ enabled: next \}\)/)
    assert.match(view, /await pollServerOnce\(item\.id\)\s*\n\s*startPolling\(item\.id\)/, 'toggle must poll until state settles')
})

test('溢出菜单 i18n 键 zh/en 双侧齐全', () => {
    assert.ok(zh.includes("moreActions: '更多操作'"))
    assert.ok(en.includes("moreActions: 'More actions'"))
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

test('lastError 分级展示：连接存活时降级为警告色（流断开类软错误不再红牌常驻）', () => {
    assert.match(view, /:class="item\.state === 'connected' \? 'alert-warning' : 'alert-error'"/)
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

test('资源/提示入口按能力位门控（且需已连接），不依赖缓存内容', () => {
    assert.match(view, /v-if="item\.state === 'connected' && item\.capabilities\?\.resources"/, 'resources button gated by connection + capability')
    assert.match(view, /v-if="item\.state === 'connected' && item\.capabilities\?\.prompts"/, 'prompts button gated by connection + capability')
})

test('新端点 wiring：resources/read、prompts/get、complete、logging/set-level、ping、oauth/invalidate', () => {
    assert.match(view, /\/resources\/read/)
    assert.match(view, /\/prompts\/get/)
    assert.match(view, /\/complete`/)
    assert.match(view, /\/logging\/set-level/)
    assert.match(view, /\/ping`/)
    assert.match(view, /\/oauth\/invalidate/)
})

test('OAuth 新字段表单存在（编辑不丢 resourceMetadataUrl/skipIssuerValidation）', () => {
    assert.match(view, /v-model="form\.resourceMetadataUrl"/)
    assert.match(view, /v-model="form\.skipIssuerValidation"/)
    assert.match(utils, /resourceMetadataUrl\?: string/)
    assert.match(utils, /skipIssuerValidation\?: boolean/)
})

test('凭据失效走 useConfirm 确认（不裸删）', () => {
    assert.match(view, /confirm\(t\('mcp\.confirmInvalidate'/)
})

test('日志级别选择器用 RFC 5424 八级枚举', () => {
    assert.match(view, /v-for="level in MCP_LOG_LEVELS"/)
    assert.match(utils, /MCP_LOG_LEVELS: readonly string\[\]/)
})

test('i18n：新键 zh/en 双语齐备', () => {
    for (const key of ['resourceMetadataUrl:', 'skipIssuerValidation:', 'resourceMetadataUrlInvalid:', 'logsLevel:', 'pingOk:', 'invalidate:', 'confirmInvalidate:']) {
        assert.ok(zh.includes(`            ${key.trim()}`) || zh.includes(key), `zh missing ${key}`)
        assert.ok(en.includes(key), `en missing ${key}`)
    }
})
