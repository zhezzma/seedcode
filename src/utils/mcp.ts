/**
 * mcp.ts — MCP 管理页的纯函数与类型（无框架依赖，可单测）。
 *
 * 对应服务端 seedagent /api/mcp 契约（reply/fail 包裹 { ok, payload }，
 * api-client 已解包 payload）。注意：列表/工具接口的 payload 是对象
 * （{ servers } / { tools, state }），不是裸数组。
 */

export type McpTransportKind = 'stdio' | 'http'

/**
 * 与服务端约定的 secret 脱敏掩码：列表/状态接口不回传真值（值为 ***），
 * 编辑回传后服务端按同键回退既有真值；前端仅用于识别掩码态，不做业务判断。
 */
export const SECRET_MASK = '***'

export type McpServerState =
    | 'disabled'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'auth_required'
    | 'error'

export interface McpStdioTransport {
    type: 'stdio'
    command: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    inheritEnv?: boolean
}

/** 与服务端 McpOAuthSettings 同形（auth 细化字段全可选）。 */
export interface McpOAuthSettingsWire {
    type: 'oauth'
    clientId?: string
    clientSecret?: string
    callbackPort?: number
    callbackUrl?: string
    callbackTimeoutMs?: number
    scope?: string
    clientName?: string
    clientRegistration?: 'dcr' | 'cimd'
    authServerMetadataUrl?: string
    /** Protected Resource Metadata URL（多资源服务器/WWW-Authenticate 挑战发现替代源）。 */
    resourceMetadataUrl?: string
    /** 跳过 RFC 9207 iss 校验（自签/非标准授权服务器调试用）。 */
    skipIssuerValidation?: boolean
}

export interface McpHttpTransport {
    type: 'http'
    url: string
    headers?: Record<string, string>
    auth?: McpOAuthSettingsWire
}

export type McpTransportConfig = McpStdioTransport | McpHttpTransport

/** 服务端能力位投影（statusSnapshot 的 capabilities 字段子集）。 */
export interface McpServerCapabilitiesWire {
    tools?: Record<string, unknown>
    resources?: { subscribe?: boolean; listChanged?: boolean }
    prompts?: { listChanged?: boolean }
    logging?: Record<string, unknown>
    completions?: Record<string, unknown>
}

export interface McpServerItem {
    id: string
    displayName: string
    enabled: boolean
    state: McpServerState
    lastError?: string
    serverInfo?: { name: string; version: string; title?: string }
    protocolVersion?: string
    /** 服务器自述使用说明（InitializeResult.instructions）。 */
    instructions?: string
    /** 服务器能力位投影。 */
    capabilities?: McpServerCapabilitiesWire
    toolCount: number
    toolNames: string[]
    /** 缓存的资源数量（resources/list）。 */
    resourceCount?: number
    /** 缓存的 prompt 数（prompts/list）。 */
    promptCount?: number
    authorizationUrl?: string
    oauthRedirectUrl?: string
    stderrTail?: string
    agents: string[] | '*'
    transport: McpTransportConfig
    updatedAt: string
}

/** 编辑弹窗表单模型。extraTransport 承载 UI 不认识的传输字段（env/inheritEnv/headers），
 *  避免「编辑保存静默丢失手写配置」——原样合回，见 formToPayload。 */
/** http 传输的鉴权方式：无 / 静态 API Key（Authorization 等 header）/ OAuth 2.1。 */
export type McpAuthMode = 'none' | 'apiKey' | 'oauth'

export interface McpHeaderPair {
    key: string
    value: string
}

