<script setup lang="ts">
/**
 * HooksView.vue — 钩子管理页（侧边栏一级导航）。
 *
 * 结构与样式照抄 CronView：格子卡片展示已建钩子（整卡可点编辑），
 * 新建/编辑走 <dialog> modal 表单；不引入 CronView 没有的样式类。
 * 契约：seedagent /api/extensions/hooks*（api-client 已解包 { ok, payload }）。
 * payload 形状：列表是 { hooks }，不是裸数组（服务端 reply(c, { hooks })）。
 * 表单模型与校验/序列化全部复用 utils/hooks.ts 纯函数层：
 * hookFormToPayload 已内置服务器事件与 process 模式的强制规则，提交前须过 validateHookForm。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
    ComputerDesktopIcon,
    ChevronDownIcon,
    PlusIcon,
    XMarkIcon,
    PencilSquareIcon,
    ExclamationTriangleIcon,
} from '@heroicons/vue/24/outline'
import ViewHeader from '../components/ViewHeader.vue'
import { apiGet, apiPost, apiPut, apiDelete } from '../composables/api-client'
import { useToast } from '../composables/useToast'
import { useConfirm } from '../composables/useConfirm'
import {
    HOOK_EVENTS,
    emptyHookForm,
    hookFormFromItem,
    hookFormToPayload,
    validateHookForm,
    maxTimeoutFor,
    isToolEvent,
    isServerEvent,
    type HookEvent,
    type HookForm,
    type HookFormErrorKey,
    type HookItem,
} from '../utils/hooks'

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirm()

const hooks = ref<HookItem[]>([])
const agents = ref<Array<{ id: string; name: string }>>([])
const loading = ref(false)
const loadError = ref('')

// modal 编辑态：null=新建；其余=钩子 id（modal 打开时确定，不再走 URL 参数）
const editingId = ref<string | null>(null)
const form = ref<HookForm>(emptyHookForm())
const saving = ref(false)
const formErrors = ref<HookFormErrorKey[]>([])
/** 保存失败的 modal 内错误（具体原因 api-client 已弹 toast，这里给兜底文案） */
const saveError = ref('')

const modalTitle = computed(() => editingId.value ? t('hooks.editTitle') : t('hooks.newTitle'))

// ─── 数据加载 ────────────────────────────────────────────────────

