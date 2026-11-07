<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { usePromptState, type PromptInfo } from '../../../composables/usePromptState'
import { useToast } from '../../../composables/useToast'
import { useConfirm } from '../../../composables/useConfirm'
import { useI18n } from 'vue-i18n'
import PromptEditorModal from '../../prompts/PromptEditorModal.vue'
import PromptCard from '../../prompts/PromptCard.vue'
import {
    DocumentTextIcon,
    PlusIcon,
} from '@heroicons/vue/24/outline'

const props = defineProps<{
    agent: any
    /** 嵌入窄容器（workspace 面板）时置 true：布局用移动端规格（视口断点管不到容器宽度） */
    compact?: boolean
}>()

const promptState = usePromptState()
const toast = useToast()
const { confirm } = useConfirm()
const { t } = useI18n()

const prompts = ref<PromptInfo[]>([])
const loading = ref(false)

// Editor state
const showEditor = ref(false)
const editorMode = ref<'create' | 'edit'>('create')
const editorData = ref<{ id: string; name: string; description: string; content: string } | undefined>()
const saving = ref(false)

const loadPrompts = async () => {
    if (!props.agent?.id) return
    loading.value = true
    try {
        const result = await promptState.loadAgentPrompts(props.agent.id)
        prompts.value = result || []
    } finally {
        loading.value = false
    }
}

onMounted(loadPrompts)
watch(() => props.agent?.id, loadPrompts)

// ── Editor Actions ──

const openCreateEditor = () => {
    editorMode.value = 'create'
    editorData.value = undefined
    showEditor.value = true
}

const openEditEditor = (prompt: PromptInfo) => {
    editorMode.value = 'edit'
    editorData.value = {
        id: prompt.id,
        name: prompt.name,
        description: prompt.description || '',
        content: prompt.content,
    }
    showEditor.value = true
}

const closeEditor = () => {
    showEditor.value = false
}

const handleSave = async (data: { id: string; name: string; description: string; content: string }) => {
    saving.value = true
    try {
        await promptState.saveAgentPrompt(props.agent.id, data)
        toast.success(t('prompt.saveSuccess'))
        closeEditor()
        await loadPrompts()
    } catch (err: any) {
        toast.error(t('prompt.saveFailed', { error: err.message }))
    } finally {
        saving.value = false
    }
}

const handleDelete = async (prompt: PromptInfo) => {
    const confirmed = await confirm(t('prompt.deleteConfirm', { name: prompt.name }))
    if (!confirmed) return
    try {
        await promptState.deleteAgentPrompt(props.agent.id, prompt.id)
        toast.success(t('prompt.deleteSuccess'))
        await loadPrompts()
    } catch (err: any) {
        toast.error(t('prompt.deleteFailed', { error: err.message }))
    }
}

// Expanded state
const expandedPromptId = ref<string | null>(null)
const toggleExpand = (id: string) => {
    expandedPromptId.value = expandedPromptId.value === id ? null : id
}
</script>

<template>
    <div>
        <!-- Header -->
        <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold">{{ $t('prompt.agent') }}</h3>
            <button class="btn btn-sm btn-primary gap-1" @click="openCreateEditor">
                <PlusIcon class="w-4 h-4" />
                {{ $t('prompt.addPrompt') }}
            </button>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="flex justify-center py-8">
            <span class="loading loading-spinner loading-lg text-primary"></span>
        </div>

        <!-- Empty State -->
        <div v-else-if="!prompts.length" class="text-center py-12 text-base-content/50">
            <DocumentTextIcon class="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p>{{ $t('prompt.noAgentPrompts') }}</p>
        </div>

        <!-- Prompts List -->
        <div v-else class="grid grid-cols-1 gap-4" :class="compact ? '' : 'md:grid-cols-2'">
            <PromptCard v-for="prompt in prompts" :key="prompt.id" :prompt="prompt" :icon="DocumentTextIcon"
                variant="primary" :expanded="expandedPromptId === prompt.id" @toggle="toggleExpand(prompt.id)"
                @edit="openEditEditor(prompt)" @delete="handleDelete(prompt)" />
        </div>

        <!-- Editor Modal -->
        <PromptEditorModal :show="showEditor" :mode="editorMode" :prompt-data="editorData" :saving="saving"
            @close="closeEditor" @save="handleSave" />
    </div>
</template>
