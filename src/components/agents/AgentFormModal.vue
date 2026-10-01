<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import { useAgentsState } from '../../composables/useAgentsState'
import { useModelsState } from '../../composables/useModelsState'
import { useToast } from '../../composables/useToast'
import { useI18n } from 'vue-i18n'
import {
    PhotoIcon,
    XMarkIcon,
    UserCircleIcon,
    SparklesIcon,
    CpuChipIcon,
    FaceSmileIcon,
    TagIcon,
    ChevronUpIcon,
    LightBulbIcon
} from '@heroicons/vue/24/outline'
import WorkspacePathField from '../workspace/WorkspacePathField.vue'
import ModelSelectMenuContent from '../models/ModelSelectMenuContent.vue'


const props = defineProps<{
    show: boolean
    mode: 'add' | 'edit'
    agentData?: any
}>()

const emit = defineEmits<{
    (e: 'close'): void
    (e: 'saved', agentId: string): void
}>()

const agentsState = useAgentsState()
const modelsState = useModelsState()
const toast = useToast()
const { t } = useI18n()



// Available models (already a ComputedRef from useModelsState)
const availableModels = modelsState.availableModels

// Form data
const formData = ref({
    id: '',
    name: '',
    description: '',
    defaultModel: '',
    defaultProvider: '',
    // 默认对齐服务端 DEFAULT_AGENT_CONFIG.defaultThinkingLevel: "high"，保留既有创建行为
    defaultThinkingLevel: 'high',
    workspaceDir: '',
    avatarFile: null as File | null,
    avatarPreview: ''
})

// Workspace 联动预填（spec §5.1）：校验通过后按 basename 预填 id/name，
// 仅当对应字段为空且未被用户手动改过时生效（touched 脏标记防覆盖）。
const workspaceFieldRef = ref<InstanceType<typeof WorkspacePathField> | null>(null)
const idTouched = ref(false)
const nameTouched = ref(false)

const slugOf = (b: string) => b.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")

const onWorkspaceValidated = ({ basename }: { basename: string }) => {
    if (!basename) return
    // 字段联动（spec §5.1）：仅当字段为空且未被手动改过时预填
    if (props.mode === 'add' && !idTouched.value && !formData.value.id) {
        const slug = slugOf(basename)
        if (slug) formData.value.id = slug
    }
    if (!nameTouched.value && !formData.value.name) formData.value.name = basename
}

const isBusy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// Watch for show changes to reset/populate form
watch(() => props.show, (newVal) => {
    if (newVal) {
        // Reset file input
        if (fileInput.value) fileInput.value.value = ''

        if (props.mode === 'edit' && props.agentData) {
            // Populate form with existing data
            formData.value = {
                id: props.agentData.id,
                name: props.agentData.name || '',
                description: props.agentData.description || '',
                defaultModel: props.agentData.defaultModel || '',
                defaultProvider: props.agentData.defaultProvider || '',
                defaultThinkingLevel: props.agentData?.defaultThinkingLevel || 'high',
                // 必须用 raw 原始值（服务端 GET 详情提供 workspaceDirRaw）；
                // 用解析/规范化值会把默认 agent 一保存就绑到自身 workspace
                workspaceDir: props.agentData?.workspaceDirRaw || '',
                avatarFile: null,
                avatarPreview: props.agentData.avatar || ''
            }
            idTouched.value = false
            nameTouched.value = false
        } else {
            // Reset form for add mode
            formData.value = {
                id: '',
                name: '',
                description: '',
                defaultModel: '',
                defaultProvider: '',
                defaultThinkingLevel: 'high',
                workspaceDir: '',
                avatarFile: null,
                avatarPreview: ''
            }
            idTouched.value = false
            nameTouched.value = false
        }
    }
})

const isFormValid = computed(() => {
    if (props.mode === 'add' && !formData.value.id.trim()) return false
    return true
})

const submitLabel = computed(() => {
    return isBusy.value ? t('common.saving') : (props.mode === 'add' ? t('common.create') : t('common.save'))
})

const headerTitle = computed(() => {
    return props.mode === 'add' ? t('agent.addTitle') : t('agent.editTitle')
})

const handleClose = () => {
    emit('close')
}

