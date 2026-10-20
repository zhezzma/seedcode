<script setup lang="ts">
import { computed, ref } from 'vue'
import { useModelsState, AvailableModel, OAuthProviders } from '../../composables/useModelsState'
import { useI18n } from 'vue-i18n'
import { ArrowLeftIcon, ArrowPathIcon, PencilIcon, TrashIcon, PlusIcon, ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline' // Explicit import just in case
import ViewHeader from '../ViewHeader.vue'
import ProviderFormModal from './ProviderFormModal.vue'
import ModelFormModal from './ModelFormModal.vue'
import OAuthModal from './OAuthModal.vue'

const props = defineProps<{
    providerId: string
}>()

// 删除提供商后通知父组件切换选中项；back：移动端返回键回列表
const emit = defineEmits<{
    (e: 'deleted'): void
    (e: 'back'): void
}>()

const { t } = useI18n()
const {
    providers,
    loadModels,
    deleteProvider: deleteProviderAction,
    syncModels: syncModelsAction,
    saveModel,
    deleteModel: deleteModelAction,
    clearProviderModels: clearProviderModelsAction,
} = useModelsState()

// Get provider from the providers list
const provider = computed(() => {
    return providers.value.find(p => p.id === props.providerId) || null
})

const modelList = computed(() => {
    return provider.value?.models.map(m => ({
        id: m.id,
        name: m.name,
        type: m.type ?? 'chat',
        reasoning: m.reasoning,
        input: m.input?.length ? m.input : ['text'],
        contextWindow: m.contextWindow || 0,
        maxTokens: m.maxTokens || 0,
        // api: m.api, // Not on model level usually
        original: m
    })) || []
})

const formatNumber = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(0)}k`
    return String(n)
}

// Sync
const syncing = ref(false)
const clearingModels = ref(false)
const syncError = ref('')
const syncResult = ref('')

const syncModels = async () => {
    syncing.value = true
    syncError.value = ''
    syncResult.value = ''
    try {
        const res = await syncModelsAction(props.providerId)
        syncResult.value = t('model.syncSuccess', { n: res.created })
    } catch (e: any) {
        syncError.value = e.message
    } finally {
        syncing.value = false
    }
}

// Edit Provider Modal
const showEditProviderModal = ref(false)
const showOAuthModal = ref(false)
const openEditProvider = () => {
    showEditProviderModal.value = true
}

const handleProviderSaved = async (_id: string) => {
    // saveProvider 已在本地更新了 state.providers，无需重新加载
}
const handleOAuthCompleted = () => {
    loadModels()
}

// Delete Provider
const deleteProvider = async () => {
    if (!confirm(t('provider.confirmDelete', { id: props.providerId }))) return

    try {
        await deleteProviderAction(props.providerId)
        emit('deleted')
    } catch (e: any) {
        alert(e.message || t('provider.deleteFailed'))
    }
}

// Model Modal
const showModelModal = ref(false)
const modelModalMode = ref<'add' | 'edit'>('add')
const selectedModel = ref<AvailableModel | undefined>(undefined)

const openAddModel = () => {
    modelModalMode.value = 'add'
    selectedModel.value = undefined
    showModelModal.value = true
}

const openEditModel = (model: AvailableModel) => {
    modelModalMode.value = 'edit'
    selectedModel.value = model
    showModelModal.value = true
}

const handleModelSaved = async (model: AvailableModel) => {
    try {
        await saveModel(props.providerId, model)
        showModelModal.value = false
    } catch (e: any) {
        alert(e.message)
    }
}

const handleDeleteModel = async (modelId: string) => {
    if (!confirm(t('model.deleteConfirm', { id: modelId }))) return
    try {
        await deleteModelAction(props.providerId, modelId)
    } catch (e: any) {
        alert(e.message)
    }
}

const handleClearModels = async () => {
    if (!provider.value?.custom) return
    if (!confirm(t('model.clearConfirm', { id: props.providerId }))) return

    clearingModels.value = true
    syncError.value = ''
    syncResult.value = ''
    try {
        const res = await clearProviderModelsAction(props.providerId)
        syncResult.value = t('model.clearSuccess', { n: res.deleted })
    } catch (e: any) {
        alert(e.message)
    } finally {
        clearingModels.value = false
    }
}

</script>

<template>
    <div class="h-full w-full relative">
        <div v-if="provider" class="h-full flex flex-col ">
            <!-- 顶栏（兼作标题栏拖拽区 + 为悬浮窗口键预留右侧）；返回键仅移动端显示（回列表），桌面由侧栏切换 -->
            <ViewHeader :title="provider.id" wc-pad>
                <template #left>
                    <button class="btn btn-ghost btn-sm btn-circle lg:hidden" :aria-label="$t('common.back')" @click="$emit('back')">
                        <ArrowLeftIcon class="h-5 w-5" />
                    </button>
                </template>
                <template #actions>
                    <div class="flex items-center gap-5">
                        <button v-if="provider.custom" @click="syncModels" class="btn btn-ghost btn-circle btn-xs"
                            :disabled="syncing" :title="$t('common.sync')">
                            <ArrowPathIcon class="h-5 w-5" :class="syncing ? 'animate-spin' : ''" />
                        </button>
                        <button v-if="provider.type === 'oauth' || OAuthProviders.includes(props.providerId)"
                            @click="showOAuthModal = true" class="btn btn-ghost btn-circle btn-xs"
                            :title="$t('provider.login', 'Login')">
                            <ArrowTopRightOnSquareIcon class="h-5 w-5" />
                        </button>
                        <button @click="openEditProvider" class="btn btn-ghost btn-circle btn-xs"
                            :title="$t('common.edit')">
                            <PencilIcon class="h-5 w-5" />
                        </button>
                        <button v-if="provider.custom" @click="deleteProvider" class="btn btn-ghost btn-circle btn-xs"
                            :title="$t('common.delete')">
                            <TrashIcon class="h-5 w-5" />
                        </button>
                    </div>

                </template>
            </ViewHeader>
            <div v-if="syncError" class="shrink-0 px-4 py-1 text-sm text-error">{{ syncError }}</div>
            <div v-if="syncResult" class="shrink-0 px-4 py-1 text-sm text-success">{{ syncResult }}</div>


            <!-- Content -->
            <div class="flex-1 overflow-y-auto p-4 md:p-6">
                <h2 class="text-lg font-semibold mb-4 flex items-center justify-between gap-2">
                    {{ $t('model.listTitle') }}
                    <div class="flex items-center gap-2">
                        <button v-if="provider?.custom" @click="handleClearModels"
                            class="btn btn-xs btn-ghost gap-1 text-warning" :disabled="clearingModels">
                            <TrashIcon class="w-3 h-3" />
                            {{ $t('common.clear') }}
                        </button>
                        <button @click="openAddModel" class="btn btn-xs btn-ghost gap-1">
                            <PlusIcon class="w-3 h-3" />
                            {{ $t('common.add') }}
                        </button>
                    </div>
                </h2>

                <!-- Model Grid -->
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">

                    <!-- Add New Card -->
                    <!-- <div @click="openAddModel"
                        class="aspect-square bg-base-200/30 rounded-lg p-3 sm:p-4 flex flex-col items-center justify-center hover:bg-base-200 transition-all cursor-pointer border-2 border-dashed border-base-content/10 hover:border-primary/50 text-base-content/40 hover:text-primary">
                        <PlusIcon class="w-8 h-8 mb-2" />
                        <span class="text-xs font-semibold">{{ $t('common.add') }}</span>
                    </div> -->

                    <!-- Model Cards -->
                    <div v-for="item in modelList" :key="`${item.id}:${item.type}`" @click="openEditModel(item.original)"
                        class="aspect-square cursor-pointer bg-base-200 shadow-sm rounded-lg p-3 sm:p-4 flex flex-col transition-all group relative border border-base-300 hover:border-primary hover:shadow-md">

                        <!-- Hover Actions -->
                        <div
                            class="absolute top-2 right-2 md:opacity-0 md:group-hover:opacity-100 transition-opacity flex gap-1 bg-base-100/80 rounded-lg shadow-sm backdrop-blur-sm p-1">
                            <!-- <button @click.stop="openEditModel(item.original)" class="btn btn-ghost btn-xs btn-square">
                                <PencilIcon class="w-3 h-3" />
                            </button> -->
                            <button @click.stop="handleDeleteModel(item.id)"
                                class="btn btn-ghost btn-xs btn-square text-error">
                                <TrashIcon class="w-3 h-3" />
                            </button>
                        </div>

                        <!-- Model Icon -->
                        <div class="text-xl mb-2">🤖</div>

                        <!-- Model Info -->
                        <div class="flex-1 min-w-0">
                            <div class="font-semibold text-sm truncate" :title="item.name">{{ item.name }}</div>
                            <div class="text-xs text-base-content/50 truncate" :title="item.id">{{ item.id }}</div>

                            <!-- Capacity line: keep context window and max output tokens together on their own row -->
                            <div v-if="item.contextWindow > 0 || item.maxTokens > 0"
                                class="mt-2 text-[11px] leading-4 text-base-content/60 flex flex-wrap gap-x-3 gap-y-1">
                                <span v-if="item.contextWindow > 0">
                                    {{ $t('model.ctx') }} {{ formatNumber(item.contextWindow) }}
                                </span>
                                <span v-if="item.maxTokens > 0">
                                    {{ $t('model.maxOutputShort') }} {{ formatNumber(item.maxTokens) }}
                                </span>
                            </div>
                        </div>

                        <!-- Tags -->
                        <div class="flex flex-wrap gap-1 mt-2">
                            <span v-if="item.type === 'classifier'" class="badge badge-xs badge-secondary"
                                :title="$t('model.type.classifierDesc')">⚖️ {{ $t('model.type.classifier') }}</span>
                            <span v-else-if="item.type === 'image'" class="badge badge-xs badge-secondary"
                                :title="$t('model.type.imageDesc')">🎨 {{ $t('model.type.image') }}</span>
                            <span v-if="item.reasoning" class="badge badge-xs badge-primary">{{
                                $t('model.mode.reasoning') }}</span>
                            <span v-if="item.input.includes('text')" class="badge badge-xs badge-ghost">
                                {{ $t('model.inputText') }}
                            </span>
                            <span v-if="item.input.includes('image')" class="badge badge-xs badge-ghost">
                                {{ $t('model.inputImage') }}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Empty State -->
        <div v-else class="h-full flex items-center justify-center">
            <div class="text-center">
                <h3 class="font-bold text-lg">{{ $t('provider.notFound') }}</h3>
                <p class="text-base-content/60">{{ $t('provider.notFoundDesc', { id: providerId }) }}</p>
            </div>
        </div>

        <!-- Provider Edit Modal -->
        <ProviderFormModal :show="showEditProviderModal" mode="edit" :custom="provider?.custom" :initial-data="provider ? {
            id: provider.id,
            baseUrl: provider.baseUrl,
            api: provider.api,
            type: provider.type,
            apiKey: provider.apiKey,
            headers: provider.headers,
            compat: provider.compat
        } : undefined" @close="showEditProviderModal = false" @saved="handleProviderSaved" />

        <ModelFormModal :show="showModelModal" :mode="modelModalMode" :provider-id="providerId"
            :initial-data="selectedModel" :custom="provider?.custom" @close="showModelModal = false"
            @save="handleModelSaved" />

        <OAuthModal :show="showOAuthModal" :provider-id="providerId" @close="showOAuthModal = false"
            @completed="handleOAuthCompleted" />
    </div>
</template>
