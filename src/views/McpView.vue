<script setup lang="ts">
/**
 * McpView.vue — MCP 服务器管理页（侧边栏一级导航）。
 *
 * 契约：seedagent /api/mcp/servers*（api-client 已解包 { ok, payload }）。
 * 注意 payload 形状：列表是 { servers }、单点是 { server }、工具是 { tools, state }。
 * 状态：卡片列表（状态点/服务器信息/工具数/最后错误/stderr 尾部）、
 * 新增/编辑弹窗（stdio 与 http 表单切换 + agents 多选 + 未知传输字段透传）、
 * 连接/断开（乐观开关 + 失败回滚）、工具抽屉（请求代次保护）、
 * OAuth 授权引导（openExternalLink + 按服务器轮询单点状态直至收敛）。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
    ServerStackIcon,
    PlusIcon,
    ArrowPathIcon,
    TrashIcon,
    PencilSquareIcon,
    LinkIcon,
    LinkSlashIcon,
    WrenchScrewdriverIcon,
    XMarkIcon,
    ExclamationTriangleIcon,
    KeyIcon,
    InformationCircleIcon,
    SignalIcon,
    DocumentDuplicateIcon,
    ChatBubbleLeftRightIcon,
    ClipboardDocumentCheckIcon,
    EllipsisVerticalIcon,
} from '@heroicons/vue/24/outline'
import ViewHeader from '../components/ViewHeader.vue'
import { apiGet, apiPost, apiPut, apiDelete } from '../composables/api-client'
import { useToast } from '../composables/useToast'
import { useConfirm } from '../composables/useConfirm'
import { openExternalLink } from '../utils/external-link'
import {
    emptyForm,
    errorsForAuthMode,
    errorsForTransportKind,
    formFromItem,
    formToPayload,
    isOAuthServer,
    logLineClass,
    mcpToolName,
    MCP_LOG_LEVELS,
    needsAuthPolling,
    needsConvergePolling,
    parseLogLines,
    POLL_INTERVAL_MS,
    SECRET_MASK,
    serverLogTone,
    stateTone,
    validateForm,
    type McpFormErrorKey,
    type McpServerCapabilitiesWire,
    type McpServerForm,
    type McpServerItem,
    type McpServerState,
} from '../utils/mcp'

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirm()

const servers = ref<McpServerItem[]>([])
const agents = ref<Array<{ id: string; name: string }>>([])
const loading = ref(false)
const loadError = ref('')

// 弹窗：null=关闭；{ mode:'new' } 新增；{ mode:'edit', item } 编辑
const editing = ref<{ mode: 'new'; item?: undefined } | { mode: 'edit'; item: McpServerItem } | null>(null)
const form = ref<McpServerForm>(emptyForm())
const saving = ref(false)
const formErrors = ref<McpFormErrorKey[]>([])
/** 编辑令牌：请求在飞时用户取消并改开另一个，回来的响应不得关掉新弹窗。 */
let editToken = 0

// 工具抽屉
const toolsTarget = ref<McpServerItem | null>(null)
const tools = ref<Array<{ name: string; description?: string }>>([])
const toolsState = ref<McpServerState>('disabled')
const toolsLoading = ref(false)
/** 工具请求代次：后发者覆盖先到者。 */
let toolsSeq = 0

// ─── 资源抽屉 ────────────────────────────────────────────

interface McpResourceWire {
    uri: string
    name?: string
    description?: string
    mimeType?: string
}

interface McpResourceTemplateWire {
    uriTemplate: string
    name?: string
    description?: string
    mimeType?: string
}

const resourcesTarget = ref<McpServerItem | null>(null)
const resources = ref<McpResourceWire[]>([])
const resourceTemplates = ref<McpResourceTemplateWire[]>([])
const resourcesLoading = ref(false)
let resourcesSeq = 0
/** 已展开读取内容的资源（uri → 内容 JSON 文本）。 */
const resourceContents = ref<Record<string, string>>({})
/** 已订阅的资源 uri 集合（本地跟踪；不持久化）。 */
const subscribedUris = ref<Set<string>>(new Set())

// ─── 提示抽屉 ────────────────────────────────────────────

interface McpPromptArgWire {
    name: string
    description?: string
    required?: boolean
}

interface McpPromptWire {
    name: string
    description?: string
    arguments?: McpPromptArgWire[]
}

const promptsTarget = ref<McpServerItem | null>(null)
const prompts = ref<McpPromptWire[]>([])
const promptsLoading = ref(false)
let promptsSeq = 0
/** 当前展开参数表单的 prompt 名与已渲染结果（name → messages JSON）。 */
const promptArgInputs = ref<Record<string, Record<string, string>>>({})
const promptResults = ref<Record<string, string>>({})
/** 参数补全候选（`<promptName>/<argName>` → values）。 */
const completionCache = new Map<string, string[]>()

// ─── 服务器日志（notifications/message）─────────────────

interface McpServerLogWire {
    level: string
    logger?: string
    data: unknown
    timestamp: string
}

const serverLogs = ref<Record<string, McpServerLogWire[]>>({})
const pinging = ref<string | null>(null)
const invalidating = ref<string | null>(null)

// 按服务器 id 的轮询定时器（OAuth 授权中 / 连接收敛中）
const pollTimers = new Map<string, ReturnType<typeof setInterval>>()

const toneClass: Record<ReturnType<typeof stateTone>, string> = {
    ok: 'bg-success',
    warn: 'bg-warning',
    bad: 'bg-error',
    idle: 'bg-base-300',
}

const stateLabel = (state: McpServerState) => t(`mcp.state.${state}`)


// ─── 数据加载 ────────────────────────────────────────────────────

async function loadServers(silent = false) {
    if (!silent) {
        loading.value = true
        loadError.value = ''
    }
    try {
        // payload 是 { servers }，不是裸数组（服务端 reply(c, { servers })）
        const res = await apiGet<{ servers?: McpServerItem[] }>('/api/mcp/servers', silent)
        servers.value = Array.isArray(res?.servers) ? res.servers : []
    } catch {
        servers.value = []
        if (!silent) loadError.value = t('mcp.loadFailed')
    } finally {
        if (!silent) loading.value = false
    }
}

async function loadAgents() {
    try {
        const res = await apiGet<Array<{ id: string; name: string }>>('/api/agents', true)
        agents.value = Array.isArray(res) ? res : []
    } catch {
        agents.value = []
    }
}

// ─── 增删改 ──────────────────────────────────────────────────────

function openNew() {
    form.value = emptyForm()
    formErrors.value = []
    editing.value = { mode: 'new' }
}

function openEdit(item: McpServerItem) {
    form.value = formFromItem(item)
    formErrors.value = []
    editing.value = { mode: 'edit', item }
}

function closeEdit() {
    editing.value = null
}

function setTransportKind(kind: 'stdio' | 'http') {
    if (form.value.transportKind === kind) return
    form.value.transportKind = kind
    // 切换传输类型后清掉属于旧类型的错误键（url ↔ command）
    formErrors.value = errorsForTransportKind(form.value, formErrors.value)
}

function setAuthMode(mode: 'none' | 'apiKey' | 'oauth') {
    if (form.value.authMode === mode) return
    form.value.authMode = mode
    formErrors.value = errorsForAuthMode(form.value, formErrors.value)
}

async function submitForm() {
    const errors = validateForm(form.value)
    formErrors.value = errors
    if (errors.length > 0) return
    const token = ++editToken
    saving.value = true
    try {
        const payload = formToPayload(form.value)
        if (editing.value?.mode === 'new') {
            await apiPost('/api/mcp/servers', payload)
            toast.success(t('mcp.toast.created'))
        } else {
            await apiPut(`/api/mcp/servers/${encodeURIComponent(payload.id as string)}`, payload)
            toast.success(t('mcp.toast.updated'))
        }
        if (token !== editToken) return // 已被更新的编辑会话取代
        closeEdit()
        await loadServers(true)
        // 新连接可能走 OAuth/收敛：对非终态服务器起轮询
        for (const item of servers.value) {
            if (needsAuthPolling(item) || needsConvergePolling(item)) startPolling(item.id)
        }
    } catch {
        // api-client 已弹toast
    } finally {
        saving.value = false
    }
}

