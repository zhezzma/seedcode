<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useSubAgents, SubagentConfig, SubagentThinkingLevel, SubagentSaveInput } from '@/composables/useSubAgents'
import { useAgentsState } from '@/composables/useAgentsState'
import { useModelsState } from '@/composables/useModelsState'
import { useSkillsState } from '@/composables/useSkillsState'
import { useToast } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import { PlusIcon, PencilIcon, TrashIcon, UserGroupIcon, CommandLineIcon, CpuChipIcon, ChevronUpIcon } from '@heroicons/vue/24/outline'
import ModelSelectMenuContent from '@/components/models/ModelSelectMenuContent.vue'
import { apiGet } from '@/composables/api-client'

const props = defineProps<{
    agent: any
}>()

const subAgentsState = useSubAgents()
const agentsState = useAgentsState()
const modelsState = useModelsState()
const skillsState = useSkillsState()
const toast = useToast()
const { t } = useI18n()

const loading = ref(false)
const showModal = ref(false)
const isSubmitting = ref(false)

const subagents = computed(() => subAgentsState.list)
const availableTools = computed(() => {
    if (!props.agent?.id) return []
    return (agentsState.agentTools[props.agent.id] || []).filter((t: any) => t.name !== 'subagent')
})
const availableSkills = ref<any[]>([])

// 可挂载扩展清单（GET /api/extensions 过滤 enabled：全局禁用的扩展不列出）。
// 列表是全局的，与 agent 无关；随 agent 切换一起刷新只为拿到新鲜数据。
const availableExtensions = ref<Array<{ id: string; name: string }>>([])
// 白名单勾选（勾选 = 挂载；与 tools/skills 的排除项语义不同）
const selectedExtensions = ref<string[]>([])

const availableModelGroups = modelsState.availableModels

const selectedModelValue = computed({
    get: () => {
        if (formData.value.provider && formData.value.model) {
            return `${formData.value.provider}/${formData.value.model}`
        }
        return formData.value.model || ''
    },
    set: (val: string) => {
        if (!val) {
            formData.value.provider = ''
            formData.value.model = ''
            return
        }
        if (val.includes('/')) {
            const [p, ...m] = val.split('/')
            formData.value.provider = p
            formData.value.model = m.join('/')
        } else {
            formData.value.model = val
            formData.value.provider = ''
        }
    }
})

const modelDropdownOpen = ref(false)
const modelTriggerRef = ref<HTMLElement | null>(null)
const modelPanelRef = ref<HTMLElement | null>(null)
const modelDropdownStyle = ref<Record<string, string>>({})

const updateModelDropdownPosition = () => {
    const rect = modelTriggerRef.value?.getBoundingClientRect()
    if (!rect) return

    const margin = 8
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow
    const maxHeight = Math.max(160, Math.min(320, (openUpward ? spaceAbove : spaceBelow) - margin * 2))

    const style: Record<string, string> = {
        position: 'fixed',
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        maxHeight: `${maxHeight}px`,
    }
    if (openUpward) {
        style.bottom = `${window.innerHeight - rect.top + 4}px`
    } else {
        style.top = `${rect.bottom + 4}px`
    }
    modelDropdownStyle.value = style
}

const toggleModelDropdown = () => {
    modelDropdownOpen.value = !modelDropdownOpen.value
    if (modelDropdownOpen.value) {
        nextTick(updateModelDropdownPosition)
    }
}

const isCurrentModelAvailable = computed(() => {
    const val = selectedModelValue.value
    if (!val) return false
    return availableModelGroups.value.some((group: any) =>
        group.models.some((m: any) => `${group.provider}/${m.id}` === val)
    )
})

const currentModelLabel = computed(() => {
    const val = selectedModelValue.value
    if (!val) return t('agent.form.modelPlaceholder') || 'Inherit Parent Model'

    for (const group of availableModelGroups.value) {
        const matched = group.models.find((m: any) => `${group.provider}/${m.id}` === val)
        if (matched) return matched.name
    }
    return `${val} (${t('agent.unknownModel')})`
})

const handleModelSelect = (modelId: string) => {
    selectedModelValue.value = modelId
    modelDropdownOpen.value = false
}

const clearModelSelection = () => {
    selectedModelValue.value = ''
    modelDropdownOpen.value = false
}

const handleModelDocumentClick = (event: MouseEvent) => {
    const target = event.target as Node | null
    if (!modelDropdownOpen.value || !target) return
    if (modelTriggerRef.value?.contains(target)) return
    if (modelPanelRef.value?.contains(target)) return
    modelDropdownOpen.value = false
}

const handleModelViewportChange = () => {
    if (modelDropdownOpen.value) {
        updateModelDropdownPosition()
    }
}

