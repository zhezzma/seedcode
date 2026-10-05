<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useToast } from '../../../composables/useToast'

import { useModelsState } from '../../../composables/useModelsState'
import { AgentInfo, useAgentsState } from '../../../composables/useAgentsState'
import { useI18n } from 'vue-i18n'
import {
    FingerPrintIcon,
    ExclamationTriangleIcon,
    CpuChipIcon,
    ChevronUpIcon,
} from '@heroicons/vue/24/outline'
import ModelSelectMenuContent from '../../models/ModelSelectMenuContent.vue'
import WorkspaceBindDialog from '../../workspace/WorkspaceBindDialog.vue'
import { useWorkspaceTree } from '../../../composables/useWorkspaceTree'
import { useWorkspaceGit } from '../../../composables/useWorkspaceGit'
import { useAgentFiles } from '../../../composables/useAgentFiles'
import { useWorkspaceViewer } from '../../../composables/useWorkspaceViewer'
import { useWorkspacePanel } from '../../../composables/useWorkspacePanel'


// Props
const props = defineProps<{
    agent: AgentInfo
}>()

const emit = defineEmits<{
    (e: 'deleted'): void
}>()

const toast = useToast()
const agentsState = useAgentsState()
const modelsState = useModelsState()

const { t } = useI18n()

// Workspace rebind dialog
const showWorkspaceDialog = ref(false)
// 改绑 workspace 后强制失效 workspace store：ensureAgent 只认 agentId，
// 同 agent 改绑（W1→W2）是 no-op，旧 workspace 的树/git 缓存会一直活到手动刷新。
const wsTree = useWorkspaceTree()
const wsGit = useWorkspaceGit()
const wsAgentFiles = useAgentFiles()
const wsPanelStore = useWorkspacePanel()
const wsViewer = useWorkspaceViewer()
const onWorkspaceUpdated = async () => {
    await agentsState.loadAgents()
    // 仅清归属是该 agent 的（别的 agent 的数据本就不在缓存里，不用陪葬）。
    const id = props.agent?.id
    if (id) {
        // viewer 是全局单槽：还开着旧 workspace 的文件时，改绑后同相对路径会指向
        // 新 workspace 的另一个文件，保存会写错地方。dirty 时提示（buffer 内容
        // 随关闭丢弃，与 HomeView 切 agent 的处理一致）。
        if (wsViewer.current.value) {
            if (wsViewer.dirty.value) {
                toast.warning(t('workspace.discardedDirty', { path: wsViewer.dirty.value.path }))
            }
            wsViewer.close()
        }
        if (wsGit.currentAgentId === id) wsGit.reset()
        if (wsTree.currentAgentId === id) wsTree.reset()
        if (wsAgentFiles.currentAgentId === id) wsAgentFiles.reset()
        // 旧 workspace 里记住的仓库选择一并清除，避免 Git tab 对着不存在的仓库报错。
        wsPanelStore.clearRepoForAgent(id)
    }
    toast.success(t('workspaceBinding.rebindDone'))
}



// Current model binding — uses agent.defaultModel via updateAgent API
const currentModel = computed({
    get: () => {
        if (props.agent?.defaultProvider && props.agent?.defaultModel) {
            return `${props.agent.defaultProvider}/${props.agent.defaultModel}`
        }
        return ''
    },
    set: async (val: string) => {
        try {
            const [provider, ...rest] = val.split('/')
            const model = rest.join('/')
            await agentsState.updateAgent({
                agentId: props.agent.id,
                defaultModel: model,
                defaultProvider: provider
            })
        } catch (err: any) {
            toast.error(err.message || String(err))
        }
    }
})

// Top-level alias so Vue auto-unwraps in template
const availableModels = modelsState.availableModels

const isCurrentModelAvailable = computed(() => {
    const val = currentModel.value
    if (!val) return true
    for (const group of availableModels.value) {
        if (group.models.some((m: any) => `${group.provider}/${m.id}` === val)) return true
    }
    return false
})

const modelDropdownOpen = ref(false)
const modelDropdownRef = ref<HTMLElement | null>(null)
const modelTriggerRef = ref<HTMLElement | null>(null)
const modelDropdownStyle = ref<Record<string, string>>({})

const currentModelLabel = computed(() => {
    const val = currentModel.value
    if (!val) return t('agent.selectModel')

    for (const group of availableModels.value) {
        const matched = group.models.find((m: any) => `${group.provider}/${m.id}` === val)
        if (matched) return matched.name
    }

    return `${val} (${t('agent.unknownModel')})`
})