export interface McpServerForm {
    id: string
    displayName: string
    enabled: boolean
    transportKind: McpTransportKind
    command: string
    argsText: string
    cwd: string
    url: string
    authMode: McpAuthMode
    apiKeyHeader: string
    apiKeyValue: string
    extraHeaders: McpHeaderPair[]
    /** OAuth 细化字段（覆盖服务端 McpOAuthSettings 全部可选项；空 = 不下发，用服务端缺省）。 */
    oauthClientId: string
    oauthClientSecret: string
    callbackPort: string
    callbackTimeoutMs: string
    callbackUrl: string
    oauthScope: string
    clientName: string
    clientRegistration: 'dcr' | 'cimd'
    authServerMetadataUrl: string
    /** Protected Resource Metadata URL（https 或 loopback http；空 = 不下发）。 */
    resourceMetadataUrl: string
    /** 跳过 RFC 9207 iss 校验（仅自签/非标准授权服务器调试）。 */
    skipIssuerValidation: boolean
    agentsAll: boolean
    agents: string[]
    extraTransport: Record<string, unknown>
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// ── MCP 工具注册名（与服务端上游 pi-mcp createMcpToolName 逐位一致）──────
// 1.5.2 升级：服务端改用上游 createMcpToolName（mcp__<server>__<tool>，
// 非 [A-Za-z0-9_] 一律清洗为 _（含 -），>64 字符或撞名加 sha256 前 8 位 hex
// 后缀）。此处同步复刻（含 vendored 同步 sha256——浏览器无 node:crypto，
// crypto.subtle 是异步而模板同步调用）；期望值由服务端上游生成钉进测试。

/** SHA-256（UTF-8 输入 → hex），标准 FIPS 180-4；与 node:crypto 逐位一致（测试对拍钉死）。 */
const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotr32(x: number, n: number): number {
    return ((x >>> n) | (x << (32 - n))) | 0
}

function sha256Hex(input: string): string {
    const data = new TextEncoder().encode(input)
    // 填充：msg || 0x80 || 零填充 || 8 字节大端 bit 长度，总长 64 字节对齐
    const totalLen = ((data.length + 9 + 63) >> 6) << 6
    const padded = new Uint8Array(totalLen)
    padded.set(data)
    padded[data.length] = 0x80
    const view = new DataView(padded.buffer)
    view.setUint32(totalLen - 8, Math.floor((data.length / 0x20000000)), false)
    view.setUint32(totalLen - 4, (data.length << 3) >>> 0, false)

    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    const w = new Int32Array(64)
    for (let off = 0; off < totalLen; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4, false)
        for (let i = 16; i < 64; i++) {
            const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)
            const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
        for (let i = 0; i < 64; i++) {
            const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
            const ch = (e & f) ^ (~e & g)
            const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) | 0
            const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
            const maj = (a & b) ^ (a & c) ^ (b & c)
            const t2 = (S0 + maj) | 0
            hh = g; g = f; f = e
            e = (d + t1) | 0
            d = c; c = b; b = a
            a = (t1 + t2) | 0
        }
        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0
    }
    return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

/** MCP 工具在 agent 工具目录中的真实名字（UI 展示用，与服务端注册名一致）：
 *  `mcp__<server>__<tool>` 清洗后 ≤64 且未被占用直用；否则截断 + `_` +
 *  sha256(`${server}\0${tool}`) 前 8 位 hex 后缀（上游 Codex 同款）。 */
export function createMcpToolName(
    serverId: string,
    toolName: string,
    isTaken: (name: string) => boolean = () => false,
): string {
    const name = `mcp__${serverId}__${toolName}`.replace(/[^A-Za-z0-9_]/g, '_')
    if (name.length <= 64 && !isTaken(name)) return name
    const hash = sha256Hex(`${serverId}\0${toolName}`).slice(0, 8)
    return `${name.slice(0, 64 - hash.length - 1)}_${hash}`
}

/** 一个 server 的工具名列表 → 注册名映射（工具抽屉展示用）。同 server 内撞名
 *  （如 a-b 与 a_b 清洗后同名）按服务端装配同序走 hash 后缀；跨 server 撞名
 *  取决于 agent 可见集（服务端装配时全局 taken），管理页不可知——展示用途足够。 */
export function mcpToolNames(serverId: string, toolNames: string[]): Map<string, string> {
    const taken = new Set<string>()
    const result = new Map<string, string>()
    for (const tool of toolNames) {
        const name = createMcpToolName(serverId, tool, (candidate) => taken.has(candidate))
        taken.add(name)
        result.set(tool, name)
    }
    return result
}

/** UI 认识的传输键（之外的字段进 extraTransport 透传）。 */
const KNOWN_STDIO_KEYS = new Set(['type', 'command', 'args', 'cwd'])
const KNOWN_HTTP_KEYS = new Set(['type', 'url', 'headers', 'auth'])