onMounted(() => {
    document.addEventListener('click', handleModelDocumentClick)
    window.addEventListener('resize', handleModelViewportChange)
    window.addEventListener('scroll', handleModelViewportChange, true)
})

onBeforeUnmount(() => {
    document.removeEventListener('click', handleModelDocumentClick)
    window.removeEventListener('resize', handleModelViewportChange)
    window.removeEventListener('scroll', handleModelViewportChange, true)
})

// Form Data
// 表单层用 '' 表示 "继承父 agent"（令 <select> 选中占位 option）；保存时转为服务端的 null/undefined。
type SubagentFormData = Omit<Partial<SubagentConfig>, 'thinkingLevel'> & {
    thinkingLevel?: SubagentThinkingLevel | ''
}

const initFormData = (): SubagentFormData => ({
    id: '',
    name: '',
    description: '',
    systemPrompt: '',
    model: '',
    thinkingLevel: '',
    tools: { type: 'inherit' },
    skills: { type: 'none' },
    // 扩展数据来源默认「自定义选择」（与旧数据缺省语义一致）
    extensionsMode: 'custom',
    extensions: []
})

const formData = ref<SubagentFormData>(initFormData())
const isEditing = ref(false)
const editingId = ref('')
const selectedTools = ref<string[]>([])
const selectedSkills = ref<string[]>([])

const loadAvailableSkills = async () => {
    if (!props.agent?.id) return
    try {
        // GET /api/skills/:agentId 返回全量 catalog（agent/global/system），
        // 单请求即覆盖旧的三次拼接
        availableSkills.value = await skillsState.loadAgentSkills(props.agent.id)
    } catch (e: any) {
        console.error('Failed to load skills:', e)
        availableSkills.value = []
    }
}

const loadAvailableExtensions = async () => {
    try {
        const raw = await apiGet<Array<{ id: string; name: string; enabled: boolean }>>('/api/extensions')
        availableExtensions.value = raw.filter((e) => e.enabled).map(({ id, name }) => ({ id, name }))
    } catch (e: any) {
        // 加载失败保留空清单：已挂载 id 经 extensionOptions 并集兜底仍会显示，不会静默丢失
        console.error('Failed to load extensions:', e)
    }
}

watch(() => props.agent?.id, async (newId) => {
    if (modelsState.providers.value.length === 0) {
        modelsState.loadModels()
    }

    if (newId) {
        loading.value = true
        try {
            await subAgentsState.loadSubagents(newId)
            await agentsState.loadAgentTools(newId)
            await loadAvailableSkills()
            loadAvailableExtensions()
        } catch (e: any) {
            toast.error(e.message || t('agent.subagents.loadError') || 'Failed to load subagents')
        } finally {
            loading.value = false
        }
    }
}, { immediate: true })

const openAddModal = () => {
    isEditing.value = false
    formData.value = initFormData()
    selectedTools.value = []
    selectedSkills.value = []
    selectedExtensions.value = []
    modelDropdownOpen.value = false
    showModal.value = true
}

const openEditModal = (subagent: SubagentConfig) => {
    isEditing.value = true
    editingId.value = subagent.id
    // Deep clone to avoid mutating state
    formData.value = JSON.parse(JSON.stringify(subagent))

    // Fallback if tools/skills are undefined
    if (!formData.value.tools) {
        formData.value.tools = { type: 'inherit' }
    }
    if (!formData.value.skills) {
        formData.value.skills = { type: 'none' }
    }

    // select 需要 '' 才能选中 "继承父" 选项
    if (!formData.value.thinkingLevel) {
        formData.value.thinkingLevel = ''
    }

    if (formData.value.tools.type === 'custom') {
        const denied = formData.value.tools.deniedTools || []
        selectedTools.value = availableTools.value
            .map((t: any) => t.name)
            .filter((name: string) => !denied.includes(name))
    } else {
        selectedTools.value = []
    }

    if (formData.value.skills.type === 'custom') {
        const disabled = formData.value.skills.disabledSkills || []
        selectedSkills.value = availableSkills.value
            .map((s: any) => s.id)
            .filter((id: string) => !disabled.includes(id))
    } else {
        selectedSkills.value = []
    }
    // 扩展白名单直接播种（勾选 = 挂载，无模式切换）
    selectedExtensions.value = [...(subagent.extensions ?? [])]
    // 扩展模式归一化：服务端理论上只会回 config/undefined（parse 已容错），
    // 这里仍按同款归一化兜底，非法真值也不会让 radio 悬空
    formData.value.extensionsMode = subagent.extensionsMode === 'config' ? 'config' : 'custom'
    modelDropdownOpen.value = false
    showModal.value = true
}