// Model selection helper
const selectedModelValue = computed({
    get: () => {
        if (formData.value.defaultProvider && formData.value.defaultModel) {
            return `${formData.value.defaultProvider}/${formData.value.defaultModel}`
        }
        return formData.value.defaultModel || ''
    },
    set: (val: string) => {
        if (!val) {
            formData.value.defaultProvider = ''
            formData.value.defaultModel = ''
            return
        }
        if (val.includes('/')) {
            const [p, ...m] = val.split('/')
            formData.value.defaultProvider = p
            formData.value.defaultModel = m.join('/')
        } else {
            formData.value.defaultModel = val
        }
    }
})

// 模型下拉（复用底部输入框共用的 ModelSelectMenuContent）：手动 ref 开合，
// 触发按钮 @click.stop + document 点击按包含关系关外，菜单内点击（搜索/选项）不关
const modelMenuOpen = ref(false)
const modelMenuRef = ref<HTMLElement | null>(null)

// 触发按钮展示标签：与 ModelSelectMenuContent.currentModelLabel 同规则解析 composite（未知模型回退原值）
const selectedModelLabel = computed(() => {
    const val = selectedModelValue.value
    if (!val) return ''
    for (const group of availableModels.value) {
        const matched = group.models.find((m) => `${group.provider}/${m.id}` === val)
        if (matched) return `${group.provider} / ${matched.name}`
    }
    return val
})

const onModelSelect = (modelId: string) => {
    modelMenuOpen.value = false
    // 经 selectedModelValue 桥接写回：composite 自动拆 provider/model，'' 清空两者
    selectedModelValue.value = modelId
}

const handleModelMenuDocClick = (event: MouseEvent) => {
    if (!modelMenuOpen.value) return
    if (!modelMenuRef.value?.contains(event.target as Node)) {
        modelMenuOpen.value = false
    }
}

onMounted(() => {
    document.addEventListener('click', handleModelMenuDocClick)
})

onBeforeUnmount(() => {
    document.removeEventListener('click', handleModelMenuDocClick)
})

const triggerFileInput = () => {
    fileInput.value?.click()
}

const handleFileChange = (event: Event) => {
    const input = event.target as HTMLInputElement
    if (input.files && input.files[0]) {
        const file = input.files[0]
        formData.value.avatarFile = file

        const reader = new FileReader()
        reader.onload = (e) => {
            formData.value.avatarPreview = e.target?.result as string
        }
        reader.readAsDataURL(file)
    }
}

const submitForm = async () => {
    if (!isFormValid.value) return
    isBusy.value = true
    try {
        const data = new FormData()
        data.append('id', formData.value.id)

        // Append fields if they have value
        if (formData.value.name) data.append('name', formData.value.name)
        if (formData.value.description) data.append('description', formData.value.description)
        if (formData.value.defaultModel) data.append('defaultModel', formData.value.defaultModel)
        if (formData.value.defaultProvider) data.append('defaultProvider', formData.value.defaultProvider)
        // 思考等级始终提交（默认 high，对齐服务端 DEFAULT_AGENT_CONFIG），服务端解析 + 枚举校验
        data.append('defaultThinkingLevel', formData.value.defaultThinkingLevel)

        // workspaceDirRaw 契约守卫：当前网关的编辑详情必含 workspaceDirRaw，此时始终
        // append（空串 = 明确解除绑定）；仅旧网关载荷缺该字段且表单值为空（未触碰）时
        // 不 append，避免无关编辑（改名/头像）把既有绑定静默清掉。
        if (formData.value.workspaceDir || 'workspaceDirRaw' in (props.agentData ?? {})) {
            data.append('workspaceDir', formData.value.workspaceDir || '')
        }

        if (formData.value.avatarFile) {
            data.append('avatar', formData.value.avatarFile)
        }

        if (props.mode === 'add') {
            await agentsState.createAgent(data)
        } else {
            await agentsState.updateAgent(data)
        }

        emit('saved', formData.value.id)
        emit('close')
    } catch (e: any) {
        toast.error(e.message || String(e))
    } finally {
        isBusy.value = false
    }
}

// Mobile check for responsive adjustments if needed
// DaisyUI modal is responsive by default, but we ensure full width on mobile
</script>