const updateModelDropdownPosition = () => {
    if (window.innerWidth >= 640) {
        modelDropdownStyle.value = {}
        return
    }

    const rect = modelTriggerRef.value?.getBoundingClientRect()
    if (!rect) return

    modelDropdownStyle.value = {
        bottom: `${window.innerHeight - rect.top + 8}px`
    }
}

const toggleModelDropdown = () => {
    modelDropdownOpen.value = !modelDropdownOpen.value
    if (modelDropdownOpen.value) {
        updateModelDropdownPosition()
    }
}

const handleAgentModelSelect = (modelId: string) => {
    modelDropdownOpen.value = false
    currentModel.value = modelId
}

const handleDocumentClick = (event: MouseEvent) => {
    const target = event.target as Node | null
    if (!modelDropdownOpen.value || !target) return
    if (!modelDropdownRef.value?.contains(target)) {
        modelDropdownOpen.value = false
    }
}

const handleViewportChange = () => {
    if (modelDropdownOpen.value) {
        updateModelDropdownPosition()
    }
}

onMounted(() => {
    document.addEventListener('click', handleDocumentClick)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
})

onBeforeUnmount(() => {
    document.removeEventListener('click', handleDocumentClick)
    window.removeEventListener('resize', handleViewportChange)
    window.removeEventListener('scroll', handleViewportChange, true)
})


const defaultThinkingLevel = computed({
    get: () => props.agent?.defaultThinkingLevel || 'off',
    set: async (val: string) => {
        try {
            await agentsState.updateAgent({
                agentId: props.agent.id,
                defaultThinkingLevel: val
            })
        } catch (err: any) {
            toast.error(err.message || String(err))
        }
    }
})

const steeringMode = computed({
    get: () => props.agent?.steeringMode || 'all',
    set: async (val: string) => {
        try {
            await agentsState.updateAgent({
                agentId: props.agent.id,
                steeringMode: val
            })
        } catch (err: any) {
            toast.error(err.message || String(err))
        }
    }
})

const followUpMode = computed({
    get: () => props.agent?.followUpMode || 'all',
    set: async (val: string) => {
        try {
            await agentsState.updateAgent({
                agentId: props.agent.id,
                followUpMode: val
            })
        } catch (err: any) {
            toast.error(err.message || String(err))
        }
    }
})

const compactionModal = ref<HTMLDialogElement | null>(null)
const compactionSettings = ref<{
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
}>({
    enabled: false,
    reserveTokens: 16384,
    keepRecentTokens: 20000
})

const openCompactionModal = () => {
    const c = props.agent?.compaction;
    let enabled = false;
    let reserveTokens = 16384;
    let keepRecentTokens = 20000;

    if (typeof c === 'boolean') {
        enabled = c;
    } else if (c && typeof c === 'object') {
        enabled = c.enabled ?? false;
        reserveTokens = c.reserveTokens ?? 16384;
        keepRecentTokens = c.keepRecentTokens ?? 20000;
    }

    compactionSettings.value = { enabled, reserveTokens, keepRecentTokens }
    compactionModal.value?.showModal()
}

const saveCompaction = async () => {
    try {
        await agentsState.updateAgent({
            agentId: props.agent.id,
            compaction: { ...compactionSettings.value }
        })
        toast.success(t('common.savedSuccess'))
        compactionModal.value?.close()
    } catch (err: any) {
        toast.error(err.message || String(err))
    }
}

const retryModal = ref<HTMLDialogElement | null>(null)
const retrySettings = ref<{
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
    maxAgentDelayMs: number;
}>({
    enabled: false,
    maxRetries: 3,
    baseDelayMs: 1000,
    maxAgentDelayMs: 60000
})

/** number input 清空时 v-model.number 会得到 ''，统一归一为 undefined（不写该字段） */
const toNumOrUndefined = (v: number | '' | undefined): number | undefined =>
    (v === undefined || v === '' || Number.isNaN(v)) ? undefined : v

const openRetryModal = () => {
    const r = props.agent?.retry;
    let enabled = false;
    let maxRetries = 3;
    let baseDelayMs = 1000;
    let maxAgentDelayMs = 60000;

    if (typeof r === 'number') {
        enabled = r > 0;
        maxRetries = r;
    } else if (r && typeof r === 'object') {
        enabled = r.enabled ?? false;
        maxRetries = r.maxRetries ?? 3;
        baseDelayMs = r.baseDelayMs ?? 1000;
        // pi 默认 60000（DEFAULT_MAX_AGENT_RETRY_DELAY_MS）；旧客户端写入的 maxDelayMs 是无效字段，不读
        maxAgentDelayMs = r.maxAgentDelayMs ?? 60000;
    }

    retrySettings.value = { enabled, maxRetries, baseDelayMs, maxAgentDelayMs }
    retryModal.value?.showModal()
}