const closeModal = () => {
    showModal.value = false
    modelDropdownOpen.value = false
    formData.value = initFormData()
}

const saveSubagent = async () => {
    if (!props.agent?.id) return
    if (!formData.value.id || !formData.value.name || !formData.value.description || !formData.value.systemPrompt) {
        toast.error(t('agent.form.errorMissingFields') || 'ID, name, description, and system prompt are required')
        return
    }
    // Validate id: only alphanumeric characters allowed
    if (!/^[a-zA-Z0-9]+$/.test(formData.value.id)) {
        toast.error(t('agent.subagents.idInvalid') || 'ID must contain only letters and numbers')
        return
    }

    isSubmitting.value = true
    try {
        // 创建模式：重复 ID 预检查提前到 mutate 之前，避免状态污染或语义反转。
        if (!isEditing.value && subagents.value.some(s => s.id === formData.value.id)) {
            toast.error(t('agent.subagents.nameExists', { name: formData.value.id }) || `Subagent with id ${formData.value.id} already exists.`)
            isSubmitting.value = false
            return
        }

        // Convert selectedTools to deniedTools when using 'custom'
        if (formData.value.tools?.type === 'custom') {
            const selected = selectedTools.value
            const denied = availableTools.value
                .map((t: any) => t.name)
                .filter((name: string) => !selected.includes(name))
            formData.value.tools.deniedTools = denied
        } else if (formData.value.tools) {
            delete formData.value.tools.deniedTools
        }

        // Convert selectedSkills to disabledSkills when using 'custom'
        if (formData.value.skills?.type === 'custom') {
            const selected = selectedSkills.value
            const disabled = availableSkills.value
                .map((s: any) => s.id)
                .filter((id: string) => !selected.includes(id))
            formData.value.skills.disabledSkills = disabled
        } else if (formData.value.skills) {
            delete formData.value.skills.disabledSkills
        }

        // 扩展白名单直接以勾选为准（空数组 = 不挂载，显式覆盖服务端 existing）；
        // config 模式下勾选区隐藏但 selectedExtensions 原样保留，切回 custom 不丢勾选
        formData.value.extensions = [...selectedExtensions.value]
        formData.value.extensionsMode = formData.value.extensionsMode === 'config' ? 'config' : 'custom'

        // 构造 wire payload：不 mutate reactive formData（避免错误路径下 select 被 null 污染为空白态）。
        // form '' → wire null：服务端 PUT 路由依靠 "thinkingLevel" in body 区分未传/清空，
        // JSON.stringify 会丢掉 undefined 但保留 null，所以这里必须是 null。
        const payload: SubagentSaveInput = {
            ...formData.value,
            thinkingLevel: formData.value.thinkingLevel || null,
        }

        if (isEditing.value) {
            await subAgentsState.updateSubagent(props.agent.id, editingId.value, payload)
            toast.success(t('common.savedSuccess'))
        } else {
            await subAgentsState.createSubagent(props.agent.id, payload)
            toast.success(t('common.savedSuccess'))
        }
        closeModal()
    } catch (e: any) {
        toast.error(e.message || t('agent.subagents.saveError') || 'Failed to save subagent')
    } finally {
        isSubmitting.value = false
    }
}

const confirmDelete = async (id: string) => {
    if (!props.agent?.id) return
    if (!confirm(t('common.deleteConfirm') || `Are you sure you want to delete subagent ${id}?`)) return

    try {
        await subAgentsState.deleteSubagent(props.agent.id, id)
        toast.success(t('common.deleteSuccess') || 'Deleted successfully')
    } catch (e: any) {
        toast.error(e.message || t('agent.subagents.deleteError') || 'Failed to delete subagent')
    }
}

const toggleToolSelection = (toolName: string) => {
    if (selectedTools.value.includes(toolName)) {
        selectedTools.value = selectedTools.value.filter(t => t !== toolName)
    } else {
        selectedTools.value.push(toolName)
    }
}

const toggleSkillSelection = (skillId: string) => {
    if (selectedSkills.value.includes(skillId)) {
        selectedSkills.value = selectedSkills.value.filter(s => s !== skillId)
    } else {
        selectedSkills.value.push(skillId)
    }
}

const isAllToolsSelected = computed(() => {
    return availableTools.value.length > 0 && availableTools.value.every((t: any) => selectedTools.value.includes(t.name))
})

const toggleAllTools = () => {
    if (isAllToolsSelected.value) {
        selectedTools.value = []
    } else {
        selectedTools.value = availableTools.value.map((t: any) => t.name)
    }
}

const isAllSkillsSelected = computed(() => {
    return availableSkills.value.length > 0 && availableSkills.value.every((s: any) => selectedSkills.value.includes(s.id))
})

