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
    mcpToolName,
    needsAuthPolling,
    needsConvergePolling,
    POLL_INTERVAL_MS,
    stateTone,
    validateForm,
    type McpFormErrorKey,
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

async function openAuthorization(item: McpServerItem) {
    try {
        await apiPost(`/api/mcp/servers/${encodeURIComponent(item.id)}/oauth/start`)
        await loadServers(true)
    } catch {
        // ignore（可能已有授权 URL 在飞）
    }
    const latest = servers.value.find((s) => s.id === item.id)
    const url = latest?.authorizationUrl
    if (!url) {
        toast.error(t('mcp.authOpenFailed'))
        return
    }
    // Tauri WebView 内 window.open 不可靠——用仓内统一的 openExternalLink
    if (!openExternalLink(url)) toast.error(t('mcp.authOpenFailed'))
    startPolling(item.id)
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

// ─── 展示辅助 ────────────────────────────────────────────────────

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
    await Promise.all([loadServers(), loadAgents()])
    if (!alive) return // 挂载后已卸载：不起定时器
    for (const item of servers.value) {
        if (needsAuthPolling(item) || needsConvergePolling(item)) startPolling(item.id)
    }
})

onUnmounted(() => {
    alive = false
    stopAllPolling()
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
                    <div class="flex items-start justify-between gap-3">
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="toneClass[stateTone(item.state)]"
                                :title="stateLabel(item.state)" data-testid="mcp-state-dot" />
                            <ServerStackIcon class="w-5 h-5 opacity-70 shrink-0" />
                            <div class="min-w-0">
                                <div class="font-medium truncate">{{ item.displayName }}</div>
                                <div class="text-xs opacity-50 font-mono truncate">{{ item.id }}</div>
                            </div>
                        </div>
                        <div class="flex items-center gap-1">
                            <span class="badge badge-ghost badge-sm mr-1">{{ stateLabel(item.state) }}</span>
                            <label class="cursor-pointer label gap-1 mr-1" :title="t('mcp.enabledHint')">
                                <input type="checkbox" class="toggle toggle-success toggle-sm" :checked="item.enabled"
                                    @change="toggleEnabled(item)" />
                            </label>
                            <button class="btn btn-ghost btn-xs" :disabled="item.state === 'connected'"
                                :title="t('mcp.connect')" @click="connect(item)">
                                <LinkIcon class="w-4 h-4" />
                            </button>
                            <!-- OAuth 型服务器常驻授权入口（不再只在 auth_required 时出现） -->
                            <button v-if="isOAuthServer(item)" class="btn btn-ghost btn-xs" :title="t('mcp.authorize')"
                                data-testid="mcp-authorize" @click="openAuthorization(item)">
                                <KeyIcon class="w-4 h-4" />
                            </button>
                            <button class="btn btn-ghost btn-xs" :disabled="item.state !== 'connected'"
                                :title="t('mcp.disconnect')" @click="disconnect(item)">
                                <LinkSlashIcon class="w-4 h-4" />
                            </button>
                            <button class="btn btn-ghost btn-xs" :title="t('mcp.tools')" @click="openTools(item)">
                                <WrenchScrewdriverIcon class="w-4 h-4" />
                            </button>
                            <button class="btn btn-ghost btn-xs" :title="t('common.edit')" @click="openEdit(item)">
                                <PencilSquareIcon class="w-4 h-4" />
                            </button>
                            <button class="btn btn-ghost btn-xs text-error" :title="t('common.delete')"
                                @click="removeServer(item)">
                                <TrashIcon class="w-4 h-4" />
                            </button>
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
                        <span class="badge badge-outline badge-sm">
                            {{ t('mcp.toolCount', { n: item.toolCount }) }}
                        </span>
                    </div>

                    <div v-if="item.state === 'auth_required'" class="alert alert-warning py-2 text-xs">
                        <KeyIcon class="w-4 h-4" />
                        <span>{{ t('mcp.authRequired') }}</span>
                        <button class="btn btn-warning btn-xs" data-testid="mcp-oauth-open"
                            @click="openAuthorization(item)">
                            {{ t('mcp.openAuth') }}
                        </button>
                    </div>

                    <div v-if="item.lastError" class="alert alert-error py-2 text-xs" data-testid="mcp-last-error">
                        <ExclamationTriangleIcon class="w-4 h-4" />
                        <span class="break-all">{{ item.lastError }}</span>
                    </div>

                    <details v-if="item.stderrTail" class="text-xs opacity-60">
                        <summary class="cursor-pointer">{{ t('mcp.stderr') }}</summary>
                        <pre class="whitespace-pre-wrap break-all mt-1 max-h-40 overflow-auto">{{ item.stderrTail }}</pre>
                    </details>
                </div>
            </div>
        </div>


        <!-- 新增/编辑弹窗 -->
        <dialog class="modal" :class="{ 'modal-open': editing !== null }" data-testid="mcp-editor"
            @keydown.esc.prevent="closeEdit">
            <div class="modal-box w-full max-w-lg">
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

                        <div v-else-if="form.authMode === 'oauth'" class="alert text-xs opacity-80">
                            <span>{{ t('mcp.form.oauthHint') }}</span>
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
    </div>
</template>