/** URL.hostname 对 IPv6 返回带方括号形态（[::1]）——归一后判定 loopback（与服务端 isLoopbackHostname 同规）。 */
function isLoopbackHostname(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/** OAuth 型 http 服务器（卡片常驻「授权」按钮的判定）。 */
export function isOAuthServer(item: McpServerItem): boolean {
    return item.transport.type === 'http' && item.transport.auth?.type === 'oauth'
}

export function emptyForm(): McpServerForm {
    return {
        id: '',
        displayName: '',
        enabled: true,
        transportKind: 'stdio',
        command: '',
        argsText: '',
        cwd: '',
        url: '',
        authMode: 'none',
        apiKeyHeader: 'Authorization',
        apiKeyValue: '',
        extraHeaders: [],
        oauthClientId: '',
        oauthClientSecret: '',
        callbackPort: '',
        callbackTimeoutMs: '',
        callbackUrl: '',
        oauthScope: '',
        clientName: '',
        clientRegistration: 'dcr',
        authServerMetadataUrl: '',
        resourceMetadataUrl: '',
        skipIssuerValidation: false,
        agentsAll: true,
        agents: [],
        extraTransport: {},
    }
}

export function formFromItem(item: McpServerItem): McpServerForm {
    const base = emptyForm()
    const common = {
        id: item.id,
        displayName: item.displayName,
        enabled: item.enabled,
        agentsAll: item.agents === '*',
        agents: item.agents === '*' ? [] : [...item.agents],
    }
    if (item.transport.type === 'stdio') {
        const extra: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(item.transport)) {
            if (!KNOWN_STDIO_KEYS.has(key)) extra[key] = value
        }
        return {
            ...base,
            ...common,
            transportKind: 'stdio',
            command: item.transport.command,
            argsText: (item.transport.args ?? []).join(' '),
            cwd: item.transport.cwd ?? '',
            extraTransport: extra,
        }
    }
    const extra: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(item.transport)) {
        if (!KNOWN_HTTP_KEYS.has(key)) extra[key] = value
    }
    // headers → 鉴权表单：有 auth 字段 = OAuth；有 headers = API Key（首个 header
    // 为主鉴权头，如 Authorization，其余进自定义列表）
    const headers = item.transport.headers ?? {}
    const entries = Object.entries(headers)
    const authMode: McpAuthMode = item.transport.auth?.type === 'oauth'
        ? 'oauth'
        : entries.length > 0 ? 'apiKey' : 'none'
    const [firstKey, firstValue] = entries[0] ?? ['Authorization', '']
    const extraHeaders: McpHeaderPair[] = entries.slice(1).map(([key, value]) => ({ key, value }))
    // auth 细化字段回填（clientSecret 回显服务端脱敏的 ***，不修改则原样回传、服务端按同键回退真值）
    const auth = item.transport.auth
    return {
        ...base,
        ...common,
        transportKind: 'http',
        url: item.transport.url,
        authMode,
        apiKeyHeader: firstKey,
        apiKeyValue: firstValue,
        extraHeaders,
        oauthClientId: auth?.clientId ?? '',
        oauthClientSecret: auth?.clientSecret ?? '',
        callbackPort: auth?.callbackPort !== undefined ? String(auth.callbackPort) : '',
        callbackTimeoutMs: auth?.callbackTimeoutMs !== undefined ? String(auth.callbackTimeoutMs) : '',
        callbackUrl: auth?.callbackUrl ?? '',
        oauthScope: auth?.scope ?? '',
        clientName: auth?.clientName ?? '',
        clientRegistration: auth?.clientRegistration ?? 'dcr',
        authServerMetadataUrl: auth?.authServerMetadataUrl ?? '',
        resourceMetadataUrl: auth?.resourceMetadataUrl ?? '',
        skipIssuerValidation: auth?.skipIssuerValidation === true,
        extraTransport: extra,
    }
}