const toggleAllSkills = () => {
    if (isAllSkillsSelected.value) {
        selectedSkills.value = []
    } else {
        selectedSkills.value = availableSkills.value.map((s: any) => s.id)
    }
}

// ─── 扩展挂载（白名单：勾选 = 挂载）───
const toggleExtensionSelection = (id: string) => {
    if (selectedExtensions.value.includes(id)) {
        selectedExtensions.value = selectedExtensions.value.filter((e) => e !== id)
    } else {
        selectedExtensions.value.push(id)
    }
}

/** 展示项 = 可挂载清单 ∪ 已勾选 id（后者如已全局禁用，标记后仍显示，避免静默丢失）。 */
const extensionOptions = computed(() => {
    const options = availableExtensions.value.map((e) => ({ ...e, mountable: true }))
    const known = new Set(options.map((o) => o.id))
    for (const id of selectedExtensions.value) {
        if (!known.has(id)) options.push({ id, name: id, mountable: false })
    }
    return options
})

const isAllExtensionsSelected = computed(() => {
    return availableExtensions.value.length > 0
        && availableExtensions.value.every((e) => selectedExtensions.value.includes(e.id))
})

const toggleAllExtensions = () => {
    if (isAllExtensionsSelected.value) {
        selectedExtensions.value = []
    } else {
        // 全选只覆盖可挂载项（禁用项无法新挂载）；取消勾选则连已挂载的禁用项一并清空
        selectedExtensions.value = [
            ...selectedExtensions.value.filter((id) => !availableExtensions.value.some((e) => e.id === id)),
            ...availableExtensions.value.map((e) => e.id),
        ]
    }
}

// ─── 黑名单语义可视化（tools/skills 实际存储为排除项，勾选 = 保留可用）───
// inherit 模式下提示父级已排除的数量（复选框区外，不随本表单勾选变化）
const parentDeniedToolsCount = computed(() =>
    availableTools.value.filter((t: any) => t.denied).length)
const parentDisabledSkillsCount = computed(() =>
    availableSkills.value.filter((s: any) => s.enabled === false).length)
// 卡片徽章排除数：收进 helper 避免模板三元内跨表达式访问可选链（TS18048）
const deniedToolsCountOf = (s: SubagentConfig) => s.tools?.deniedTools?.length ?? 0
const disabledSkillsCountOf = (s: SubagentConfig) => s.skills?.disabledSkills?.length ?? 0

</script>