const saveRetry = async () => {
    try {
        // 主字段归一：清空 = 省略字段（pi 默认生效），避免 v-model.number 的 '' 原样落盘
        const maxRetries = toNumOrUndefined(retrySettings.value.maxRetries)
        const baseDelayMs = toNumOrUndefined(retrySettings.value.baseDelayMs)
        const maxAgentDelayMs = toNumOrUndefined(retrySettings.value.maxAgentDelayMs)
        await agentsState.updateAgent({
            agentId: props.agent.id,
            retry: {
                enabled: retrySettings.value.enabled,
                ...(maxRetries !== undefined ? { maxRetries } : {}),
                ...(baseDelayMs !== undefined ? { baseDelayMs } : {}),
                ...(maxAgentDelayMs !== undefined ? { maxAgentDelayMs } : {})
            }
        })
        toast.success(t('common.savedSuccess'))
        retryModal.value?.close()
    } catch (err: any) {
        toast.error(err.message || String(err))
    }
}


// Delete Agent Logic
import { useRouter } from 'vue-router'
import { useConfirm } from '../../../composables/useConfirm'
import { useChatState } from '../../../composables/useChatState'

const router = useRouter()
const chatState = useChatState()
const { confirm } = useConfirm()
const isDeleting = ref(false)

const handleDeleteAgent = async () => {
    if (!await confirm(t('agent.deleteConfirm', { name: props.agent.name }))) {
        return
    }

    isDeleting.value = true
    try {
        const agentId = props.agent.id
        await agentsState.deleteAgent({ agentId, deleteFiles: true })

        // 如果删除的是当前选中的 agent，清空选择
        if (chatState.agentsSelectedId === agentId) {
            chatState.selectAgent('')
        }

        toast.success(t('agent.deleteSuccess'))

        // Redirect
        router.replace({ name: 'agents' })

    } catch (err: any) {
        console.error('Failed to delete agent:', err)
        toast.error(t('agent.deleteFailed', { error: String(err.message || err) }))
    } finally {
        isDeleting.value = false
    }
}
</script>