<template>
    <div :class="{ 'modal': true, 'modal-open': show }">
        <div
            class="modal-box w-full md:w-11/12 max-w-3xl p-0 bg-base-100 overflow-hidden shadow-2xl rounded-2xl md:h-auto h-full max-h-full md:max-h-[90vh] flex flex-col">
            <!-- Header -->
            <div
                class="px-6 py-4 border-b border-base-300 flex items-center justify-between bg-base-100/50 backdrop-blur-sm sticky top-0 z-20 shrink-0">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                        <SparklesIcon class="w-6 h-6" />
                    </div>
                    <div>
                        <h3 class="font-bold text-lg leading-tight">{{ headerTitle }}</h3>
                        <p class="text-xs text-base-content/50 font-medium">{{ mode === 'edit' ? formData.id :
                            t('agent.addTitle') }}</p>
                    </div>
                </div>
                <button class="btn btn-ghost btn-sm btn-circle" @click="handleClose">
                    <XMarkIcon class="w-5 h-5" />
                </button>
            </div>

            <div class="flex-1 overflow-y-auto custom-scrollbar p-6 md:p-8">
                <!-- 单列布局：档案头（头像 + ID/名称）→ workspace → 描述 → 模型设置 -->
                <div class="flex flex-col gap-5">

                    <!-- Profile Header: Avatar + ID/Name（同行排布，窄屏上下堆叠） -->
                    <div class="flex flex-col sm:flex-row gap-5 sm:gap-6">

                        <!-- Avatar uploader -->
                        <div class="relative group cursor-pointer shrink-0 self-center sm:self-start" @click="triggerFileInput">
                            <div
                                class="avatar placeholder ring-4 ring-base-200 ring-offset-2 ring-offset-base-100 rounded-full transition-all duration-300 group-hover:ring-primary/50 group-hover:shadow-lg">
                                <div
                                    class="bg-neutral text-neutral-content rounded-full w-24 h-24 md:w-28 md:h-28 shadow-inner overflow-hidden flex items-center justify-center">
                                    <img v-if="formData.avatarPreview" :src="formData.avatarPreview"
                                        class="object-cover w-full h-full transition-transform duration-500 group-hover:scale-105" />
                                    <span v-else class="text-5xl md:text-6xl select-none animate-pulse-slow">🤖</span>
                                </div>
                            </div>

                            <!-- Overlay -->
                            <div
                                class="absolute inset-0 bg-black/40 rounded-full opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition-opacity duration-300 text-white gap-1.5">
                                <PhotoIcon class="w-7 h-7" />
                                <span class="text-[10px] font-bold uppercase tracking-wider">{{ t('agent.form.uploadAvatar')
                                    }}</span>
                            </div>

                            <input ref="fileInput" type="file" accept="image/*" class="hidden"
                                @change="handleFileChange" />
                        </div>

                        <!-- ID + Name -->
                        <div class="flex-1 min-w-0 flex flex-col gap-4 w-full">
                            <!-- ID Field -->
                            <div class="form-control w-full">
                                <label class="label pt-0 pb-1.5">
                                    <span class="label-text font-bold text-sm flex items-center gap-1.5 opacity-80">
                                        <TagIcon class="w-4 h-4" />
                                        {{ t('agent.form.id') }}
                                        <span class="text-error" v-if="mode === 'add'">*</span>
                                    </span>
                                </label>
                                <input v-model="formData.id" type="text" :placeholder="t('agent.form.idPlaceholder')"
                                    class="input input-bordered w-full font-mono text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
                                    :disabled="mode === 'edit'" @input="idTouched = true"
                                    :class="{ 'input-error': mode === 'add' && !isFormValid && formData.id.length > 0 }" />
                            </div>

                            <!-- Name Field -->
                            <div class="form-control w-full">
                                <label class="label pt-0 pb-1.5">
                                    <span class="label-text font-bold text-sm flex items-center gap-1.5 opacity-80">
                                        <UserCircleIcon class="w-4 h-4" />
                                        {{ t('agent.form.name') }}
                                    </span>
                                </label>
                                <input v-model="formData.name" type="text"
                                    :placeholder="t('agent.form.namePlaceholder')" @input="nameTouched = true"
                                    class="input input-bordered w-full focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all" />
                            </div>
                        </div>
                    </div>

                    <!-- Workspace Directory Field (spec §5.1) -->
                    <div class="form-control">
                        <WorkspacePathField ref="workspaceFieldRef" v-model="formData.workspaceDir"
                            :agent-id="mode === 'edit' ? agentData?.id : undefined"
                            @validated="onWorkspaceValidated" />
                    </div>

                    <!-- Description -->
                    <div class="form-control w-full">
                        <label class="label pt-0 pb-1.5">
                            <span class="label-text font-bold text-sm flex items-center gap-1.5 opacity-80">
                                <FaceSmileIcon class="w-4 h-4" />
                                {{ t('agent.form.description') }}
                            </span>
                        </label>
                        <textarea v-model="formData.description"
                            class="textarea w-full textarea-bordered h-28 focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all resize-none text-base leading-relaxed"
                            :placeholder="t('agent.noDescriptionFallback')"></textarea>
                    </div>

                    <!-- 默认模型（复用底部输入框共用的 ModelSelectMenuContent；点 X 清空经桥接置空 provider/model） -->
                    <div class="form-control w-full">
                        <label class="label pt-0 pb-1.5">
                            <span class="label-text font-bold text-sm flex items-center gap-1.5 opacity-80">
                                <CpuChipIcon class="w-4 h-4" />
                                {{ t('agent.form.defaultModel') }}
                            </span>
                        </label>
                        <div ref="modelMenuRef" class="dropdown dropdown-top w-full"
                            :class="{ 'dropdown-open': modelMenuOpen }">
                            <button type="button" @click.stop="modelMenuOpen = !modelMenuOpen"
                                class="input input-bordered w-full flex items-center justify-between gap-2 text-left font-normal cursor-pointer">
                                <span class="truncate min-w-0"
                                    :class="{ 'opacity-40': !selectedModelValue }">{{
                                        selectedModelValue ? selectedModelLabel :
                                        t('agent.form.modelPlaceholder') }}</span>
                                <span v-if="selectedModelValue" role="button" :title="t('common.clear')"
                                    class="btn btn-ghost btn-xs btn-circle shrink-0"
                                    @click.stop="selectedModelValue = ''">
                                    <XMarkIcon class="w-3.5 h-3.5" />
                                </span>
                                <ChevronUpIcon class="w-4 h-4 shrink-0 opacity-50 transition-transform"
                                    :class="{ 'rotate-180': modelMenuOpen }" />
                            </button>
                            <div v-if="modelMenuOpen"
                                class="dropdown-content shadow-xl bg-base-100 rounded-box border border-base-300 z-[100] w-full max-h-96 overflow-hidden flex flex-col mb-2">
                                <ModelSelectMenuContent :available-models="availableModels"
                                    :current-model="selectedModelValue" @select="onModelSelect" />
                            </div>
                        </div>
                    </div>

                    <!-- 思考等级：与 AgentOverview 设置页同款枚举（off..max） -->
                    <div class="form-control w-full">
                        <label class="label pt-0 pb-1.5">
                            <span class="label-text font-bold text-sm flex items-center gap-1.5 opacity-80">
                                <LightBulbIcon class="w-4 h-4" />
                                {{ t('chat.thinkingLevel') }}
                            </span>
                        </label>
                        <select v-model="formData.defaultThinkingLevel" class="select select-bordered w-full">
                            <option value="off">{{ t('chat.thinkingLevels.off') }}</option>
                            <option value="minimal">{{ t('chat.thinkingLevels.minimal') }}</option>
                            <option value="low">{{ t('chat.thinkingLevels.low') }}</option>
                            <option value="medium">{{ t('chat.thinkingLevels.medium') }}</option>
                            <option value="high">{{ t('chat.thinkingLevels.high') }}</option>
                            <option value="xhigh">{{ t('chat.thinkingLevels.xhigh') }}</option>
                            <option value="max">{{ t('chat.thinkingLevels.max') }}</option>
                        </select>
                    </div>

                </div>

            </div>

            <!-- Footer -->
            <div
                class="px-6 py-4 border-t border-base-300 flex justify-end gap-3 bg-base-100 sticky bottom-0 z-20 shrink-0">
                <button class="btn btn-ghost hover:bg-base-200" @click="handleClose">{{ t('common.cancel') }}</button>
                <button class="btn btn-primary min-w-[120px] shadow-lg shadow-primary/20" @click="submitForm"
                    :disabled="!isFormValid || isBusy">
                    <span v-if="isBusy" class="loading loading-spinner text-primary-content"></span>
                    {{ submitLabel }}
                </button>
            </div>
        </div>

        <div class="modal-backdrop" @click="handleClose">
            <button class="cursor-default">close</button>
        </div>
    </div>
</template>

<style scoped>
.animate-pulse-slow {
    animation: pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes pulse {

    0%,
    100% {
        opacity: 1;
    }

    50% {
        opacity: .7;
    }
}

.custom-scrollbar::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}

.custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
    background-color: var(--fallback-bc, oklch(var(--bc)/0.2));
    border-radius: 3px;
}

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: var(--fallback-bc, oklch(var(--bc)/0.3));
}
</style>