<template>
    <div class="h-full flex flex-col">
        <!-- Header Actions -->
        <div class="flex justify-between items-center mb-6">
            <h3 class="text-lg font-bold flex items-center gap-2">
                <UserGroupIcon class="w-5 h-5 text-primary" />
                {{ $t('agent.tab.subagents') || 'Subagents' }}
            </h3>
            <button class="btn btn-primary btn-sm gap-2" @click="openAddModal">
                <PlusIcon class="w-4 h-4" />
                {{ $t('common.add') }}
            </button>
        </div>

        <!-- Content List -->
        <div v-if="loading" class="flex justify-center p-8">
            <span class="loading loading-spinner loading-lg text-primary"></span>
        </div>

        <div v-else-if="subagents.length === 0"
            class="flex flex-col items-center justify-center p-12 text-base-content/50 border-2 border-dashed border-base-300 rounded-2xl">
            <UserGroupIcon class="w-12 h-12 mb-4 opacity-20" />
            <p>{{ $t('agent.subagents.noAgents') || 'No subagents configured yet' }}</p>
            <button class="btn btn-ghost btn-sm mt-4" @click="openAddModal">{{ $t('common.create') }}</button>
        </div>

        <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div v-for="agent in subagents" :key="agent.id"
                class="card bg-base-200 border border-base-300 shadow-sm hover:shadow-md transition-all">
                <div class="card-body p-4">
                    <div class="flex justify-between items-start mb-2">
                        <h4 class="font-bold text-lg truncate flex-1" :title="agent.name">{{ agent.name }}</h4>
                        <div class="flex gap-1 shrink-0 ml-2">
                            <button class="btn btn-square btn-ghost btn-xs" @click="openEditModal(agent)"
                                :title="$t('common.edit')">
                                <PencilIcon class="w-4 h-4" />
                            </button>
                            <button class="btn btn-square btn-ghost btn-xs text-error" @click="confirmDelete(agent.id)"
                                :title="$t('common.delete')">
                                <TrashIcon class="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    <p class="text-sm text-base-content/70 line-clamp-2 mb-3" :title="agent.description">{{
                        agent.description }}</p>

                    <div class="flex flex-wrap gap-2 mt-auto">
                        <div v-if="agent.model" class="badge badge-outline badge-sm text-xs opacity-70">
                            {{ `${agent.provider}/${agent.model}` }}
                        </div>
                        <div v-if="agent.thinkingLevel"
                            class="badge badge-outline badge-sm text-xs opacity-70"
                            :title="$t('chat.thinkingLevel')">
                            {{ $t('chat.thinking') }}: {{ $t(`chat.thinkingLevels.${agent.thinkingLevel}`) }}
                        </div>
                        <div v-if="agent.tools?.type === 'custom'"
                            class="badge badge-primary badge-outline badge-sm text-xs gap-1">
                            <CommandLineIcon class="w-3 h-3" />
                            {{ deniedToolsCountOf(agent) > 0
                                ? $t('agent.tools.customToolsExcluded', { count: deniedToolsCountOf(agent) })
                                : $t('agent.tools.customTools') }}
                        </div>
                        <div v-else-if="agent.tools?.type === 'inherit'"
                            class="badge badge-ghost badge-outline badge-sm text-xs gap-1">
                            <CommandLineIcon class="w-3 h-3" />
                            {{ $t('agent.tools.inheritParent') || 'Inherit Parent' }}
                        </div>

                        <div v-if="agent.skills?.type === 'custom'"
                            class="badge badge-secondary badge-outline badge-sm text-xs gap-1">
                            {{ disabledSkillsCountOf(agent) > 0
                                ? $t('agent.skills.customSkillsExcluded', { count: disabledSkillsCountOf(agent) })
                                : $t('agent.skills.customSkills') }}
                        </div>
                        <div v-if="agent.skills?.type === 'inherit'"
                            class="badge badge-secondary badge-outline badge-sm text-xs gap-1">
                            {{ $t('agent.skills.inherited') || 'Inherit Skills' }}
                        </div>

                        <div v-if="agent.extensionsMode === 'config'"
                            class="badge badge-accent badge-outline badge-sm text-xs"
                            :title="$t('agent.subagents.extensionsModeConfigHint')">
                            {{ $t('agent.subagents.extensionsModeConfigBadge') }}
                        </div>
                        <div v-else-if="agent.extensions?.length"
                            class="badge badge-accent badge-outline badge-sm text-xs"
                            :title="$t('agent.subagents.mountExtensions')">
                            {{ $t('agent.subagents.extensionsBadge', { count: agent.extensions.length }) }}
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Form Modal -->
        <dialog class="modal" :class="{ 'modal-open': showModal }">
            <div class="modal-box w-11/12 max-w-3xl flex flex-col max-h-[90vh]">
                <h3 class="font-bold text-lg mb-4">{{ isEditing ? ($t('agent.subagents.editTitle') + ' ' + editingId)
                    :
                    $t('agent.subagents.addTitle') || 'Add Subagent' }}</h3>

                <div class="flex-1 overflow-y-auto custom-scrollbar px-1 py-2 space-y-4">
                    <!-- ID -->
                    <div class="form-control w-full">
                        <label class="label"><span class="label-text font-medium">ID <span
                                    class="text-error">*</span></span></label>
                        <input v-model="formData.id" type="text" class="input input-bordered w-full"
                            :disabled="isEditing"
                            :placeholder="$t('agent.subagents.idPlaceholder') || 'e.g. researcher1'" />
                        <label class="label">
                            <span v-if="isEditing" class="label-text-alt text-base-content/50">{{
                                $t('agent.subagents.idEditWarning')
                                || 'ID cannot be changed when editing.' }}</span>
                            <span v-else class="label-text-alt text-base-content/50">{{ $t('agent.subagents.idHint')
                                || 'Only letters and numbers allowed, used as unique identifier' }}</span>
                        </label>
                    </div>

                    <!-- Name -->
                    <div class="form-control w-full">
                        <label class="label"><span class="label-text font-medium">{{ $t('agent.form.name') }} <span
                                    class="text-error">*</span></span></label>
                        <input v-model="formData.name" type="text" class="input input-bordered w-full"
                            :placeholder="$t('agent.subagents.namePlaceholder') || 'e.g. Researcher'" />
                    </div>

                    <!-- Description -->
                    <div class="form-control w-full">
                        <label class="label"><span class="label-text font-medium">{{ $t('agent.form.description') }}
                                <span class="text-error">*</span></span></label>
                        <input v-model="formData.description" type="text" class="input input-bordered w-full"
                            :placeholder="$t('agent.subagents.descPlaceholder') || 'Brief description of what this subagent does'" />
                    </div>

                    <!-- Model -->
                    <div class="form-control w-full">
                        <label class="label">
                            <span class="label-text font-medium">Model <span
                                    class="text-base-content/50 font-normal">({{ $t('common.optional') }})</span></span>
                            <span class="label-text-alt text-base-content/50">{{ $t('agent.subagents.modelOverride') ||
                                'Overrides agent\'s default model' }}</span>
                        </label>
                        <div class="relative w-full">
                            <button ref="modelTriggerRef" type="button" @click.stop="toggleModelDropdown"
                                class="btn btn-ghost btn-sm gap-2 font-normal rounded-lg border border-base-content/20 hover:border-base-content/40 hover:bg-base-300 transition-all w-full justify-between h-12"
                                :title="$t('provider.selectModel')">
                                <span class="flex items-center gap-2 min-w-0 flex-1">
                                    <CpuChipIcon class="h-4 w-4 shrink-0" />
                                    <span class="truncate">{{ currentModelLabel }}</span>
                                </span>
                                <ChevronUpIcon class="h-3 w-3 shrink-0 opacity-50 transition-transform"
                                    :class="{ 'rotate-180': modelDropdownOpen }" />
                            </button>
                        </div>
                    </div>

                    <Teleport to="body">
                        <div v-if="modelDropdownOpen" ref="modelPanelRef" :style="modelDropdownStyle"
                            class="z-[200] bg-base-100 rounded-box border border-base-300 shadow-xl overflow-hidden flex flex-col">
                            <button type="button" @click="clearModelSelection"
                                class="flex items-center gap-2 px-4 py-2 text-left text-xs hover:bg-base-200 transition-colors border-b border-base-300 shrink-0"
                                :class="{ 'bg-primary/10 text-primary': !selectedModelValue }">
                                {{ $t('agent.form.modelPlaceholder') || 'Inherit Parent Model' }}
                            </button>
                            <ModelSelectMenuContent :available-models="availableModelGroups"
                                :current-model="selectedModelValue"
                                :show-unknown-current="!isCurrentModelAvailable && !!selectedModelValue"
                                @select="handleModelSelect" />
                        </div>
                    </Teleport>

                    <!-- Thinking Level -->
                    <div class="form-control w-full">
                        <label class="label">
                            <span class="label-text font-medium">{{ $t('chat.thinkingLevel') }}
                                <span class="text-base-content/50 font-normal">({{ $t('common.optional') }})</span></span>
                            <span class="label-text-alt text-base-content/50">{{ $t('agent.subagents.thinkingLevelHint') }}</span>
                        </label>
                        <select v-model="formData.thinkingLevel" class="select select-bordered w-full font-sans">
                            <option value="">{{ $t('agent.subagents.inheritThinkingLevel') }}</option>
                            <option value="off">{{ $t('chat.thinkingLevels.off') }}</option>
                            <option value="minimal">{{ $t('chat.thinkingLevels.minimal') }}</option>
                            <option value="low">{{ $t('chat.thinkingLevels.low') }}</option>
                            <option value="medium">{{ $t('chat.thinkingLevels.medium') }}</option>
                            <option value="high">{{ $t('chat.thinkingLevels.high') }}</option>
                            <option value="xhigh">{{ $t('chat.thinkingLevels.xhigh') }}</option>
                            <option value="max">{{ $t('chat.thinkingLevels.max') }}</option>
                        </select>
                    </div>

                    <!-- System Prompt -->
                    <div class="form-control w-full">
                        <label class="label w-full"><span class="label-text font-medium">{{
                            $t('agent.subagents.systemPrompt')
                            || 'System Prompt' }} <span class="text-error">*</span></span></label>
                        <textarea v-model="formData.systemPrompt"
                            class="textarea textarea-bordered h-32 font-mono text-sm w-full"
                            :placeholder="$t('agent.subagents.promptPlaceholder') || 'You are a helpful assistant...'"></textarea>
                    </div>

                    <!-- Tools Selection -->
                    <div class="form-control w-full" v-if="formData.tools">
                        <div class="flex items-center justify-between">
                            <label class="label"><span class="label-text font-medium">{{ $t('agent.tab.tools') ||
                                'Tools' }}
                                    <span class="text-base-content/50 font-normal">({{ $t('common.optional')
                                    }})</span></span></label>
                            <button v-if="formData.tools.type === 'custom' && availableTools.length > 0" type="button"
                                class="btn btn-ghost btn-xs text-xs" @click="toggleAllTools">
                                {{ isAllToolsSelected ? ($t('common.deselectAll') || 'Deselect All') :
                                    ($t('common.selectAll') || 'Select All') }}
                            </button>
                        </div>

                        <!-- Toggle Mode -->
                        <div class="flex gap-4 mb-2">
                            <label class="label cursor-pointer gap-2 justify-start">
                                <input type="radio" class="radio radio-primary radio-sm" value="inherit"
                                    v-model="formData.tools.type" />
                                <span class="label-text">{{ $t('agent.tools.inheritParent') || 'Inherit Parent'
                                }}</span>
                            </label>
                            <label class="label cursor-pointer gap-2 justify-start">
                                <input type="radio" class="radio radio-primary radio-sm" value="custom"
                                    v-model="formData.tools.type" />
                                <span class="label-text">{{ $t('agent.tools.customSelection') || 'Custom Selection'
                                }}</span>
                            </label>
                        </div>

                        <!-- inherit 模式：说明父级已排除多少工具（勾选 = 保留可用的黑名单语义） -->
                        <p v-if="formData.tools.type === 'inherit' && availableTools.length > 0"
                            class="text-xs text-base-content/50 mb-2">
                            {{ $t('agent.tools.parentDenied', { count: parentDeniedToolsCount }) }}
                        </p>

                        <!-- Checkboxes when custom -->
                        <div v-if="formData.tools.type === 'custom'"
                            class="bg-base-200/50 rounded-xl border border-base-300">
                            <div class="p-4 max-h-48 overflow-y-auto custom-scrollbar">
                                <!-- 黑名单语义说明：实际存储为排除项（deniedTools），勾选 = 允许使用 -->
                                <p class="text-xs text-base-content/50 mb-3">{{ $t('agent.tools.hint') }}</p>
                                <div v-if="availableTools.length === 0"
                                    class="text-center text-sm text-base-content/50 py-2">
                                    {{ $t('agent.noTools') || 'No tools available in parent agent' }}
                                </div>
                                <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <label v-for="tool in availableTools" :key="tool.name"
                                        class="label cursor-pointer justify-start gap-3 bg-base-100 p-2 rounded-lg border border-base-300 hover:border-primary/30 transition-colors">
                                        <input type="checkbox" class="checkbox checkbox-sm checkbox-primary"
                                            :checked="selectedTools.includes(tool.name)"
                                            @change="toggleToolSelection(tool.name)" />
                                        <span class="label-text text-sm font-medium truncate" :title="tool.name">{{
                                            tool.name }}</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Skills Selection -->
                    <div class="form-control w-full" v-if="formData.skills">
                        <div class="flex items-center justify-between">
                            <label class="label"><span class="label-text font-medium">{{ $t('agent.tab.skills') ||
                                'Skills'
                                    }}
                                    <span class="text-base-content/50 font-normal">({{ $t('common.optional')
                                    }})</span></span></label>
                            <button v-if="formData.skills.type === 'custom' && availableSkills.length > 0" type="button"
                                class="btn btn-ghost btn-xs text-xs" @click="toggleAllSkills">
                                {{ isAllSkillsSelected ? ($t('common.deselectAll') || 'Deselect All') :
                                    ($t('common.selectAll') || 'Select All') }}
                            </button>
                        </div>

                        <!-- Toggle Mode -->
                        <div class="flex gap-4 mb-2">
                            <label class="label cursor-pointer gap-2 justify-start">
                                <input type="radio" class="radio radio-primary radio-sm" value="none"
                                    v-model="formData.skills.type" />
                                <span class="label-text">{{ $t('agent.skills.disableAll') || 'Load none' }}</span>
                            </label>
                            <label class="label cursor-pointer gap-2 justify-start">
                                <input type="radio" class="radio radio-primary radio-sm" value="inherit"
                                    v-model="formData.skills.type" />
                                <span class="label-text">{{ $t('agent.skills.inheritParent') || 'Inherit Parent'
                                    }}</span>
                            </label>
                            <label class="label cursor-pointer gap-2 justify-start">
                                <input type="radio" class="radio radio-primary radio-sm" value="custom"
                                    v-model="formData.skills.type" />
                                <span class="label-text">{{ $t('agent.skills.customSelection') || 'Custom Selection'
                                    }}</span>
                            </label>
                        </div>

                        <!-- inherit 模式：说明父级已禁用多少技能 -->
                        <p v-if="formData.skills.type === 'inherit' && availableSkills.length > 0"
                            class="text-xs text-base-content/50 mb-2">
                            {{ $t('agent.skills.parentDisabled', { count: parentDisabledSkillsCount }) }}
                        </p>

                        <!-- Checkboxes when custom -->
                        <div v-if="formData.skills.type === 'custom'"
                            class="bg-base-200/50 rounded-xl border border-base-300">
                            <div class="p-4 max-h-48 overflow-y-auto custom-scrollbar">
                                <!-- 黑名单语义说明：实际存储为排除项（disabledSkills），勾选 = 加载 -->
                                <p class="text-xs text-base-content/50 mb-3">{{ $t('agent.skills.hint') }}</p>
                                <div v-if="availableSkills.length === 0"
                                    class="text-center text-sm text-base-content/50 py-2">
                                    {{ $t('agent.skills.noSkills') || 'No skills available in parent agent' }}
                                </div>
                                <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <label v-for="skill in availableSkills" :key="skill.id"
                                        class="label cursor-pointer justify-start gap-3 bg-base-100 p-2 rounded-lg border border-base-300 hover:border-primary/30 transition-colors">
                                        <input type="checkbox" class="checkbox checkbox-sm checkbox-primary"
                                            :checked="selectedSkills.includes(skill.id)"
                                            @change="toggleSkillSelection(skill.id)" />
                                        <span class="label-text text-sm font-medium truncate" :title="skill.id">{{
                                            skill.id }}</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Extensions Mount（模式切换 + 白名单勾选：custom = 勾选即挂载；config = 跟随全局默认集） -->
                    <div class="form-control w-full">
                        <div class="flex items-center justify-between">
                            <label class="label"><span class="label-text font-medium">{{
                                $t('agent.subagents.mountExtensions') }}
                                    <span class="text-base-content/50 font-normal">({{ $t('common.optional')
                                    }})</span></span></label>
                            <button v-if="formData.extensionsMode === 'custom' && extensionOptions.length > 0"
                                type="button" class="btn btn-ghost btn-xs text-xs" @click="toggleAllExtensions">
                                {{ isAllExtensionsSelected ? ($t('common.deselectAll') || 'Deselect All') :
                                    ($t('common.selectAll') || 'Select All') }}
                            </button>
                        </div>

                        <!-- Toggle Mode -->
                        <div class="flex gap-4 mb-2">
                            <label class="label cursor-pointer gap-2 justify-start">
                                <input type="radio" class="radio radio-primary radio-sm" value="custom"
                                    v-model="formData.extensionsMode" />
                                <span class="label-text">{{ $t('agent.subagents.extensionsModeCustom') || 'Custom Selection' }}</span>
                            </label>
                            <label class="label cursor-pointer gap-2 justify-start">
                                <input type="radio" class="radio radio-primary radio-sm" value="config"
                                    v-model="formData.extensionsMode" />
                                <span class="label-text">{{ $t('agent.subagents.extensionsModeConfig') || 'Use Configured Extensions' }}</span>
                            </label>
                        </div>

                        <!-- config 模式：跟随全局默认集，勾选区隐藏 -->
                        <p v-if="formData.extensionsMode === 'config'" class="text-xs text-base-content/50 mb-2">
                            {{ $t('agent.subagents.extensionsModeConfigHint') }}
                        </p>

                        <template v-else>
                            <!-- 白名单语义说明：与 tools/skills 的黑名单（勾选 = 保留可用）相反 -->
                            <p class="text-xs text-base-content/50 mb-2">{{ $t('agent.subagents.extensionsHint') }}</p>

                            <div class="bg-base-200/50 rounded-xl border border-base-300">
                                <div class="p-4 max-h-48 overflow-y-auto custom-scrollbar">
                                    <div v-if="extensionOptions.length === 0"
                                        class="text-center text-sm text-base-content/50 py-2">
                                        {{ $t('agent.subagents.noExtensions') || 'No mountable extensions' }}
                                    </div>
                                    <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                        <label v-for="ext in extensionOptions" :key="ext.id"
                                            class="label cursor-pointer justify-start gap-3 bg-base-100 p-2 rounded-lg border border-base-300 hover:border-primary/30 transition-colors">
                                            <input type="checkbox" class="checkbox checkbox-sm checkbox-primary"
                                                :checked="selectedExtensions.includes(ext.id)"
                                                @change="toggleExtensionSelection(ext.id)" />
                                            <span class="label-text text-sm font-medium truncate flex-1" :title="ext.id">{{
                                                ext.name }}</span>
                                            <!-- 已挂载但已全局禁用：保留勾选可见性，标记后不静默消失 -->
                                            <span v-if="!ext.mountable"
                                                class="badge badge-ghost badge-sm text-xs opacity-70 shrink-0">{{
                                                $t('agent.subagents.extensionGloballyDisabled') }}</span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </template>
                    </div>
                </div>

                <div class="modal-action mt-6">
                    <button class="btn btn-ghost" @click="closeModal" :disabled="isSubmitting">{{ $t('common.cancel')
                    }}</button>
                    <button class="btn btn-primary" @click="saveSubagent" :disabled="isSubmitting">
                        <span v-if="isSubmitting" class="loading loading-spinner loading-xs"></span>
                        {{ $t('common.save') }}
                    </button>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop">
                <button @click="closeModal">close</button>
            </form>
        </dialog>
    </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
    width: 6px;
}

.custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
    background-color: var(--fallback-bc, oklch(var(--bc)/0.2));
    border-radius: 3px;
}
</style>