async function removeServer(item: McpServerItem) {
    if (!(await confirm(t('mcp.confirmDelete', { name: item.displayName })))) return
    try {
        await apiDelete(`/api/mcp/servers/${encodeURIComponent(item.id)}`)
        stopPolling(item.id)
        // 残留的粘贴输入可能含授权 code：随服务器一并清理
        delete callbackInputs.value[item.id]
        toast.success(t('mcp.toast.deleted'))
        await loadServers(true)
    } catch {
        // ignore
    }
}

async function toggleEnabled(item: McpServerItem) {
    const next = !item.enabled
    const previous = item.enabled
    item.enabled = next // 乐观更新，失败回滚（对齐 ExtensionsView）
    try {
        await apiPut(`/api/mcp/servers/${encodeURIComponent(item.id)}`, { enabled: next })
        await loadServers(true)
        // 后端对启停变更是异步 reconcile（断开/重连不阻塞 PUT 返回），PUT 后立刻拉到的
        // 快照可能还是旧状态（如刚禁用仍显示 connected）：立即单查一次 + 起轮询跟到收敛
        //（pollServerOnce 对非 converging/auth 状态会自行停表，不会多转）
        await pollServerOnce(item.id)
        startPolling(item.id)
    } catch {
        item.enabled = previous
    }
}

// ─── 连接控制 ────────────────────────────────────────────────────

async function connect(item: McpServerItem) {
    try {
        await apiPost(`/api/mcp/servers/${encodeURIComponent(item.id)}/connect`)
        await loadServers(true)
        // connecting/reconnecting 会自行收敛，auth_required 等用户授权——都需轮询兜底
        const latest = servers.value.find((s) => s.id === item.id)
        if (latest && (needsConvergePolling(latest) || needsAuthPolling(latest))) startPolling(item.id)
    } catch {
        // ignore
    }
}

async function disconnect(item: McpServerItem) {
    try {
        await apiPost(`/api/mcp/servers/${encodeURIComponent(item.id)}/disconnect`)
        stopPolling(item.id)
        await loadServers(true)
    } catch {
        // ignore
    }
}

// ─── 轮询（OAuth 授权 / 连接收敛）────────────────────────────────

function stopPolling(serverId: string) {
    const timer = pollTimers.get(serverId)
    if (timer !== undefined) {
        clearInterval(timer)
        pollTimers.delete(serverId)
    }
}

function stopAllPolling() {
    for (const serverId of [...pollTimers.keys()]) stopPolling(serverId)
}

async function pollServerOnce(serverId: string) {
    try {
        // 单点查询，避免全量列表覆盖用户正在操作的列表状态
        const res = await apiGet<{ server?: McpServerItem }>(
            `/api/mcp/servers/${encodeURIComponent(serverId)}`,
            true,
        )
        const item = res?.server
        if (!item) {
            stopPolling(serverId) // 服务器被删：停轮询并全量刷新
            await loadServers(true)
            return
        }
        const index = servers.value.findIndex((s) => s.id === serverId)
        if (index >= 0) servers.value[index] = item
        if (!needsAuthPolling(item) && !needsConvergePolling(item)) stopPolling(serverId)
        // 非收敛快照但定时器已被并发停掉（如补投成功后 stopPolling 与本在飞请求的竞态）：
        // 重启轮询自愈，否则卡片滞留假 auth_required 且无人再拉新状态
        else startPolling(serverId)
    } catch {
        stopPolling(serverId)
    }
}

function startPolling(serverId: string) {
    if (pollTimers.has(serverId)) return
    const timer = setInterval(() => void pollServerOnce(serverId), POLL_INTERVAL_MS)
    pollTimers.set(serverId, timer)
}

// ─── OAuth 授权引导 ──────────────────────────────────────────────

/** 正在拉起授权页的服务器 id：发现+动态注册需数秒公网往返，按钮转等待态，URL 就绪即自动打开。 */
const authStarting = ref<string | null>(null)

async function openAuthorization(item: McpServerItem) {
    if (authStarting.value !== null) return
    authStarting.value = item.id
    // 记录点击前的旧授权 URL：旧 URL 在新流程 resetOauth 完成前的快照里仍可见，
    // 须等「出现且不同于旧值」才开浏览器（旧链接的 state/端口已死，打开必败）
    const previousUrl = servers.value.find((s) => s.id === item.id)?.authorizationUrl
    try {
        // 服务端立即返回（授权流程后台推进，不再同步等待整个流程）
        await apiPost(`/api/mcp/servers/${encodeURIComponent(item.id)}/oauth/start`)
        await loadServers(true)
    } catch {
        // POST 失败（404/校验等）：api-client 已弹真实原因 toast，直接收场不空转
        authStarting.value = null
        return
    }
    // 轮询等本轮新授权 URL（发现+动态注册是串行公网请求，给足 30s）：出现即自动打开；
    // connected 说明免浏览器自动完成（如 token 刷新直接授权成功），提前收场；
    // 超时按「仍在后台准备」软提示（流程失败本身会投影到卡片错误区）
    const deadline = Date.now() + 30_000
    while (alive && Date.now() < deadline) {
        const latest = servers.value.find((s) => s.id === item.id)
        const url = latest?.authorizationUrl
        if (url && url !== previousUrl) {
            // Tauri WebView 内 window.open 不可靠——用仓内统一的 openExternalLink
            if (!openExternalLink(url)) toast.error(t('mcp.authOpenFailed'))
            startPolling(item.id)
            authStarting.value = null
            return
        }
        if (latest?.state === 'connected') {
            authStarting.value = null
            return
        }
        await pollServerOnce(item.id)
        await new Promise((resolve) => setTimeout(resolve, 800))
    }
    authStarting.value = null
    if (alive) toast.info(t('mcp.authOpenSlow'))
}

// ─── OAuth 回调手动补投（远程浏览器授权）────────────────────

/** 按服务器隔离的粘贴输入（同一页可能多台 auth_required）。 */
const callbackInputs = ref<Record<string, string>>({})
/** 提交中的服务器 id（同一时间只允许一次在飞，避免重复补投）。 */
const submittingCallback = ref<string | null>(null)

async function submitCallbackUrl(item: McpServerItem) {
    const url = (callbackInputs.value[item.id] ?? '').trim()
    if (url === '' || submittingCallback.value !== null) return
    submittingCallback.value = item.id
    try {
        // 后端对本地 callback server 重放粘贴 URL；返回补投后的服务器状态快照
        const res = await apiPost<{ server?: McpServerItem }>(
            `/api/mcp/servers/${encodeURIComponent(item.id)}/oauth/complete`,
            { url },
        )
        callbackInputs.value[item.id] = ''
        const server = res?.server
        if (server) {
            const index = servers.value.findIndex((s) => s.id === item.id)
            if (index >= 0) servers.value[index] = server
        }
        if (server?.state === 'connected') {
            stopPolling(item.id)
            toast.success(t('mcp.authCompleted'))
        } else {
            // token 交换/自动重连仍在途：轮询收敛
            startPolling(item.id)
            toast.info(t('mcp.authSubmitted'))
        }
    } catch {
        // api-client 已弹 toast（服务端返回的拒绝原因可直接阅读）
    } finally {
        submittingCallback.value = null
    }
}

// ─── 工具抽屉 ────────────────────────────────────────────────────

async function openTools(item: McpServerItem) {
    toolsTarget.value = item
    const seq = ++toolsSeq
    toolsLoading.value = true
    tools.value = []
    toolsState.value = 'disabled'
    try {
        const res = await apiGet<{ tools?: Array<{ name: string; description?: string }>; state?: McpServerState }>(
            `/api/mcp/servers/${encodeURIComponent(item.id)}/tools`,
            true,
        )
        if (seq !== toolsSeq) return // 已被更新的请求取代
        tools.value = res?.tools ?? []
        toolsState.value = res?.state ?? 'disabled'
    } catch {
        if (seq === toolsSeq) tools.value = []
    } finally {
        if (seq === toolsSeq) toolsLoading.value = false
    }
}

// ─── 资源抽屉 ────────────────────────────────────────────────────

async function openResources(item: McpServerItem) {
    resourcesTarget.value = item
    const seq = ++resourcesSeq
    resourcesLoading.value = true
    resources.value = []
    resourceTemplates.value = []
    resourceContents.value = {}
    try {
        const res = await apiGet<{ resources?: McpResourceWire[]; resourceTemplates?: McpResourceTemplateWire[] }>(
            `/api/mcp/servers/${encodeURIComponent(item.id)}/resources`,
            true,
        )
        if (seq !== resourcesSeq) return
        resources.value = res?.resources ?? []
        resourceTemplates.value = res?.resourceTemplates ?? []
    } catch {
        if (seq === resourcesSeq) resources.value = []
    } finally {
        if (seq === resourcesSeq) resourcesLoading.value = false
    }
}