async function loadHooks(silent = false) {
    if (!silent) {
        loading.value = true
        loadError.value = ''
    }
    try {
        // payload 是 { hooks }，不是裸数组（服务端 reply(c, { hooks })）
        const res = await apiGet<{ hooks?: HookItem[] }>('/api/extensions/hooks', silent)
        hooks.value = Array.isArray(res?.hooks) ? res.hooks : []
    } catch {
        hooks.value = []
        if (!silent) loadError.value = t('hooks.loadFailed')
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

// ─── Modal 开关（照 CronView 的 job_modal 模式）─────────────────

const openModal = () => {
    const modal = document.getElementById('hook_modal') as HTMLDialogElement | null
    modal?.showModal()
}

const closeModal = () => {
    const modal = document.getElementById('hook_modal') as HTMLDialogElement | null
    modal?.close()
}

function openNew() {
    editingId.value = null
    formErrors.value = []
    saveError.value = ''
    form.value = emptyHookForm()
    openModal()
}

function openEdit(item: HookItem) {
    editingId.value = item.id
    formErrors.value = []
    saveError.value = ''
    form.value = hookFormFromItem(item)
    openModal()
}

// ─── 表单联动 ────────────────────────────────────────────────────

function setEvent(event: HookEvent) {
    if (form.value.event === event) return
    form.value.event = event
    // 切到上限更小的事件（ServerStop 30）时旧超时值必报 timeoutInvalid：就地钳制到合法区间
    const max = maxTimeoutFor(event)
    if (form.value.timeoutSec > max) form.value.timeoutSec = max
    // 服务器事件 agents 由服务端强制 "*"：胶囊随之禁用并固定为全部 agent
    if (isServerEvent(event)) form.value.agentsAll = true
    formErrors.value = []
}

function setRunMode(mode: 'shell' | 'process') {
    if (form.value.runMode === mode) return
    form.value.runMode = mode
    formErrors.value = []
}

/** 实时校验：驱动「保存」按钮的禁用态（提交时同样以它为准） */
const validationErrors = computed(() => validateHookForm(form.value))

function errorText(key: HookFormErrorKey): string {
    switch (key) {
        case 'commandRequired':
            return t('hooks.errors.commandRequired')
        case 'timeoutInvalid':
            return t('hooks.errors.timeoutInvalid', { max: maxTimeoutFor(form.value.event) })
        case 'customInvalid':
            return t('hooks.errors.customInvalid')
        case 'agentsRequired':
            return t('hooks.errors.agentsRequired')
        case 'argsMax':
            return t('hooks.errors.argsMax')
        case 'customTooLarge':
            return t('hooks.errors.customTooLarge')
    }
}

/** 进程模式 + 批处理脚本后缀：提示改用 Shell 命令（.cmd/.bat 无法作为可执行文件直接 spawn） */
const isBatchCommand = computed(() => /\.(cmd|bat)$/i.test(form.value.command.trim()))

// 自定义字段占位示例（JSON 花括号与 vue-i18n 插值语法冲突，留在组件内不作文案）
const CUSTOM_PLACEHOLDER = '{\n  "customKey": "value"\n}'

// ─── 增删改 ──────────────────────────────────────────────────────

async function submitForm() {
    const errors = validateHookForm(form.value)
    formErrors.value = errors
    if (errors.length > 0) return
    saving.value = true
    saveError.value = ''
    try {
        const payload = hookFormToPayload(form.value)
        if (editingId.value === null) {
            await apiPost('/api/extensions/hooks', payload)
            toast.success(t('hooks.toast.created'))
        } else {
            await apiPut(`/api/extensions/hooks/${encodeURIComponent(editingId.value)}`, payload)
            toast.success(t('hooks.toast.updated'))
        }
        closeModal()
        await loadHooks(true)
    } catch {
        // api-client 已弹具体原因 toast；modal 内再给一条兜底错误
        saveError.value = t('hooks.saveFailed')
    } finally {
        saving.value = false
    }
}

async function removeHook(item: HookItem) {
    if (!(await confirm(t('hooks.confirmDelete')))) return
    try {
        await apiDelete(`/api/extensions/hooks/${encodeURIComponent(item.id)}`)
        toast.success(t('hooks.toast.deleted'))
        await loadHooks(true)
    } catch {
        // api-client 已弹 toast
    }
}

async function toggleEnabled(item: HookItem) {
    const previous = item.enabled
    item.enabled = !previous // 乐观更新，失败回滚
    try {
        // PUT 是全量更新：直接提交整条 HookConfig（开关是唯一变化）
        await apiPut(`/api/extensions/hooks/${encodeURIComponent(item.id)}`, item)
    } catch {
        item.enabled = previous
    }
}

// ─── 展示辅助 ────────────────────────────────────────────────────

/** 列表卡片标题：事件名 · 匹配器（空匹配器只显示事件名） */
function eventLine(item: HookItem): string {
    const matcher = item.matcher.trim()
    return matcher ? `${item.event} · ${matcher}` : item.event
}

/** 单行命令摘要：进程模式带上参数 */
function commandSummary(item: HookItem): string {
    if (item.runMode === 'process') return [item.command, ...(item.args ?? [])].join(' ')
    return item.command
}

function scopeLabel(item: HookItem): string {
    return item.agents === '*' ? t('hooks.scopeAll') : t('hooks.scopeCount', { n: item.agents.length })
}

function formatDate(ts: string | undefined): string {
    if (!ts) return ''
    return new Date(ts).toLocaleString()
}

/** 作用域胶囊文字：全部 agent / 单个 agent 名 / N 个 agent */
const scopePillLabel = computed(() => {
    if (form.value.agentsAll) return t('hooks.scopeAll')
    if (form.value.agents.length === 1) {
        const id = form.value.agents[0]
        return agents.value.find((a) => a.id === id)?.name || id
    }
    return t('hooks.scopeCount', { n: form.value.agents.length })
})

onMounted(() => {
    void loadHooks()
    void loadAgents()
})
</script>

<template>
    <div class="flex flex-col h-full">
        <ViewHeader :title="t('hooks.title')" is-main-page wc-pad>
            <template #actions>
                <div class="flex items-center gap-5">
                    <button @click="openNew" class="btn btn-ghost btn-circle btn-xs" :title="t('hooks.newTitle')"
                        data-testid="hooks-add">
                        <PlusIcon class="w-5 h-5" />
                    </button>
                </div>
            </template>
        </ViewHeader>

        <div class="flex-1 overflow-y-auto p-4 md:p-6">
            <div class="mx-auto space-y-6 w-full">
                <div>
                    <p v-if="loading" class="text-center py-8 opacity-50">
                        {{ t('common.loading') }}
                    </p>
                    <div v-else-if="loadError" class="alert alert-error py-2 text-sm" data-testid="hooks-load-error">
                        <ExclamationTriangleIcon class="w-4 h-4" />
                        <span>{{ loadError }}</span>
                        <button class="btn btn-ghost btn-xs" @click="loadHooks()">{{ t('common.refresh') }}</button>
                    </div>

                    <!-- 空状态（照抄 CronView）-->
                    <div v-else-if="hooks.length === 0" class="text-center py-12 opacity-50"
                        data-testid="hooks-empty">
                        <div class="text-6xl mb-4">🪝</div>
                        <p>{{ t('hooks.empty.title') }}</p>
                        <p class="text-sm mt-1">{{ t('hooks.empty.desc') }}</p>
                        <button @click="openNew" class="btn btn-link" data-testid="hooks-empty-create">
                            {{ t('hooks.empty.create') }}
                        </button>
                    </div>

                    <!-- 格子卡片（照抄 CronView：整卡可点编辑）-->
                    <div v-else class="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                        <div v-for="item in hooks" :key="item.id"
                            class="card bg-base-200 shadow-sm border border-base-300 cursor-pointer hover:border-primary transition-colors hover:shadow-md group h-full"
                            :data-testid="`hooks-item-${item.id}`" @click="openEdit(item)">
                            <div class="card-body p-3 sm:p-4">
                                <div class="flex items-center justify-between gap-2">
                                    <div class="flex items-center gap-2 min-w-0">
                                        <button @click.stop="toggleEnabled(item)"
                                            class="btn btn-xs btn-ghost tooltip tooltip-top"
                                            :class="item.enabled ? 'text-success' : 'text-base-content opacity-50'"
                                            :data-tip="item.enabled ? t('hooks.clickToDisable') : t('hooks.clickToEnable')"
                                            data-testid="hooks-toggle">
                                            <div class="w-2 h-2 rounded-full"
                                                :class="item.enabled ? 'bg-success' : 'bg-base-content/30'"></div>
                                        </button>
                                        <h4 class="font-bold text-base truncate">{{ eventLine(item) }}</h4>
                                    </div>
                                    <div class="flex items-center gap-1 shrink-0">
                                        <div class="badge badge-sm font-mono" :class="{
                                            'badge-neutral': item.runMode === 'shell',
                                            'badge-primary': item.runMode === 'process',
                                        }">
                                            {{ item.runMode === 'shell' ? t('hooks.runShell') : t('hooks.runProcess')
                                            }}
                                        </div>
                                    </div>
                                </div>

                                <div class="text-xs opacity-60 truncate pl-6 -mt-1">{{ commandSummary(item) }}</div>

                                <div class="flex flex-col gap-2 mt-3 text-xs opacity-70">
                                    <p class="truncate">
                                        <ComputerDesktopIcon class="w-3 h-3 inline -mt-0.5" />
                                        {{ scopeLabel(item) }} · {{ t('hooks.summary.timeout', { n: item.timeoutSec })
                                        }}<template v-if="item.background"> · {{ t('hooks.summary.background')
                                            }}</template>
                                    </p>

                                    <div class="flex items-center justify-between pt-2 border-t border-base-300">
                                        <span class="opacity-50">{{ formatDate(item.createdAt) }}</span>
                                        <div class="flex items-center gap-1">
                                            <button @click.stop="openEdit(item)" class="btn btn-xs btn-ghost"
                                                :title="t('common.edit')" data-testid="hooks-edit">
                                                <PencilSquareIcon class="w-3.5 h-3.5" />
                                            </button>
                                            <button @click.stop="removeHook(item)"
                                                class="btn btn-xs btn-ghost text-error/50 hover:text-error"
                                                :title="t('common.delete')" data-testid="hooks-delete">
                                                <XMarkIcon class="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- ─── 新建/编辑 modal（照抄 CronView 的 job_modal）────────── -->
        <dialog id="hook_modal" class="modal">
            <div class="modal-box w-full max-w-2xl">
                <form method="dialog">
                    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
                </form>
                <h3 class="font-bold text-lg mb-6 text-center">{{ modalTitle }}</h3>

                <div class="space-y-4 max-h-[70vh] overflow-y-auto px-1" data-testid="hooks-editor">
                    <!-- 事件 / 运行方式 -->
                    <div class="grid grid-cols-2 gap-3">
                        <div class="form-control w-full">
                            <label class="label"><span class="label-text">{{ t('hooks.event') }}</span></label>
                            <select :value="form.event" class="select select-bordered w-full"
                                data-testid="hooks-form-event"
                                @change="setEvent(($event.target as HTMLSelectElement).value as HookEvent)">
                                <option v-for="event in HOOK_EVENTS" :key="event" :value="event">{{ event }}</option>
                            </select>
                        </div>
                        <div class="form-control w-full">
                            <label class="label"><span class="label-text">{{ t('hooks.runMode') }}</span></label>
                            <select :value="form.runMode" class="select select-bordered w-full"
                                data-testid="hooks-form-runmode"
                                @change="setRunMode(($event.target as HTMLSelectElement).value as 'shell' | 'process')">
                                <option value="shell">{{ t('hooks.runShell') }}</option>
                                <option value="process">{{ t('hooks.runProcess') }}</option>
                            </select>
                        </div>
                    </div>
                    <!-- 事件触发时机说明（spec §3 表），ServerStop 额外两条警示 -->
                    <p class="text-xs opacity-60 -mt-2">{{ t(`hooks.eventDesc.${form.event}`) }}</p>
                    <div v-if="form.event === 'ServerStop'" class="text-xs space-y-0.5 -mt-2">
                        <p class="flex items-start gap-1 text-warning">
                            <ExclamationTriangleIcon class="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            <span>{{ t('hooks.serverStopWarn1') }}</span>
                        </p>
                        <p class="flex items-start gap-1 text-warning">
                            <ExclamationTriangleIcon class="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            <span>{{ t('hooks.serverStopWarn2') }}</span>
                        </p>
                    </div>

                    <!-- 作用域（唯一无 CronView 对应物的自绘控件：胶囊 + 下拉多选）-->
                    <div class="form-control w-full">
                        <label class="label"><span class="label-text">{{ t('hooks.scope') }}</span></label>
                        <!-- 服务器事件强制全部 agent：胶囊禁用（服务端对 agents: [] 会 400） -->
                        <div :class="isServerEvent(form.event) ? 'pointer-events-none opacity-50' : ''">
                            <details class="dropdown" data-testid="hooks-scope">
                                <summary class="btn btn-sm btn-outline list-none gap-1 font-normal"
                                    :title="t('hooks.scope')">
                                    <ComputerDesktopIcon class="w-4 h-4" />
                                    <span>{{ scopePillLabel }}</span>
                                    <ChevronDownIcon class="w-3 h-3 opacity-60" />
                                </summary>
                                <div
                                    class="dropdown-content z-20 mt-1 w-64 rounded-lg border border-base-300 bg-base-100 p-3 shadow-lg space-y-2">
                                    <label class="label cursor-pointer justify-start gap-3">
                                        <span class="label-text">{{ t('hooks.agentAllToggle') }}</span>
                                        <input v-model="form.agentsAll" type="checkbox"
                                            class="toggle toggle-primary" data-testid="hooks-scope-all" />
                                    </label>
                                    <div v-if="!form.agentsAll"
                                        class="space-y-1 max-h-48 overflow-y-auto border-t border-base-300 pt-2">
                                        <label v-for="a in agents" :key="a.id"
                                            class="label cursor-pointer justify-start gap-2 py-1">
                                            <input type="checkbox" class="checkbox checkbox-xs" :value="a.id"
                                                v-model="form.agents" />
                                            <span class="label-text text-xs">{{ a.name || a.id }}</span>
                                        </label>
                                        <p v-if="agents.length === 0" class="text-xs opacity-60">
                                            {{ t('hooks.agentsEmptyHint') }}
                                        </p>
                                    </div>
                                </div>
                            </details>
                        </div>
                    </div>

                    <!-- 匹配器 + 命令 -->
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div class="form-control w-full">
                            <label class="label"><span class="label-text">{{ t('hooks.matcher') }}</span></label>
                            <input v-model="form.matcher" type="text" maxlength="500"
                                :disabled="!isToolEvent(form.event)" class="input input-bordered w-full font-mono"
                                :placeholder="t('hooks.matcherPlaceholder')" data-testid="hooks-form-matcher" />
                            <label class="label">
                                <span class="label-text-alt opacity-60">
                                    {{ isToolEvent(form.event) ? t('hooks.matcherHint') : t('hooks.matcherDisabled') }}
                                </span>
                            </label>
                        </div>
                        <div class="form-control w-full">
                            <label class="label">
                                <span class="label-text">{{ t('hooks.command') }} <span
                                        class="text-error">*</span></span>
                            </label>
                            <input v-model="form.command" type="text" maxlength="2000"
                                class="input input-bordered w-full font-mono"
                                :placeholder="t('hooks.commandPlaceholder')" data-testid="hooks-form-command" />
                            <label v-if="form.runMode === 'process'" class="label">
                                <span class="label-text-alt" :class="isBatchCommand ? 'text-warning' : 'opacity-60'">
                                    {{ isBatchCommand ? t('hooks.processBatHint') : t('hooks.commandProcessHint') }}
                                </span>
                            </label>
                        </div>
                    </div>

                    <!-- 随运行方式切换：进程=参数；shell=Shell 选择器 + 后台开关 -->
                    <div v-if="form.runMode === 'process'" class="form-control w-full">
                        <label class="label"><span class="label-text">{{ t('hooks.args') }}</span></label>
                        <textarea v-model="form.argsText" class="textarea textarea-bordered h-24 w-full font-mono"
                            :placeholder="t('hooks.argsPlaceholder')" data-testid="hooks-form-args"></textarea>
                        <label class="label"><span class="label-text-alt opacity-60">{{ t('hooks.argsHint')
                        }}</span></label>
                    </div>
                    <div class="form-control w-full">
                        <label class="label"><span class="label-text">{{ t('hooks.shell') }}</span></label>
                        <input v-model="form.shell" type="text" class="input input-bordered w-full font-mono"
                            :placeholder="t('hooks.shellPlaceholder')" data-testid="hooks-form-shell" />
                    </div>
                    <div class="form-control w-full">
                        <!-- 服务器事件的后台行为被服务端强制（ServerStart true / ServerStop false）：
                             不显示开关，用说明文字替代（spec §5.7） -->
                        <template v-if="isServerEvent(form.event)">
                            <label class="label"><span class="label-text">{{ t('hooks.background') }}</span></label>
                            <label class="label">
                                <span class="label-text-alt opacity-60">
                                    {{ form.event === 'ServerStart' ? t('hooks.serverStartBg') :
                                        t('hooks.serverStopBg') }}
                                </span>
                            </label>
                        </template>
                        <template v-else>
                            <label class="label cursor-pointer justify-start gap-3">
                                <span class="label-text">{{ t('hooks.background') }}</span>
                                <input v-model="form.background" type="checkbox" class="toggle toggle-primary"
                                    data-testid="hooks-form-background" />
                            </label>
                            <label class="label">
                                <span class="label-text-alt opacity-60">{{ t('hooks.backgroundHint') }}</span>
                            </label>
                        </template>
                    </div>

                    <!-- 高级折叠区：默认展开 -->
                    <details class="collapse collapse-arrow" open data-testid="hooks-advanced">
                        <summary class="collapse-title text-sm font-medium">{{ t('hooks.advanced') }}</summary>
                        <div class="collapse-content">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div class="form-control w-full">
                                    <label class="label"><span class="label-text">{{ t('hooks.timeout') }}</span>
                                    </label>
                                    <input v-model.number="form.timeoutSec" type="number" min="1"
                                        :max="maxTimeoutFor(form.event)" class="input input-bordered w-full"
                                        data-testid="hooks-form-timeout" />
                                    <label class="label">
                                        <span class="label-text-alt opacity-60">{{ t('hooks.timeoutHint') }}</span>
                                    </label>
                                </div>
                                <div class="form-control w-full">
                                    <label class="label"><span class="label-text">{{ t('hooks.statusMessage')
                                        }}</span></label>
                                    <input v-model="form.statusMessage" type="text" maxlength="200"
                                        class="input input-bordered w-full"
                                        :placeholder="t('hooks.statusMessagePlaceholder')" />
                                    <label class="label">
                                        <span class="label-text-alt opacity-60">{{ t('hooks.statusMessageHint')
                                        }}</span>
                                    </label>
                                </div>
                                <div class="form-control w-full md:col-span-2">
                                    <label class="label"><span class="label-text">{{ t('hooks.custom') }}</span>
                                    </label>
                                    <textarea v-model="form.customText"
                                        class="textarea textarea-bordered h-24 w-full font-mono"
                                        :placeholder="CUSTOM_PLACEHOLDER" data-testid="hooks-form-custom"></textarea>
                                </div>
                            </div>
                        </div>
                    </details>

                    <!-- 校验错误 / 保存失败（modal 内 alert，类名照 CronView） -->
                    <div v-if="formErrors.length > 0" class="alert alert-error mt-4" data-testid="hooks-form-errors">
                        <ExclamationTriangleIcon class="w-4 h-4" />
                        <ul class="space-y-0.5 text-sm">
                            <li v-for="key in formErrors" :key="key">{{ errorText(key) }}</li>
                        </ul>
                    </div>
                    <div v-else-if="saveError" class="alert alert-error mt-4" data-testid="hooks-save-error">
                        <ExclamationTriangleIcon class="w-4 h-4" />
                        <span class="text-sm">{{ saveError }}</span>
                    </div>
                </div>

                <div class="modal-action">
                    <button class="btn" data-testid="hooks-cancel" @click="closeModal">
                        {{ t('common.cancel') }}
                    </button>
                    <button class="btn btn-primary" :disabled="validationErrors.length > 0 || saving"
                        data-testid="hooks-form-save" @click="submitForm">
                        <span v-if="saving" class="loading loading-spinner"></span>
                        {{ t('hooks.save') }}
                    </button>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
        </dialog>
    </div>
</template>