<template>
    <div>
        <div class="space-y-6 pb-20 md:pb-6">
            <div class="space-y-2">
                <h4 class="text-sm font-medium text-base-content/60 px-2 flex items-center gap-2">
                    <FingerPrintIcon class="w-4 h-4" />
                    {{ $t('agent.basicInfo') }}
                </h4>
                <div class="card bg-base-200 shadow-sm overflow-visible">
                    <ul class="divide-y divide-base-300">
                        <li class="flex items-center justify-between p-4 bg-base-200 gap-2">
                            <span class="font-medium text-base-content/90">{{ $t('agent.workspace') }}</span>
                            <div class="flex items-center gap-2 min-w-0">
                                <div class="font-mono text-xs bg-base-300 px-2 py-1 rounded text-base-content/70 truncate max-w-[160px] md:max-w-sm"
                                    :title="agent.workspaceDir">
                                    {{ agent.workspaceDir || '-' }}
                                </div>
                                <button class="btn btn-ghost btn-xs shrink-0"
                                    @click="showWorkspaceDialog = true">{{ $t('workspaceBinding.editBinding') }}</button>
                            </div>
                        </li>
                        <li class="flex items-center justify-between p-4 bg-base-200">
                            <span class="font-medium text-base-content/90">{{ $t('agent.agentDir') }}</span>
                            <div class="font-mono text-xs bg-base-300 px-2 py-1 rounded text-base-content/70 truncate max-w-[200px] md:max-w-md"
                                :title="agent.agentDir">
                                {{ agent.agentDir || '-' }}
                            </div>
                        </li>
                        <li class="flex items-center justify-between p-4 bg-base-200">
                            <span class="font-medium text-base-content/90">{{ $t('agent.mainModel') }}</span>

                            <div ref="modelDropdownRef" class="flex-1 max-w-[250px] flex flex-col items-end gap-1 relative">
                                <button ref="modelTriggerRef" @click.stop="toggleModelDropdown"
                                    class="btn btn-ghost btn-sm gap-2 font-normal rounded-full border border-base-content/20 hover:border-base-content/40 hover:bg-base-300 transition-all w-full justify-between"
                                    :title="$t('agent.selectModel')">
                                    <span class="flex items-center gap-2 min-w-0 flex-1">
                                        <CpuChipIcon class="h-4 w-4 shrink-0" />
                                        <span class="truncate">{{ currentModelLabel }}</span>
                                    </span>
                                    <ChevronUpIcon class="h-3 w-3 shrink-0 opacity-50 transition-transform"
                                        :class="{ 'rotate-180': modelDropdownOpen }" />
                                </button>

                                <div v-if="modelDropdownOpen" :style="modelDropdownStyle"
                                    class="fixed left-4 right-4 shadow-xl bg-base-100 rounded-box border border-base-300 z-[120] max-h-96 overflow-hidden flex flex-col sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[22rem] sm:max-w-[calc(100vw-2rem)]">
                                    <ModelSelectMenuContent
                                        :available-models="availableModels"
                                        :current-model="currentModel"
                                        :show-unknown-current="!isCurrentModelAvailable && !!currentModel"
                                        @select="handleAgentModelSelect" />
                                </div>
                            </div>
                        </li>
                        <li class="flex items-center justify-between p-4 bg-base-200">
                            <span class="font-medium text-base-content/90">{{ $t('chat.thinkingLevel') }}</span>
                            <div class="flex-1 max-w-[250px] flex flex-col items-end gap-1">
                                <select v-model="defaultThinkingLevel" class="select select-bordered select-sm w-full font-sans">
                                    <option value="off">{{ $t('chat.thinkingLevels.off') }}</option>
                                    <option value="minimal">{{ $t('chat.thinkingLevels.minimal') }}</option>
                                    <option value="low">{{ $t('chat.thinkingLevels.low') }}</option>
                                    <option value="medium">{{ $t('chat.thinkingLevels.medium') }}</option>
                                    <option value="high">{{ $t('chat.thinkingLevels.high') }}</option>
                                    <option value="xhigh">{{ $t('chat.thinkingLevels.xhigh') }}</option>
                                    <option value="max">{{ $t('chat.thinkingLevels.max') }}</option>
                                </select>
                            </div>
                        </li>
                        <li class="flex items-center justify-between p-4 bg-base-200">
                            <span class="font-medium text-base-content/90">{{ $t('agent.steeringMode') }}</span>
                            <div class="flex-1 max-w-[250px] flex flex-col items-end gap-1">
                                <select v-model="steeringMode" class="select select-bordered select-sm w-full font-sans">
                                    <option value="all">{{ $t('agent.modeAll') }}</option>
                                    <option value="one-at-a-time">{{ $t('agent.modeOneAtATime') }}</option>
                                </select>
                            </div>
                        </li>
                        <li class="flex items-center justify-between p-4 bg-base-200">
                            <span class="font-medium text-base-content/90">{{ $t('agent.followUpMode') }}</span>
                            <div class="flex-1 max-w-[250px] flex flex-col items-end gap-1">
                                <select v-model="followUpMode" class="select select-bordered select-sm w-full font-sans">
                                    <option value="all">{{ $t('agent.modeAll') }}</option>
                                    <option value="one-at-a-time">{{ $t('agent.modeOneAtATime') }}</option>
                                </select>
                            </div>
                        </li>
                        <li class="flex items-center justify-between p-4 bg-base-200">
                            <span class="font-medium text-base-content/90">{{ $t('agent.compactionSettings') }}</span>
                            <button class="btn btn-sm btn-outline font-sans" @click="openCompactionModal">{{ $t('common.settings') }}</button>
                        </li>
                        <li class="flex items-center justify-between p-4 bg-base-200">
                            <span class="font-medium text-base-content/90">{{ $t('agent.retrySettings') }}</span>
                            <button class="btn btn-sm btn-outline font-sans" @click="openRetryModal">{{ $t('common.settings') }}</button>
                        </li>
                    </ul>
                </div>
            </div>

            <dialog ref="compactionModal" class="modal">
                <div class="modal-box">
                    <h3 class="font-bold text-lg mb-2">{{ $t('agent.compactionSettings') }}</h3>
                    <p class="text-sm text-base-content/70 mb-4">{{ $t('agent.compactionSettingsDesc') }}</p>

                    <div class="form-control w-full mb-4">
                        <label class="label cursor-pointer justify-start gap-4">
                            <input type="checkbox" v-model="compactionSettings.enabled" class="toggle toggle-primary" />
                            <span class="label-text">{{ $t('agent.compactionEnabled') }}</span>
                        </label>
                    </div>

                    <div class="form-control w-full mb-4">
                        <label class="label">
                            <span class="label-text">{{ $t('agent.compactionReserveTokens') }}</span>
                        </label>
                        <input type="number" v-model.number="compactionSettings.reserveTokens"
                            class="input input-bordered w-full" :disabled="!compactionSettings.enabled" />
                    </div>

                    <div class="form-control w-full mb-6">
                        <label class="label">
                            <span class="label-text">{{ $t('agent.compactionKeepRecentTokens') }}</span>
                        </label>
                        <input type="number" v-model.number="compactionSettings.keepRecentTokens"
                            class="input input-bordered w-full" :disabled="!compactionSettings.enabled" />
                    </div>

                    <div class="modal-action mt-0">
                        <form method="dialog">
                            <button class="btn btn-ghost mr-2">{{ $t('common.cancel') }}</button>
                        </form>
                        <button class="btn btn-primary px-8" @click="saveCompaction">{{ $t('common.save') }}</button>
                    </div>
                </div>
                <form method="dialog" class="modal-backdrop">
                    <button>close</button>
                </form>
            </dialog>

            <dialog ref="retryModal" class="modal">
                <div class="modal-box">
                    <h3 class="font-bold text-lg mb-2">{{ $t('agent.retrySettings') }}</h3>
                    <p class="text-sm text-base-content/70 mb-4">{{ $t('agent.retrySettingsDesc') }}</p>

                    <div class="form-control w-full mb-4">
                        <label class="label cursor-pointer justify-start gap-4">
                            <input type="checkbox" v-model="retrySettings.enabled" class="toggle toggle-primary" />
                            <span class="label-text">{{ $t('agent.retryEnabled') }}</span>
                        </label>
                    </div>

                    <div class="form-control w-full mb-4">
                        <label class="label">
                            <span class="label-text">{{ $t('agent.retryMaxRetries') }}</span>
                        </label>
                        <input type="number" v-model.number="retrySettings.maxRetries"
                            class="input input-bordered w-full" :disabled="!retrySettings.enabled" />
                    </div>

                    <div class="form-control w-full mb-4">
                        <label class="label">
                            <span class="label-text">{{ $t('agent.retryBaseDelayMs') }}</span>
                        </label>
                        <input type="number" v-model.number="retrySettings.baseDelayMs"
                            class="input input-bordered w-full" :disabled="!retrySettings.enabled" />
                    </div>

                    <div class="form-control w-full mb-6">
                        <label class="label">
                            <span class="label-text">{{ $t('agent.retryMaxAgentDelayMs') }}</span>
                        </label>
                        <input type="number" v-model.number="retrySettings.maxAgentDelayMs"
                            class="input input-bordered w-full" :disabled="!retrySettings.enabled" />
                    </div>

                    <div class="modal-action mt-0">
                        <form method="dialog">
                            <button class="btn btn-ghost mr-2">{{ $t('common.cancel') }}</button>
                        </form>
                        <button class="btn btn-primary px-8" @click="saveRetry">{{ $t('common.save') }}</button>
                    </div>
                </div>
                <form method="dialog" class="modal-backdrop">
                    <button>close</button>
                </form>
            </dialog>

            <WorkspaceBindDialog :show="showWorkspaceDialog" :agent-id="agent.id"
                @close="showWorkspaceDialog = false" @updated="onWorkspaceUpdated" />

            <!-- Danger Zone -->
            <div class="space-y-2 pt-6 border-t border-base-300">
                <h4 class="text-sm font-medium text-error/80 px-2 flex items-center gap-2">
                    <ExclamationTriangleIcon class="w-4 h-4" />
                    {{ $t('agent.dangerZone') }}
                </h4>
                <div class="card bg-base-200 border border-error/20 shadow-sm overflow-hidden">
                    <div class="p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <div>
                            <h3 class="font-medium text-base-content">{{ $t('agent.deleteAgent') }}</h3>
                            <p class="text-sm text-base-content/60 mt-1">
                                {{ $t('agent.deleteAgentDesc') }}
                            </p>
                        </div>
                        <button class="btn btn-error btn-outline md:btn-wide" @click="handleDeleteAgent"
                            :disabled="isDeleting">
                            <span v-if="isDeleting" class="loading loading-spinner loading-sm"></span>
                            {{ isDeleting ? $t('agent.deleting') : $t('agent.deleteAgent') }}
                        </button>
                    </div>
                </div>
            </div>
        </div>


    </div>
</template>