/** 表单 → 服务端 wire 格式（extraTransport 原样合回，保护手写高级字段）。 */
export function formToPayload(form: McpServerForm): Record<string, unknown> {
    let transport: Record<string, unknown>
    if (form.transportKind === 'stdio') {
        transport = {
            type: 'stdio',
            command: form.command.trim(),
            ...(splitArgs(form.argsText).length > 0 ? { args: splitArgs(form.argsText) } : {}),
            ...(form.cwd.trim() !== '' ? { cwd: form.cwd.trim() } : {}),
        }
    } else if (form.authMode === 'oauth') {
        // OAuth 与静态 headers 互斥（服务端校验同样拒绝双写）；细化字段空值不下发（= 用服务端缺省），
        // dcr 是服务端缺省不下发；clientSecret 的 *** 掩码原样回传，服务端按同键回退真值
        const callbackPort = form.callbackPort.trim()
        const callbackTimeoutMs = form.callbackTimeoutMs.trim()
        const callbackUrl = form.callbackUrl.trim()
        const metadataUrl = form.authServerMetadataUrl.trim()
        const resourceUrl = form.resourceMetadataUrl.trim()
        transport = {
            type: 'http',
            url: form.url.trim(),
            auth: {
                type: 'oauth' as const,
                ...(form.oauthClientId.trim() !== '' ? { clientId: form.oauthClientId.trim() } : {}),
                ...(form.oauthClientSecret.trim() !== '' ? { clientSecret: form.oauthClientSecret.trim() } : {}),
                ...(callbackPort !== '' ? { callbackPort: Number(callbackPort) } : {}),
                ...(callbackTimeoutMs !== '' ? { callbackTimeoutMs: Number(callbackTimeoutMs) } : {}),
                ...(callbackUrl !== '' ? { callbackUrl } : {}),
                ...(form.oauthScope.trim() !== '' ? { scope: form.oauthScope.trim() } : {}),
                ...(form.clientName.trim() !== '' ? { clientName: form.clientName.trim() } : {}),
                ...(form.clientRegistration === 'cimd' ? { clientRegistration: 'cimd' as const } : {}),
                ...(metadataUrl !== '' ? { authServerMetadataUrl: metadataUrl } : {}),
                ...(resourceUrl !== '' ? { resourceMetadataUrl: resourceUrl } : {}),
                ...(form.skipIssuerValidation ? { skipIssuerValidation: true } : {}),
            },
        }
    } else {
        const headers: Record<string, string> = {}
        if (form.authMode === 'apiKey' && form.apiKeyValue.trim() !== '') {
            headers[form.apiKeyHeader.trim() || 'Authorization'] = form.apiKeyValue.trim()
        }
        for (const header of form.extraHeaders) {
            if (header.key.trim() !== '' && header.value.trim() !== '') {
                // 同名自定义 Header 不允许静默覆盖主鉴权头
                if (form.authMode === 'apiKey'
                    && header.key.trim().toLowerCase() === form.apiKeyHeader.trim().toLowerCase()) continue
                headers[header.key.trim()] = header.value.trim()
            }
        }
        transport = {
            type: 'http',
            url: form.url.trim(),
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
        }
    }
    return {
        id: form.id.trim(),
        displayName: form.displayName.trim(),
        enabled: form.enabled,
        transport: { ...form.extraTransport, ...transport },
        agents: form.agentsAll ? '*' : [...form.agents],
    }
}

/** 按 shell 风格切分 args（支持引号）；返回空数组表示无参数。 */
export function splitArgs(text: string): string[] {
    const args: string[] = []
    let current = ''
    let quote: '"' | "'" | undefined
    let has = false
    for (const char of text) {
        if (quote) {
            if (char === quote) quote = undefined
            else current += char
            continue
        }
        if (char === '"' || char === "'") {
            quote = char
            has = true
            continue
        }
        if (char === ' ' || char === '\t' || char === '\n') {
            if (has || current !== '') {
                args.push(current)
                current = ''
                has = false
            }
            continue
        }
        current += char
        has = true
    }
    if (has || current !== '') args.push(current)
    return args
}