/** 展开/折叠资源内容；折叠后再次点击可重读。 */
async function toggleResourceContent(uri: string) {
    if (resourceContents.value[uri] !== undefined) {
        const next = { ...resourceContents.value }
        delete next[uri]
        resourceContents.value = next
        return
    }
    const id = resourcesTarget.value?.id
    if (!id) return
    try {
        const res = await apiPost<{ contents?: unknown[] }>(
            `/api/mcp/servers/${encodeURIComponent(id)}/resources/read`,
            { uri },
        )
        resourceContents.value = { ...resourceContents.value, [uri]: JSON.stringify(res?.contents ?? [], null, 2) }
    } catch {
        // api-client 已弹 toast
    }
}

async function toggleSubscribe(uri: string) {
    const id = resourcesTarget.value?.id
    if (!id) return
    const subscribing = !subscribedUris.value.has(uri)
    try {
        await apiPost(
            `/api/mcp/servers/${encodeURIComponent(id)}/resources/${subscribing ? 'subscribe' : 'unsubscribe'}`,
            { uri },
        )
        const next = new Set(subscribedUris.value)
        if (subscribing) next.add(uri)
        else next.delete(uri)
        subscribedUris.value = next
    } catch {
        // api-client 已弹 toast
    }
}

// ─── 提示抽屉 ────────────────────────────────────────────────────

async function openPrompts(item: McpServerItem) {
    promptsTarget.value = item
    const seq = ++promptsSeq
    promptsLoading.value = true
    prompts.value = []
    promptArgInputs.value = {}
    promptResults.value = {}
    completionValues.value = {}
    completionCache.clear()
    try {
        const res = await apiGet<{ prompts?: McpPromptWire[] }>(
            `/api/mcp/servers/${encodeURIComponent(item.id)}/prompts`,
            true,
        )
        if (seq !== promptsSeq) return
        prompts.value = res?.prompts ?? []
        // 参数输入模型按 prompt 预建（嵌套 v-model 需要已存在的对象）
        const inputs: Record<string, Record<string, string>> = {}
        for (const prompt of prompts.value) {
            if (prompt.arguments?.length) inputs[prompt.name] = {}
        }
        promptArgInputs.value = inputs
    } catch {
        if (seq === promptsSeq) prompts.value = []
    } finally {
        if (seq === promptsSeq) promptsLoading.value = false
    }
}

async function getPromptInDrawer(prompt: McpPromptWire) {
    const id = promptsTarget.value?.id
    if (!id) return
    const args = promptArgInputs.value[prompt.name] ?? {}
    try {
        const res = await apiPost<{ messages?: unknown[] }>(
            `/api/mcp/servers/${encodeURIComponent(id)}/prompts/get`,
            { name: prompt.name, arguments: args },
        )
        promptResults.value = { ...promptResults.value, [prompt.name]: JSON.stringify(res?.messages ?? [], null, 2) }
    } catch {
        // api-client 已弹 toast
    }
}

/** 参数补全候选（`<promptName>/<argName>` → values）；模板经 on-input 事件异步填充，不能在模板里 await。 */
const completionValues = ref<Record<string, string[]>>({})

async function onPromptArgInput(prompt: McpPromptWire, argName: string) {
    const key = `${prompt.name}/${argName}`
    const cached = completionCache.get(key)
    if (cached) {
        completionValues.value = { ...completionValues.value, [key]: cached }
        return
    }
    const id = promptsTarget.value?.id
    if (!id) return
    try {
        const value = promptArgInputs.value[prompt.name]?.[argName] ?? ''
        const res = await apiPost<{ values?: string[] }>(
            `/api/mcp/servers/${encodeURIComponent(id)}/complete`,
            { ref: { type: 'ref/prompt', name: prompt.name }, argument: { name: argName, value } },
        )
        const values = res?.values ?? []
        completionCache.set(key, values)
        completionValues.value = { ...completionValues.value, [key]: values }
    } catch {
        // 不支持补全的服务器静默降级（参数输入仍可用）
    }
}

// ─── 服务器日志 / ping / 凭据失效 ─────────────────────────────

async function loadServerLogs(item: McpServerItem) {
    try {
        const res = await apiGet<{ messages?: McpServerLogWire[] }>(
            `/api/mcp/servers/${encodeURIComponent(item.id)}/logs`,
            true,
        )
        serverLogs.value = { ...serverLogs.value, [item.id]: res?.messages ?? [] }
    } catch {
        serverLogs.value = { ...serverLogs.value, [item.id]: [] }
    }
}

/** 展开 stderr/服务器日志区时拉取（logging 能力位存在时）。 */
async function onLogsToggle(item: McpServerItem, event: Event) {
    const details = event.target as HTMLDetailsElement
    if (details.open && item.capabilities?.logging) await loadServerLogs(item)
}

async function setServerLogLevel(item: McpServerItem, level: string) {
    try {
        await apiPost(`/api/mcp/servers/${encodeURIComponent(item.id)}/logging/set-level`, { level })
        toast.success(t('mcp.logsLevelSet', { level }))
        await loadServerLogs(item)
    } catch {
        // api-client 已弹 toast（非法枚举/不可用原因可直接阅读）
    }
}

async function pingServer(item: McpServerItem) {
    if (pinging.value !== null) return
    pinging.value = item.id
    try {
        await apiPost(`/api/mcp/servers/${encodeURIComponent(item.id)}/ping`)
        toast.success(t('mcp.pingOk'))
    } catch {
        // api-client 已弹 toast
    } finally {
        pinging.value = null
    }
}

async function invalidateCredentials(item: McpServerItem) {
    if (!(await confirm(t('mcp.confirmInvalidate', { name: item.displayName })))) return
    if (invalidating.value !== null) return
    invalidating.value = item.id
    try {
        await apiPost(`/api/mcp/servers/${encodeURIComponent(item.id)}/oauth/invalidate`, { kind: 'all' })
        toast.success(t('mcp.toast.invalidated'))
        await loadServers(true)
        const latest = servers.value.find((s) => s.id === item.id)
        if (latest && (needsConvergePolling(latest) || needsAuthPolling(latest))) startPolling(item.id)
    } catch {
        // api-client 已弹 toast（非 OAuth 型/未连接会返回明确原因）
    } finally {
        invalidating.value = null
    }
}

/** details 型 dropdown 点选菜单项后不会自动收起：先关菜单再执行动作。 */
function withMenuClose(event: Event, action: () => void) {
    const details = (event.currentTarget as HTMLElement | null)?.closest('details')
    if (details) details.open = false
    action()
}

/** 点击菜单外任意处自动收起所有打开的 ⋮ 溢出菜单（details 原生不响应外部点击）。 */
function closeOpenDropdowns(event: Event) {
    const target = event.target as Node | null
    document.querySelectorAll('details.dropdown[open]').forEach((details) => {
        if (!details.contains(target)) (details as HTMLDetailsElement).open = false
    })
}

// ─── 展示辅助 ────────────────────────────────────────────────────

/** 能力位 → 展示名列表（tools 隐含不展示；undefined 能力返回空）。 */
function capabilityChips(caps?: McpServerCapabilitiesWire): string[] {
    if (!caps) return []
    const chips: string[] = []
    if (caps.resources) chips.push('resources')
    if (caps.prompts) chips.push('prompts')
    if (caps.logging) chips.push('logging')
    if (caps.completions) chips.push('completions')
    return chips
}

function agentLabel(id: string): string {
    return agents.value.find((a) => a.id === id)?.name || id
}

function transportSummary(item: McpServerItem): string {
    if (item.transport.type === 'stdio') {
        const args = (item.transport.args ?? []).join(' ')
        return args ? `${item.transport.command} ${args}` : item.transport.command
    }
    return item.transport.url
}

let alive = true

onMounted(async () => {
    document.addEventListener('click', closeOpenDropdowns)
    await Promise.all([loadServers(), loadAgents()])
    if (!alive) return // 挂载后已卸载：不起定时器
    for (const item of servers.value) {
        if (needsAuthPolling(item) || needsConvergePolling(item)) startPolling(item.id)
    }
})

