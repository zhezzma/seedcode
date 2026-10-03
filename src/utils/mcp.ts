/**
 * mcp.ts — MCP 管理页的纯函数与类型（无框架依赖，可单测）。
 *
 * 对应服务端 seedagent /api/mcp 契约（reply/fail 包裹 { ok, payload }，
 * api-client 已解包 payload）。注意：列表/工具接口的 payload 是对象
 * （{ servers } / { tools, state }），不是裸数组。
 */

export type McpTransportKind = 'stdio' | 'http'

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

export interface McpHttpTransport {
    type: 'http'
    url: string
    headers?: Record<string, string>
    auth?: { type: 'oauth' }
}

export type McpTransportConfig = McpStdioTransport | McpHttpTransport

export interface McpServerItem {
    id: string
    displayName: string
    enabled: boolean
    state: McpServerState
    lastError?: string
    serverInfo?: { name: string; version: string; title?: string }
    protocolVersion?: string
    toolCount: number
    toolNames: string[]
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
    agentsAll: boolean
    agents: string[]
    extraTransport: Record<string, unknown>
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 与服务端 mcpToolName 一致：把任意字符串清洗成名称片段。 */
export function sanitizeToolNamePart(part: string): string {
    return part.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

/** MCP 工具在 agent 工具目录中的真实名字（UI 展示用，须与服务端注册名一致）。 */
export function mcpToolName(serverId: string, toolName: string): string {
    return sanitizeToolNamePart(`mcp_${serverId}_${toolName}`)
}

/** UI 认识的传输键（之外的字段进 extraTransport 透传）。 */
const KNOWN_STDIO_KEYS = new Set(['type', 'command', 'args', 'cwd'])
const KNOWN_HTTP_KEYS = new Set(['type', 'url', 'headers', 'auth'])

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
    return {
        ...base,
        ...common,
        transportKind: 'http',
        url: item.transport.url,
        authMode,
        apiKeyHeader: firstKey,
        apiKeyValue: firstValue,
        extraHeaders,
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
        // OAuth 与静态 headers 互斥（服务端校验同样拒绝双写）
        transport = { type: 'http', url: form.url.trim(), auth: { type: 'oauth' as const } }
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

/** 切换鉴权方式后重算表单错误（离开 apiKey 时清掉其专属错误键）。 */
export function errorsForAuthMode(form: McpServerForm, previous: McpFormErrorKey[]): McpFormErrorKey[] {
    return form.authMode === 'apiKey' ? previous : previous.filter((key) => key !== 'apiKeyRequired')
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