export type McpFormErrorKey =
    | 'idRequired'
    | 'idPattern'
    | 'commandRequired'
    | 'urlRequired'
    | 'urlInvalid'
    | 'apiKeyRequired'
    | 'callbackPortInvalid'
    | 'callbackTimeoutInvalid'
    | 'callbackUrlInvalid'
    | 'callbackPortMismatch'
    | 'oauthSecretNeedsId'
    | 'cimdConflict'
    | 'cimdCallbackUrl'
    | 'authMetadataUrlInvalid'
    | 'resourceMetadataUrlInvalid'
    | 'agentsRequired'

/** 表单校验：返回全部错误 key（空数组 = 通过）。 */
export function validateForm(form: McpServerForm): McpFormErrorKey[] {
    const errors: McpFormErrorKey[] = []
    const id = form.id.trim()
    if (id === '') errors.push('idRequired')
    else if (!ID_PATTERN.test(id)) errors.push('idPattern')
    if (form.transportKind === 'stdio') {
        if (form.command.trim() === '') errors.push('commandRequired')
    } else {
        const url = form.url.trim()
        if (url === '') errors.push('urlRequired')
        else if (!URL.canParse(url)) errors.push('urlInvalid')
        if (form.authMode === 'apiKey' && form.apiKeyValue.trim() === '') errors.push('apiKeyRequired')
        if (form.authMode === 'oauth') {
            // 数值/URL 字段与后端 validateOAuthSettings 同界，前端提前拦（服务端仍是最终裁判）
            const port = form.callbackPort.trim()
            if (port !== '' && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
                errors.push('callbackPortInvalid')
            }
            const timeout = form.callbackTimeoutMs.trim()
            if (timeout !== '' && (!/^\d+$/.test(timeout) || Number(timeout) < 1000 || Number(timeout) > 3_600_000)) {
                errors.push('callbackTimeoutInvalid')
            }
            if (form.oauthClientSecret.trim() !== '' && form.oauthClientId.trim() === '') errors.push('oauthSecretNeedsId')
            const callbackUrl = form.callbackUrl.trim()
            if (callbackUrl !== '') {
                const parsed = URL.canParse(callbackUrl) ? new URL(callbackUrl) : undefined
                const host = parsed?.hostname ?? ''
                if (!parsed || parsed.protocol !== 'http:' || !isLoopbackHostname(host) || parsed.search || parsed.hash) {
                    errors.push('callbackUrlInvalid')
                } else {
                    // 数值比较镜像服务端（Number(url.port) !== callbackPort），前导零不误报
                    if (parsed.port && port !== '' && Number(parsed.port) !== Number(port)) errors.push('callbackPortMismatch')
                    if (
                        form.clientRegistration === 'cimd' &&
                        (host.replace(/^\[|\]$/g, '') === '::1' || parsed.pathname !== '/callback')
                    ) {
                        errors.push('cimdCallbackUrl')
                    }
                }
            }
            if (
                form.clientRegistration === 'cimd' &&
                (form.oauthClientId.trim() !== '' || form.clientName.trim() !== '')
            ) {
                errors.push('cimdConflict')
            }
            const metadataUrl = form.authServerMetadataUrl.trim()
            if (metadataUrl !== '') {
                const meta = URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined
                if (
                    !meta ||
                    !(meta.protocol === 'https:' || (meta.protocol === 'http:' && isLoopbackHostname(meta.hostname)))
                ) {
                    errors.push('authMetadataUrlInvalid')
                }
            }
            // 与 authServerMetadataUrl 同规则：https 或 loopback http（镜像服务端 validateOAuthSettings）
            const resourceUrl = form.resourceMetadataUrl.trim()
            if (resourceUrl !== '') {
                const res = URL.canParse(resourceUrl) ? new URL(resourceUrl) : undefined
                if (
                    !res ||
                    !(res.protocol === 'https:' || (res.protocol === 'http:' && isLoopbackHostname(res.hostname)))
                ) {
                    errors.push('resourceMetadataUrlInvalid')
                }
            }
        }
    }
    if (!form.agentsAll && form.agents.length === 0) errors.push('agentsRequired')
    return errors
}

/** 切换传输类型后重算表单错误（旧传输的错误键不应残留）。 */
export function errorsForTransportKind(form: McpServerForm, previous: McpFormErrorKey[]): McpFormErrorKey[] {
    const stale: McpFormErrorKey[] =
        form.transportKind === 'stdio' ? ['urlRequired', 'urlInvalid'] : ['commandRequired']
    return previous.filter((key) => !stale.includes(key))
}