onUnmounted(() => {
    alive = false
    stopAllPolling()
    document.removeEventListener('click', closeOpenDropdowns)
})
</script>

<template>
    <div class="flex flex-col h-full">
        <ViewHeader :title="t('mcp.title')" is-main-page wc-pad>
            <template #actions>
                <button class="btn btn-primary btn-sm" data-testid="mcp-add" @click="openNew">
                    <PlusIcon class="w-4 h-4" />
                    {{ t('mcp.add') }}
                </button>
            </template>
        </ViewHeader>

        <div class="flex-1 overflow-y-auto p-4 space-y-3">
            <div v-if="loading" class="text-sm opacity-60">{{ t('common.loading') }}…</div>
            <div v-else-if="loadError" class="alert alert-error py-2 text-sm" data-testid="mcp-load-error">
                <ExclamationTriangleIcon class="w-4 h-4" />
                <span>{{ loadError }}</span>
                <button class="btn btn-ghost btn-xs" @click="loadServers()">{{ t('common.refresh') }}</button>
            </div>
            <div v-else-if="servers.length === 0" class="text-sm opacity-60">
                {{ t('mcp.empty') }}
            </div>

            <div v-for="item in servers" :key="item.id" class="card bg-base-100 border border-base-300 shadow-sm"
                :data-testid="`mcp-server-${item.id}`">
                <div class="card-body p-4 gap-3">
                    <!-- 卡片头：名称与操作行同一行排布（justify-between）；操作行放不下时
                         整组换到第二行（flex-wrap），行内不会出现单个孤按钮 -->
                    <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="toneClass[stateTone(item.state)]"
                                :title="stateLabel(item.state)" data-testid="mcp-state-dot" />
                            <ServerStackIcon class="w-5 h-5 opacity-70 shrink-0" />
                            <div class="min-w-0">
                                <div class="font-medium truncate">{{ item.displayName }}</div>
                                <div class="text-xs opacity-50 font-mono truncate">{{ item.id }}</div>
                            </div>
                        </div>
                        <!-- 操作行：编辑是唯一常驻文字按钮，低频/状态相关/破坏性操作收进 ⋮ 溢出菜单；
                             工具入口在下方「x 个工具」徽标上；整行放不下时随卡片头整体换行 -->
                        <div class="flex flex-wrap items-center gap-1 justify-end shrink-0">
                            <!-- 状态文字徽标仅 sm+ 屏显示：移动端卡片头部空间不足会把中文挤成竖排；状态由左侧彩色圆点承载 -->
                            <span class="badge badge-ghost badge-sm mr-1 hidden sm:inline-flex">{{ stateLabel(item.state) }}</span>
                            <label class="cursor-pointer label gap-1 mr-1" :title="t('mcp.enabledHint')">
                                <input type="checkbox" class="toggle toggle-success toggle-sm" :checked="item.enabled"
                                    @change="toggleEnabled(item)" />
                            </label>
                            <button class="btn btn-ghost btn-xs" :title="t('common.edit')" @click="openEdit(item)">
                                <PencilSquareIcon class="w-4 h-4" />
                                <span>{{ t('common.edit') }}</span>
                            </button>
                            <!-- 溢出菜单：details 型 dropdown 点选后不会自动收起，菜单项统一走 withMenuClose -->
                            <details class="dropdown dropdown-end" data-testid="mcp-more">
                                <summary class="btn btn-ghost btn-xs btn-circle list-none" :title="t('mcp.moreActions')">
                                    <EllipsisVerticalIcon class="w-4 h-4" />
                                </summary>
                                <ul class="dropdown-content menu z-20 mt-1 w-44 rounded-lg border border-base-300 bg-base-100 p-2 shadow-lg">
                                    <li v-if="item.enabled && item.state !== 'connected'">
                                        <button @click="withMenuClose($event, () => connect(item))">
                                            <LinkIcon class="w-4 h-4" />
                                            {{ t('mcp.connect') }}
                                        </button>
                                    </li>
                                    <!-- OAuth 型服务器常驻授权入口（不再只在 auth_required 时出现）；任一启动中全局禁用（单飞）；禁用时隐藏 -->
                                    <li v-if="item.enabled && isOAuthServer(item)">
                                        <button data-testid="mcp-authorize" :disabled="authStarting !== null"
                                            @click="withMenuClose($event, () => openAuthorization(item))">
                                            <span v-if="authStarting === item.id" class="loading loading-spinner loading-xs"></span>
                                            <KeyIcon v-else class="w-4 h-4" />
                                            {{ t('mcp.authorize') }}
                                        </button>
                                    </li>
                                    <li v-if="item.state === 'connected'">
                                        <button @click="withMenuClose($event, () => disconnect(item))">
                                            <LinkSlashIcon class="w-4 h-4" />
                                            {{ t('mcp.disconnect') }}
                                        </button>
                                    </li>
                                    <!-- 协议层探活 -->
                                    <li v-if="item.state === 'connected'">
                                        <button data-testid="mcp-ping" @click="withMenuClose($event, () => pingServer(item))">
                                            <span v-if="pinging === item.id" class="loading loading-spinner loading-xs"></span>
                                            <SignalIcon v-else class="w-4 h-4" />
                                            {{ t('mcp.ping') }}
                                        </button>
                                    </li>
                                    <!-- 资源浏览器（已连接 + 能力位门控）：未连接时打开只会空手而归 -->
                                    <li v-if="item.state === 'connected' && item.capabilities?.resources">
                                        <button data-testid="mcp-resources" @click="withMenuClose($event, () => openResources(item))">
                                            <DocumentDuplicateIcon class="w-4 h-4" />
                                            {{ t('mcp.resources') }}
                                        </button>
                                    </li>
                                    <!-- 提示模板（已连接 + 能力位门控） -->
                                    <li v-if="item.state === 'connected' && item.capabilities?.prompts">
                                        <button data-testid="mcp-prompts" @click="withMenuClose($event, () => openPrompts(item))">
                                            <ChatBubbleLeftRightIcon class="w-4 h-4" />
                                            {{ t('mcp.prompts') }}
                                        </button>
                                    </li>
                                    <!-- OAuth 凭据失效（仅 OAuth 型） -->
                                    <li v-if="isOAuthServer(item)">
                                        <button class="text-warning" data-testid="mcp-invalidate"
                                            :disabled="invalidating !== null"
                                            @click="withMenuClose($event, () => invalidateCredentials(item))">
                                            <span v-if="invalidating === item.id" class="loading loading-spinner loading-xs"></span>
                                            <ClipboardDocumentCheckIcon v-else class="w-4 h-4" />
                                            {{ t('mcp.invalidate') }}
                                        </button>
                                    </li>
                                    <li>
                                        <button class="text-error" @click="withMenuClose($event, () => removeServer(item))">
                                            <TrashIcon class="w-4 h-4" />
                                            {{ t('common.delete') }}
                                        </button>
                                    </li>
                                </ul>
                            </details>
                        </div>
                    </div>

                    <div class="text-xs opacity-70 font-mono break-all">{{ transportSummary(item) }}</div>

                    <div class="flex flex-wrap gap-2 text-xs">
                        <span class="badge badge-outline badge-sm">
                            {{ item.agents === '*' ? t('mcp.allAgents') : t('mcp.agentsCount', { n: item.agents.length }) }}
                        </span>
                        <span v-for="agentId in (item.agents === '*' ? [] : item.agents)" :key="agentId"
                            class="badge badge-ghost badge-sm">
                            {{ agentLabel(agentId) }}
                        </span>
                        <span v-if="item.serverInfo" class="badge badge-outline badge-sm">
                            {{ item.serverInfo.name }} {{ item.serverInfo.version }}
                        </span>
                        <span v-if="item.protocolVersion" class="badge badge-outline badge-sm">
                            MCP {{ item.protocolVersion }}
                        </span>
                        <!-- 工具入口：工具数徽标本身即按钮（扳手图标提示可点），点开工具抽屉 -->
                        <button class="badge badge-outline badge-sm gap-1 cursor-pointer hover:bg-base-200"
                            :title="t('mcp.tools')" data-testid="mcp-tools" @click="openTools(item)">
                            <WrenchScrewdriverIcon class="w-3 h-3" />
                            {{ t('mcp.toolCount', { n: item.toolCount }) }}
                        </button>
                        <span v-if="item.resourceCount !== undefined" class="badge badge-ghost badge-sm">
                            {{ t('mcp.resourceCount', { n: item.resourceCount }) }}
                        </span>
                        <span v-if="item.promptCount !== undefined" class="badge badge-ghost badge-sm">
                            {{ t('mcp.promptCount', { n: item.promptCount }) }}
                        </span>
                        <!-- 能力位徽标：tools 隐含不展示，其余按声明展示 -->
                        <span v-for="cap in capabilityChips(item.capabilities)" :key="cap"
                            class="badge badge-ghost badge-sm opacity-70">
                            {{ t(`mcp.cap.${cap}`) }}
                        </span>
                    </div>

                    <!-- 服务器自述说明（instructions）：可折叠，默认收起 -->
                    <details v-if="item.instructions" class="text-xs" data-testid="mcp-instructions">
                        <summary class="cursor-pointer flex items-center gap-1 opacity-70 hover:opacity-100">
                            <InformationCircleIcon class="w-4 h-4" />
                            <span>{{ t('mcp.instructions') }}</span>
                        </summary>
                        <div class="mt-1 max-h-40 overflow-auto rounded bg-base-200/60 p-2 whitespace-pre-wrap">{{ item.instructions }}</div>
                    </details>

                    <div v-if="item.state === 'auth_required'" class="space-y-2">
                        <div class="alert alert-warning py-2 text-xs">
                            <KeyIcon class="w-4 h-4" />
                            <span>{{ t('mcp.authRequired') }}</span>
                            <button class="btn btn-warning btn-xs" data-testid="mcp-oauth-open"
                                :disabled="authStarting !== null" @click="openAuthorization(item)">
                                <span v-if="authStarting === item.id" class="loading loading-spinner loading-xs"></span>
                                {{ authStarting === item.id ? t('mcp.authStarting') : t('mcp.openAuth') }}
                            </button>
                        </div>
                        <!-- 远程浏览器场景：127.0.0.1 回调在用户设备打不开——展示应到的回调地址，
                             粘贴浏览器最终跳转 URL 由后端代为重放。
                             注意不能用 daisyUI alert：它是 grid-auto-flow:column，多块内容会被排成竖排列 -->
                        <div v-if="item.oauthRedirectUrl" class="rounded-lg border border-warning/40 bg-warning/10 p-3 space-y-2 text-xs"
                            data-testid="mcp-oauth-paste">
                            <div class="break-all opacity-80">
                                {{ t('mcp.authRedirectHint') }} <span class="font-mono">{{ item.oauthRedirectUrl }}</span>
                            </div>
                            <div class="opacity-70">{{ t('mcp.authPasteHint') }}</div>
                            <div class="flex gap-2">
                                <input v-model="callbackInputs[item.id]" type="text"
                                    class="input input-bordered input-sm flex-1 min-w-0 font-mono text-xs"
                                    :placeholder="t('mcp.authPastePlaceholder')" data-testid="mcp-oauth-paste-input"
                                    @keyup.enter="submitCallbackUrl(item)" />
                                <button class="btn btn-warning btn-sm shrink-0" data-testid="mcp-oauth-paste-submit"
                                    :disabled="submittingCallback !== null || (callbackInputs[item.id] ?? '').trim() === ''"
                                    @click="submitCallbackUrl(item)">
                                    <span v-if="submittingCallback === item.id" class="loading loading-spinner loading-xs"></span>
                                    {{ t('mcp.authPasteSubmit') }}
                                </button>
                            </div>
                        </div>
                    </div>

                    <div v-if="item.lastError" class="alert py-2 text-xs"
                        :class="item.state === 'connected' ? 'alert-warning' : 'alert-error'"
                        data-testid="mcp-last-error">
                        <ExclamationTriangleIcon class="w-4 h-4" />
                        <span class="break-all">{{ item.lastError }}</span>
                    </div>

                    <details v-if="item.stderrTail || (item.capabilities?.logging && item.state === 'connected')"
                        class="text-xs" data-testid="mcp-stderr" @toggle="onLogsToggle(item, $event)">
                        <summary
                            class="cursor-pointer flex items-center gap-1 opacity-70 hover:opacity-100"
                            :title="t('mcp.logsHint')"
                        >
                            <InformationCircleIcon class="w-4 h-4" />
                            <span>{{ t('mcp.logs') }}</span>
                            <span v-if="item.stderrTail" class="badge badge-ghost badge-xs">{{ parseLogLines(item.stderrTail).length }}</span>
                            <span v-if="serverLogs[item.id]?.length" class="badge badge-ghost badge-xs">
                                {{ serverLogs[item.id].length }}
                            </span>
                        </summary>
                        <div class="mt-1 space-y-2">
                            <!-- 服务器协议日志（notifications/message；logging 能力）+ 级别控制 -->
                            <div v-if="item.capabilities?.logging && item.state === 'connected'" class="space-y-1">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <select class="select select-bordered select-xs"
                                        :aria-label="t('mcp.logsLevel')"
                                        @change="setServerLogLevel(item, ($event.target as HTMLSelectElement).value)">
                                        <option v-for="level in MCP_LOG_LEVELS" :key="level" :value="level">{{ level }}</option>
                                    </select>
                                    <span class="opacity-50">{{ t('mcp.logsLevelHint') }}</span>
                                </div>
                                <div v-if="serverLogs[item.id]?.length"
                                    class="max-h-40 overflow-auto rounded bg-base-200/60 p-2 font-mono leading-5">
                                    <div v-for="(message, i) in serverLogs[item.id]" :key="i"
                                        :class="serverLogTone(message.level)">
                                        <span class="opacity-50">[{{ message.timestamp }}] {{ message.level }}{{ message.logger ? `(${message.logger})` : '' }}</span>
                                        {{ typeof message.data === 'string' ? message.data : JSON.stringify(message.data) }}
                                    </div>
                                </div>
                                <div v-else class="opacity-50">{{ t('mcp.noServerLogs') }}</div>
                            </div>
                            <!-- stdio stderr 尾部 -->
                            <div v-if="item.stderrTail"
                                class="max-h-40 overflow-auto rounded bg-base-200/60 p-2 font-mono leading-5 whitespace-pre-wrap break-all">
                                <div
                                    v-for="(line, i) in parseLogLines(item.stderrTail)"
                                    :key="i"
                                    :class="logLineClass(line.level)"
                                >{{ line.text || ' ' }}</div>
                            </div>
                        </div>
                    </details>
                </div>
            </div>
        </div>


        <!-- 新增/编辑弹窗 -->
        <dialog class="modal" :class="{ 'modal-open': editing !== null }" data-testid="mcp-editor"
            @keydown.esc.prevent="closeEdit">
            <div class="modal-box w-full max-w-lg sm:max-w-2xl">
                <form method="dialog">
                    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" :title="t('common.close')"
                        @click="closeEdit">
                        <XMarkIcon class="w-4 h-4" />
                    </button>
                </form>
                <h3 class="font-bold text-lg mb-6 text-center">
                    {{ editing?.mode === 'edit' ? t('mcp.edit') : t('mcp.add') }}
                </h3>

                <div class="space-y-4 max-h-[70vh] overflow-y-auto px-1">
                    <div class="form-control w-full">
                        <label class="label">
                            <span class="label-text">{{ t('mcp.form.id') }} <span class="text-error">*</span></span>
                        </label>
                        <input v-model="form.id" type="text" :disabled="editing?.mode === 'edit'"
                            class="input input-bordered w-full font-mono" placeholder="filesystem"
                            data-testid="mcp-form-id" />
                        <label v-if="formErrors.includes('idRequired') || formErrors.includes('idPattern')"
                            class="label"><span class="label-text-alt text-error">{{ t('mcp.form.idError')
                            }}</span></label>
                        <label v-else class="label"><span class="label-text-alt opacity-50">{{ t('mcp.form.idHint')
                            }}</span></label>
                    </div>

                    <div class="form-control w-full">
                        <label class="label"><span class="label-text">{{ t('mcp.form.displayName') }}</span></label>
                        <input v-model="form.displayName" type="text" class="input input-bordered w-full"
                            :placeholder="t('mcp.form.displayNamePlaceholder')" />
                    </div>

                    <div class="form-control w-full">
                        <label class="label"><span class="label-text">{{ t('mcp.form.transport') }}</span></label>
                        <div class="join w-full">
                            <input class="join-item btn flex-1" type="radio" name="mcp-transport" aria-label="stdio"
                                :checked="form.transportKind === 'stdio'" @click="setTransportKind('stdio')" />
                            <input class="join-item btn flex-1" type="radio" name="mcp-transport"
                                aria-label="Streamable HTTP" :checked="form.transportKind === 'http'"
                                @click="setTransportKind('http')" />
                        </div>
                    </div>

                    <template v-if="form.transportKind === 'stdio'">
                        <div class="form-control w-full">
                            <label class="label">
                                <span class="label-text">{{ t('mcp.form.command') }} <span
                                        class="text-error">*</span></span>
                            </label>
                            <input v-model="form.command" type="text" class="input input-bordered w-full font-mono"
                                placeholder="npx" data-testid="mcp-form-command" />
                            <label v-if="formErrors.includes('commandRequired')" class="label">
                                <span class="label-text-alt text-error">{{ t('mcp.form.commandError') }}</span>
                            </label>
                        </div>
                        <div class="form-control w-full">
                            <label class="label"><span class="label-text">{{ t('mcp.form.args') }}</span></label>
                            <input v-model="form.argsText" type="text" class="input input-bordered w-full font-mono"
                                placeholder="-y @modelcontextprotocol/server-filesystem /workspace" />
                            <label class="label"><span class="label-text-alt opacity-50">{{ t('mcp.form.argsHint')
                                }}</span></label>
                        </div>
                        <div class="form-control w-full">
                            <label class="label">
                                <span class="label-text">{{ t('mcp.form.cwd') }}<span class="opacity-50">
                                    （{{ t('common.optional') }}）</span></span>
                            </label>
                            <input v-model="form.cwd" type="text" class="input input-bordered w-full font-mono" />
                        </div>
                    </template>

                    <template v-else>
                        <div class="form-control w-full">
                            <label class="label">
                                <span class="label-text">{{ t('mcp.form.url') }} <span
                                        class="text-error">*</span></span>
                            </label>
                            <input v-model="form.url" type="text" class="input input-bordered w-full font-mono"
                                placeholder="https://mcp.example.com/mcp" data-testid="mcp-form-url" />
                            <label v-if="formErrors.includes('urlRequired') || formErrors.includes('urlInvalid')"
                                class="label"><span class="label-text-alt text-error">{{ t('mcp.form.urlError')
                                }}</span></label>
                        </div>

                        <div class="form-control w-full">
                            <label class="label"><span class="label-text">{{ t('mcp.form.auth') }}</span></label>
                            <div class="join w-full">
                                <input class="join-item btn flex-1" type="radio" name="mcp-auth"
                                    :aria-label="t('mcp.form.authNone')" :checked="form.authMode === 'none'"
                                    @click="setAuthMode('none')" />
                                <input class="join-item btn flex-1" type="radio" name="mcp-auth"
                                    :aria-label="t('mcp.form.authApiKey')" :checked="form.authMode === 'apiKey'"
                                    @click="setAuthMode('apiKey')" />
                                <input class="join-item btn flex-1" type="radio" name="mcp-auth"
                                    :aria-label="t('mcp.form.authOAuth')" :checked="form.authMode === 'oauth'"
                                    @click="setAuthMode('oauth')" />
                            </div>
                        </div>

                        <template v-if="form.authMode === 'apiKey'">
                            <div class="flex gap-2">
                                <div class="form-control w-40">
                                    <label class="label"><span class="label-text">{{ t('mcp.form.apiKeyHeader')
                                        }}</span></label>
                                    <input v-model="form.apiKeyHeader" type="text"
                                        class="input input-bordered w-full font-mono" placeholder="Authorization" />
                                </div>
                                <div class="form-control flex-1">
                                    <label class="label">
                                        <span class="label-text">{{ t('mcp.form.apiKeyValue') }} <span
                                                class="text-error">*</span></span>
                                    </label>
                                    <input v-model="form.apiKeyValue" type="text"
                                        class="input input-bordered w-full font-mono" placeholder="Bearer YOUR_API_KEY"
                                        data-testid="mcp-form-api-key" />
                                </div>
                            </div>
                            <label v-if="form.apiKeyValue === SECRET_MASK || form.extraHeaders.some(h => h.value === SECRET_MASK)"
                                class="label">
                                <span class="label-text-alt text-base-content/60">{{ t('mcp.form.apiKeyMaskedHint') }}</span>
                            </label>
                            <label v-if="formErrors.includes('apiKeyRequired')" class="label">
                                <span class="label-text-alt text-error">{{ t('mcp.form.apiKeyRequired') }}</span>
                            </label>
                            <div class="form-control w-full">
                                <label class="label"><span class="label-text">{{ t('mcp.form.extraHeaders')
                                    }}</span></label>
                                <div v-for="(header, index) in form.extraHeaders" :key="index"
                                    class="flex gap-2 items-center mb-2">
                                    <input v-model="header.key" type="text"
                                        class="input input-bordered input-sm w-36 font-mono"
                                        placeholder="X-Custom-Header" />
                                    <input v-model="header.value" type="text"
                                        class="input input-bordered input-sm flex-1 font-mono" placeholder="value" />
                                    <button class="btn btn-ghost btn-sm" :title="t('common.delete')"
                                        @click="form.extraHeaders.splice(index, 1)">
                                        <XMarkIcon class="w-4 h-4" />
                                    </button>
                                </div>
                                <button class="btn btn-ghost btn-xs" @click="form.extraHeaders.push({ key: '', value: '' })">
                                    <PlusIcon class="w-3 h-3" />
                                    {{ t('mcp.form.addHeader') }}
                                </button>
                            </div>
                        </template>

                        <div v-else-if="form.authMode === 'oauth'" class="space-y-3 [&_.label]:whitespace-normal">
                            <div class="alert py-2 text-xs opacity-80">
                                <span>{{ t('mcp.form.oauthHint') }}</span>
                            </div>

                            <div class="flex flex-col sm:flex-row gap-2 items-start">
                                <div class="form-control w-full sm:flex-1">
                                    <label class="label"><span class="label-text">{{ t('mcp.form.oauthClientId')
                                        }}<span class="opacity-50">（{{ t('common.optional') }}）</span></span></label>
                                    <input v-model="form.oauthClientId" type="text"
                                        class="input input-bordered w-full font-mono" data-testid="mcp-form-oauth-client-id" />
                                </div>
                                <div class="form-control w-full sm:flex-1">
                                    <label class="label"><span class="label-text">{{ t('mcp.form.oauthClientSecret')
                                        }}<span class="opacity-50">（{{ t('common.optional') }}）</span></span></label>
                                    <input v-model="form.oauthClientSecret" type="text"
                                        class="input input-bordered w-full font-mono"
                                        data-testid="mcp-form-oauth-client-secret" />
                                    <label v-if="form.oauthClientSecret === SECRET_MASK" class="label">
                                        <span class="label-text-alt text-base-content/60">{{ t('mcp.form.oauthSecretMaskedHint')
                                            }}</span>
                                    </label>
                                    <label v-if="formErrors.includes('oauthSecretNeedsId')" class="label">
                                        <span class="label-text-alt text-error">{{ t('mcp.form.oauthSecretNeedsId') }}</span>
                                    </label>
                                </div>
                            </div>

                            <div class="flex flex-col sm:flex-row gap-2 items-start">
                                <div class="form-control w-full sm:flex-1">
                                    <label class="label"><span class="label-text">{{ t('mcp.form.callbackPort')
                                        }}<span class="opacity-50">（{{ t('common.optional') }}）</span></span></label>
                                    <input v-model="form.callbackPort" type="text" inputmode="numeric"
                                        class="input input-bordered w-full font-mono" data-testid="mcp-form-callback-port" />
                                    <label v-if="formErrors.includes('callbackPortInvalid')" class="label">
                                        <span class="label-text-alt text-error">{{ t('mcp.form.callbackPortInvalid') }}</span>
                                    </label>
                                </div>
                                <div class="form-control w-full sm:flex-1">
                                    <label class="label"><span class="label-text">{{ t('mcp.form.callbackTimeoutMs')
                                        }}<span class="opacity-50">（{{ t('common.optional') }}）</span></span></label>
                                    <input v-model="form.callbackTimeoutMs" type="text" inputmode="numeric"
                                        class="input input-bordered w-full font-mono" placeholder="900000"
                                        data-testid="mcp-form-callback-timeout" />
                                    <label v-if="formErrors.includes('callbackTimeoutInvalid')" class="label">
                                        <span class="label-text-alt text-error">{{ t('mcp.form.callbackTimeoutInvalid') }}</span>
                                    </label>
                                    <label v-else class="label"><span class="label-text-alt opacity-50">{{
                                        t('mcp.form.callbackTimeoutMsHint') }}</span></label>
                                </div>
                            </div>

                            <div class="form-control w-full">
                                <label class="label"><span class="label-text">{{ t('mcp.form.callbackUrl')
                                    }}<span class="opacity-50">（{{ t('common.optional') }}）</span></span></label>
                                <input v-model="form.callbackUrl" type="text" class="input input-bordered w-full font-mono"
                                    placeholder="http://127.0.0.1:18099/callback" data-testid="mcp-form-callback-url" />
                                <label v-if="formErrors.includes('callbackUrlInvalid')" class="label">
                                    <span class="label-text-alt text-error">{{ t('mcp.form.callbackUrlInvalid') }}</span>
                                </label>
                                <label v-else-if="formErrors.includes('callbackPortMismatch')" class="label">
                                    <span class="label-text-alt text-error">{{ t('mcp.form.callbackPortMismatch') }}</span>
                                </label>
                                <label v-else-if="formErrors.includes('cimdCallbackUrl')" class="label">
                                    <span class="label-text-alt text-error">{{ t('mcp.form.cimdCallbackUrl') }}</span>
                                </label>
                                <label v-else class="label"><span class="label-text-alt opacity-50">{{
                                    t('mcp.form.callbackUrlHint') }}</span></label>
                            </div>

                            <div class="form-control w-full">
                                <label class="label"><span class="label-text">{{ t('mcp.form.oauthScope')
                                    }}<span class="opacity-50">（{{ t('common.optional') }}）</span></span></label>
                                <input v-model="form.oauthScope" type="text" class="input input-bordered w-full font-mono"
                                    placeholder="read write" data-testid="mcp-form-oauth-scope" />
                                <label class="label"><span class="label-text-alt opacity-50">{{ t('mcp.form.oauthScopeHint')
                                    }}</span></label>
                            </div>

                            <div class="form-control w-full">
                                <label class="label"><span class="label-text">{{ t('mcp.form.clientName')
                                    }}<span class="opacity-50">（{{ t('common.optional') }}）</span></span></label>
                                <input v-model="form.clientName" type="text" class="input input-bordered w-full"
                                    data-testid="mcp-form-client-name" />
                                <label class="label"><span class="label-text-alt opacity-50">{{ t('mcp.form.clientNameHint')
                                    }}</span></label>
                            </div>
                            <div class="form-control w-full">
                                <label class="label"><span class="label-text">{{ t('mcp.form.clientRegistration')
                                    }}<span class="opacity-50">（{{ t('common.optional') }}）</span></span></label>
                                <div class="join w-full">
                                    <input class="join-item btn flex-1" type="radio" name="mcp-oauth-reg"
                                        :aria-label="t('mcp.form.clientRegistrationDcr')"
                                        :checked="form.clientRegistration === 'dcr'"
                                        @click="form.clientRegistration = 'dcr'" />
                                    <input class="join-item btn flex-1" type="radio" name="mcp-oauth-reg"
                                        :aria-label="t('mcp.form.clientRegistrationCimd')"
                                        :checked="form.clientRegistration === 'cimd'"
                                        @click="form.clientRegistration = 'cimd'" />
                                </div>
                                <label v-if="formErrors.includes('cimdConflict')" class="label">
                                    <span class="label-text-alt text-error">{{ t('mcp.form.cimdConflict') }}</span>
                                </label>
                                <label v-else class="label"><span class="label-text-alt opacity-50">{{
                                    t('mcp.form.cimdHint') }}</span></label>
                            </div>

                            <div class="form-control w-full">
                                <label class="label"><span class="label-text">{{ t('mcp.form.authServerMetadataUrl')
                                    }}<span class="opacity-50">（{{ t('common.optional') }}）</span></span></label>
                                <input v-model="form.authServerMetadataUrl" type="text"
                                    class="input input-bordered w-full font-mono" data-testid="mcp-form-auth-metadata-url" />
                                <label v-if="formErrors.includes('authMetadataUrlInvalid')" class="label">
                                    <span class="label-text-alt text-error">{{ t('mcp.form.authMetadataUrlInvalid') }}</span>
                                </label>
                                <label v-else class="label"><span class="label-text-alt opacity-50">{{
                                    t('mcp.form.authServerMetadataUrlHint') }}</span></label>
                            </div>

                            <div class="form-control w-full">
                                <label class="label"><span class="label-text">{{ t('mcp.form.resourceMetadataUrl') }}
                                    <span class="opacity-50">（{{ t('common.optional') }}）</span></span></label>
                                <input v-model="form.resourceMetadataUrl" type="text"
                                    class="input input-bordered w-full font-mono"
                                    placeholder="https://mcp.example.com/.well-known/oauth-protected-resource"
                                    data-testid="mcp-form-resource-metadata-url" />
                                <label v-if="formErrors.includes('resourceMetadataUrlInvalid')" class="label">
                                    <span class="label-text-alt text-error">{{ t('mcp.form.resourceMetadataUrlInvalid') }}</span>
                                </label>
                                <label v-else class="label"><span class="label-text-alt opacity-50">{{
                                    t('mcp.form.resourceMetadataUrlHint') }}</span></label>
                            </div>

                            <div class="form-control w-full">
                                <label class="label cursor-pointer justify-start gap-3">
                                    <span class="label-text">{{ t('mcp.form.skipIssuerValidation') }}</span>
                                    <input v-model="form.skipIssuerValidation" type="checkbox"
                                        class="toggle toggle-warning toggle-sm" data-testid="mcp-form-skip-issuer" />
                                </label>
                                <label class="label"><span class="label-text-alt opacity-50">{{
                                    t('mcp.form.skipIssuerValidationHint') }}</span></label>
                            </div>
                        </div>
                    </template>

                    <div class="form-control w-full">
                        <label class="label cursor-pointer justify-start gap-3">
                            <span class="label-text">{{ t('mcp.allAgents') }}</span>
                            <input v-model="form.agentsAll" type="checkbox" class="toggle toggle-primary toggle-sm" />
                            <span class="label-text-alt opacity-50">{{ form.agentsAll ? t('mcp.agentsAllHint') : t('mcp.agentsPickHint')
                                }}</span>
                        </label>
                        <div v-if="!form.agentsAll" class="flex flex-wrap gap-2 mt-1">
                            <label v-for="a in agents" :key="a.id"
                                class="label cursor-pointer gap-2 rounded-full border px-3 py-2"
                                :class="form.agents.includes(a.id) ? 'border-primary bg-primary/10' : 'border-base-300'">
                                <input type="checkbox" class="checkbox checkbox-xs" :value="a.id"
                                    v-model="form.agents" />
                                <span class="label-text text-xs">{{ a.name || a.id }}</span>
                            </label>
                            <span v-if="agents.length === 0" class="text-xs opacity-60 self-center">
                                {{ t('mcp.form.agentsEmptyHint') }}
                            </span>
                        </div>
                        <label v-if="formErrors.includes('agentsRequired')" class="label">
                            <span class="label-text-alt text-error">{{ t('mcp.form.agentsError') }}</span>
                        </label>
                    </div>

                    <div class="form-control w-full">
                        <label class="label cursor-pointer justify-start gap-3">
                            <span class="label-text">{{ t('mcp.form.enabled') }}</span>
                            <input v-model="form.enabled" type="checkbox" class="toggle toggle-primary toggle-sm" />
                        </label>
                    </div>

                    <div v-if="editing?.mode === 'edit' && Object.keys(form.extraTransport).length > 0"
                        class="alert py-2 text-xs opacity-70" data-testid="mcp-extra-fields">
                        <span>{{ t('mcp.form.extraFieldsHint') }}：{{ Object.keys(form.extraTransport).join(', ')
                            }}</span>
                    </div>
                </div>

                <div class="modal-action">
                    <button class="btn" @click="closeEdit">{{ t('common.cancel') }}</button>
                    <button class="btn btn-primary" :disabled="saving" data-testid="mcp-form-submit" @click="submitForm">
                        <span v-if="saving" class="loading loading-spinner loading-xs"></span>
                        {{ t('common.save') }}
                    </button>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop" @click="closeEdit">
                <button>close</button>
            </form>
        </dialog>

        <!-- 工具抽屉 -->
        <dialog class="modal" :class="{ 'modal-open': toolsTarget !== null }" data-testid="mcp-tools-modal"
            @keydown.esc.prevent="toolsTarget = null">
            <div class="modal-box w-full max-w-lg">
                <form method="dialog">
                    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" @click="toolsTarget = null">
                        <XMarkIcon class="w-4 h-4" />
                    </button>
                </form>
                <h3 class="font-bold text-lg mb-4 text-center">
                    {{ t('mcp.toolsOf', { name: toolsTarget?.displayName ?? '' }) }}
                </h3>
                <div v-if="toolsLoading" class="text-sm opacity-60">{{ t('common.loading') }}…</div>
                <div v-else-if="tools.length === 0" class="text-sm opacity-60 text-center py-4">
                    {{ toolsState === 'connected' ? t('mcp.noTools') : t('mcp.noToolsDisconnected') }}
                </div>
                <ul v-else class="space-y-2 max-h-[60vh] overflow-y-auto">
                    <li v-for="tool in tools" :key="tool.name" class="border border-base-300 rounded-lg p-3">
                        <div class="font-mono text-sm">{{ mcpToolName(toolsTarget?.id ?? '', tool.name) }}</div>
                        <div v-if="tool.description" class="text-xs opacity-60 mt-1">{{ tool.description }}</div>
                    </li>
                </ul>
                <div class="modal-action">
                    <button class="btn" @click="toolsTarget = null">{{ t('common.close') }}</button>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop" @click="toolsTarget = null">
                <button>close</button>
            </form>
        </dialog>

        <!-- 资源抽屉 -->
        <dialog class="modal" :class="{ 'modal-open': resourcesTarget !== null }" data-testid="mcp-resources-modal"
            @keydown.esc.prevent="resourcesTarget = null">
            <div class="modal-box w-full max-w-lg">
                <form method="dialog">
                    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" @click="resourcesTarget = null">
                        <XMarkIcon class="w-4 h-4" />
                    </button>
                </form>
                <h3 class="font-bold text-lg mb-4 text-center">
                    {{ t('mcp.resourcesOf', { name: resourcesTarget?.displayName ?? '' }) }}
                </h3>
                <div v-if="resourcesLoading" class="text-sm opacity-60">{{ t('common.loading') }}…</div>
                <div v-else-if="resources.length === 0 && resourceTemplates.length === 0" class="text-sm opacity-60 text-center py-4">
                    {{ t('mcp.noResources') }}
                </div>
                <ul v-else class="space-y-2 max-h-[60vh] overflow-y-auto">
                    <li v-for="resource in resources" :key="resource.uri"
                        class="border border-base-300 rounded-lg p-3 space-y-2" :data-testid="`mcp-resource-${resource.uri}`">
                        <div class="flex items-center justify-between gap-2">
                            <div class="min-w-0 cursor-pointer" @click="toggleResourceContent(resource.uri)">
                                <div class="font-mono text-sm break-all">{{ resource.name || resource.uri }}</div>
                                <div v-if="resource.name" class="text-xs opacity-50 font-mono break-all">{{ resource.uri }}</div>
                                <div v-if="resource.mimeType" class="text-xs opacity-50">{{ resource.mimeType }}</div>
                            </div>
                            <button class="btn btn-ghost btn-xs shrink-0" :title="t('mcp.subscribe')"
                                :class="subscribedUris.has(resource.uri) ? 'text-success' : ''"
                                @click="toggleSubscribe(resource.uri)">
                                <span v-if="subscribedUris.has(resource.uri)">{{ t('mcp.subscribed') }}</span>
                                <span v-else>{{ t('mcp.subscribe') }}</span>
                            </button>
                        </div>
                        <pre v-if="resourceContents[resource.uri] !== undefined"
                            class="max-h-48 overflow-auto rounded bg-base-200/60 p-2 font-mono text-xs whitespace-pre-wrap break-all">{{ resourceContents[resource.uri] }}</pre>
                    </li>
                    <li v-if="resourceTemplates.length > 0" class="pt-2 text-xs opacity-60">{{ t('mcp.resourceTemplates') }}</li>
                    <li v-for="template in resourceTemplates" :key="template.uriTemplate"
                        class="border border-dashed border-base-300 rounded-lg p-3">
                        <div class="font-mono text-sm break-all">{{ template.name || template.uriTemplate }}</div>
                        <div class="text-xs opacity-50 font-mono break-all">{{ template.uriTemplate }}</div>
                        <div v-if="template.description" class="text-xs opacity-60 mt-1">{{ template.description }}</div>
                    </li>
                </ul>
                <div class="modal-action">
                    <button class="btn" @click="resourcesTarget = null">{{ t('common.close') }}</button>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop" @click="resourcesTarget = null">
                <button>close</button>
            </form>
        </dialog>

        <!-- 提示抽屉 -->
        <dialog class="modal" :class="{ 'modal-open': promptsTarget !== null }" data-testid="mcp-prompts-modal"
            @keydown.esc.prevent="promptsTarget = null">
            <div class="modal-box w-full max-w-lg">
                <form method="dialog">
                    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" @click="promptsTarget = null">
                        <XMarkIcon class="w-4 h-4" />
                    </button>
                </form>
                <h3 class="font-bold text-lg mb-4 text-center">
                    {{ t('mcp.promptsOf', { name: promptsTarget?.displayName ?? '' }) }}
                </h3>
                <div v-if="promptsLoading" class="text-sm opacity-60">{{ t('common.loading') }}…</div>
                <div v-else-if="prompts.length === 0" class="text-sm opacity-60 text-center py-4">
                    {{ t('mcp.noPrompts') }}
                </div>
                <ul v-else class="space-y-2 max-h-[60vh] overflow-y-auto">
                    <li v-for="prompt in prompts" :key="prompt.name" class="border border-base-300 rounded-lg p-3 space-y-2"
                        :data-testid="`mcp-prompt-${prompt.name}`">
                        <div class="flex items-center justify-between gap-2">
                            <div class="min-w-0">
                                <div class="font-mono text-sm break-all">{{ prompt.name }}</div>
                                <div v-if="prompt.description" class="text-xs opacity-60 mt-0.5">{{ prompt.description }}</div>
                            </div>
                            <button class="btn btn-ghost btn-xs shrink-0" data-testid="mcp-prompt-get"
                                @click="getPromptInDrawer(prompt)">
                                {{ t('mcp.getPrompt') }}
                            </button>
                        </div>
                        <!-- 参数表单：按 prompt.arguments 声明展开；输入时经 completion/complete 拉候选（datalist） -->
                        <div v-if="prompt.arguments?.length" class="space-y-1">
                            <div v-for="arg in prompt.arguments" :key="arg.name" class="flex items-center gap-2">
                                <span class="text-xs opacity-70 w-20 sm:w-28 shrink-0 truncate" :title="arg.description">{{ arg.name }}</span>
                                <input v-model="promptArgInputs[prompt.name][arg.name]" type="text"
                                    class="input input-bordered input-sm flex-1 min-w-0 font-mono text-xs"
                                    :list="`mcp-completion-${prompt.name}-${arg.name}`"
                                    :placeholder="arg.description"
                                    @input="onPromptArgInput(prompt, arg.name)" />
                                <datalist :id="`mcp-completion-${prompt.name}-${arg.name}`">
                                    <option v-for="value in completionValues[`${prompt.name}/${arg.name}`] ?? []"
                                        :key="value" :value="value" />
                                </datalist>
                            </div>
                        </div>
                        <pre v-if="promptResults[prompt.name] !== undefined"
                            class="max-h-48 overflow-auto rounded bg-base-200/60 p-2 font-mono text-xs whitespace-pre-wrap break-all">{{ promptResults[prompt.name] }}</pre>
                    </li>
                </ul>
                <div class="modal-action">
                    <button class="btn" @click="promptsTarget = null">{{ t('common.close') }}</button>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop" @click="promptsTarget = null">
                <button>close</button>
            </form>
        </dialog>
    </div>
</template>