/** OAuth 模式专属错误键（切到其他鉴权方式时清理）。 */
const OAUTH_ERROR_KEYS = new Set<McpFormErrorKey>([
    'callbackPortInvalid',
    'callbackTimeoutInvalid',
    'callbackUrlInvalid',
    'callbackPortMismatch',
    'oauthSecretNeedsId',
    'cimdConflict',
    'cimdCallbackUrl',
    'authMetadataUrlInvalid',
    'resourceMetadataUrlInvalid',
])

/** 切换鉴权方式后重算表单错误（离开旧模式时清掉其专属错误键）。 */
export function errorsForAuthMode(form: McpServerForm, previous: McpFormErrorKey[]): McpFormErrorKey[] {
    if (form.authMode === 'apiKey') return previous.filter((key) => !OAUTH_ERROR_KEYS.has(key))
    if (form.authMode === 'oauth') return previous.filter((key) => key !== 'apiKeyRequired')
    return previous.filter((key) => key !== 'apiKeyRequired' && !OAUTH_ERROR_KEYS.has(key))
}

/** 状态点颜色（UI 直接查表）。 */
export function stateTone(state: McpServerState): 'ok' | 'warn' | 'bad' | 'idle' {
    switch (state) {
        case 'connected':
            return 'ok'
        case 'connecting':
        case 'reconnecting':
            return 'warn'
        case 'auth_required':
            return 'warn'
        case 'error':
            return 'bad'
        default:
            return 'idle'
    }
}

/** OAuth 待授权时轮询的判定。 */
export function needsAuthPolling(item: McpServerItem): boolean {
    return item.state === 'auth_required'
}

/** 连接操作后仍需轮询收敛的状态（connecting/reconnecting 会自己走到终态）。 */
export function needsConvergePolling(item: McpServerItem): boolean {
    return item.state === 'connecting' || item.state === 'reconnecting'
}

export const POLL_INTERVAL_MS = 1500

/** RFC 5424 日志级别八枚举（与服务端 MCP_LOG_LEVELS 同源；日志级别选择器用）。 */
export const MCP_LOG_LEVELS: readonly string[] = [
    'debug',
    'info',
    'notice',
    'warning',
    'error',
    'critical',
    'alert',
    'emergency',
]

/** 服务器日志级别 → 文本色（错误系红色、警告系黄色、其余默认）。 */
export function serverLogTone(level: string): string {
    if (level === 'error' || level === 'critical' || level === 'alert' || level === 'emergency') return 'text-error'
    if (level === 'warning' || level === 'notice') return 'text-warning'
    return ''
}

/** stderr 日志行的分级结果（UI 据此着色）。 */
export type McpLogLevel = 'error' | 'warn' | 'info'

export interface McpLogLine {
    text: string
    level: McpLogLevel
}

// 关键词命中即分级；中文不受 \b 词边界影响，直接子串匹配。
// 注意顺序：先 error 后 warn（"warning: ... error ..." 场景以更严重者计）。
const LOG_LEVEL_PATTERNS: Array<{ level: McpLogLevel; re: RegExp }> = [
    { level: 'error', re: /error|failed|failure|fatal|exception|失败|错误|异常/i },
    { level: 'warn', re: /warn|警告/i },
]

/**
 * 把 stderr 尾部原始文本按行分级。stderr 是进程的诊断通道，
 * 正常启动信息（如 token 刷新）也会混在里面——只有命中关键字的行才值得用户注意。
 */
export function parseLogLines(tail: string): McpLogLine[] {
    return tail.split('\n').map((text) => {
        let level: McpLogLevel = 'info'
        for (const { level: l, re } of LOG_LEVEL_PATTERNS) {
            if (re.test(text)) {
                level = l
                break
            }
        }
        return { text, level }
    })
}

/** 行分级 → tailwind 类（UI 直接查表，与 stateTone 同风格）。 */
export function logLineClass(level: McpLogLevel): string {
    switch (level) {
        case 'error':
            return 'text-error'
        case 'warn':
            return 'text-warning'
        default:
            return 'opacity-70'
    }
}
