<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckIcon, MagnifyingGlassIcon } from '@heroicons/vue/24/outline'

interface ModelOption {
    id: string
    name: string
}

interface ModelGroup {
    provider: string
    models: ModelOption[]
}

const props = withDefaults(defineProps<{
    availableModels: ModelGroup[]
    currentModel: string
    title?: string
    searchPlaceholder?: string
    showUnknownCurrent?: boolean
    unknownCurrentLabel?: string
}>(), {
    showUnknownCurrent: true,
})

const emit = defineEmits<{
    (e: 'select', modelId: string): void
}>()

const { t } = useI18n()

const searchText = ref('')

const resolvedTitle = computed(() => props.title || t('provider.selectModel'))
const resolvedSearchPlaceholder = computed(() => props.searchPlaceholder || t('provider.searchModels'))
const resolvedUnknownCurrentLabel = computed(() => props.unknownCurrentLabel || t('agent.unknownModel'))

const currentModelLabel = computed(() => {
    if (!props.currentModel) return ''
    for (const group of props.availableModels) {
        const matched = group.models.find((m) => `${group.provider}/${m.id}` === props.currentModel)
        if (matched) return `${group.provider} / ${matched.name}`
    }
    return props.currentModel
})

const normalizedQuery = computed(() => searchText.value.trim().toLowerCase())
const filteredGroups = computed(() => {
    const query = normalizedQuery.value
    if (!query) return props.availableModels

    return props.availableModels
        .map((group) => {
            const providerLower = group.provider.toLowerCase()
            return {
                provider: group.provider,
                models: group.models.filter((m) => {
                    const fullId = `${providerLower}/${m.id.toLowerCase()}`
                    return fullId.includes(query) || m.name.toLowerCase().includes(query)
                })
            }
        })
        .filter((group) => group.models.length > 0)
})

const isCurrentModelAvailable = computed(() => props.availableModels.some((group) =>
    group.models.some((m) => `${group.provider}/${m.id}` === props.currentModel)
))

const unknownCurrent = computed(() => {
    if (!props.showUnknownCurrent || !props.currentModel || isCurrentModelAvailable.value) {
        return null
    }

    const query = normalizedQuery.value
    if (query && !props.currentModel.toLowerCase().includes(query)) {
        return null
    }

    return props.currentModel
})

const emitSelect = (provider: string, modelId: string) => emit('select', `${provider}/${modelId}`)

const scrollContainerRef = ref<HTMLElement | null>(null)

onMounted(() => {
    // 用 requestAnimationFrame 而非 nextTick：等待父组件动态 maxHeight 样式应用后再读取布局，
    // 避免 AgentSubagents 等用 nextTick 延迟设置面板高度时出现时序竞争导致首次滚动失效。
    requestAnimationFrame(() => {
        const container = scrollContainerRef.value
        if (!container) return
        const item = container.querySelector<HTMLElement>('[data-current]')
        if (!item) return
        const containerRect = container.getBoundingClientRect()
        const itemRect = item.getBoundingClientRect()
        const offsetWithin = itemRect.top - containerRect.top
        const target = container.scrollTop + offsetWithin - (container.clientHeight - itemRect.height) / 2
        container.scrollTop = Math.max(0, Math.min(target, container.scrollHeight - container.clientHeight))
    })
})
</script>

<template>
    <div class="flex max-h-full min-h-0 flex-col">
        <div class="sticky top-0 z-20 bg-base-100">
            <div class="px-4 pt-2 pb-1 flex items-center justify-between gap-2">
                <span class="text-xs opacity-50 font-bold uppercase tracking-wider shrink-0">{{ resolvedTitle }}</span>
                <span v-if="currentModelLabel" class="text-xs text-primary font-medium truncate min-w-0 text-right"
                    :title="currentModelLabel">
                    {{ currentModelLabel }}
                </span>
            </div>

            <div class="px-2 pb-2">
                <div class="relative">
                    <input v-model="searchText" type="text" :placeholder="resolvedSearchPlaceholder"
                        class="input input-sm input-bordered w-full pl-8" />
                    <MagnifyingGlassIcon class="w-4 h-4 absolute left-2.5 top-2.5 opacity-50" />
                </div>
            </div>
        </div>

        <div ref="scrollContainerRef" class="min-h-0 overflow-y-auto px-2 pb-2">
            <div class="space-y-1">
                <button v-if="unknownCurrent" @click="emit('select', unknownCurrent)"
                    class="flex items-center gap-2 p-2 rounded-lg transition-colors cursor-pointer w-full text-left bg-primary/10 text-primary">
                    <span class="truncate block text-xs flex-1 min-w-0" :title="unknownCurrent">
                        {{ unknownCurrent }}
                        <span class="opacity-60">({{ resolvedUnknownCurrentLabel }})</span>
                    </span>
                    <CheckIcon class="h-4 w-4 shrink-0" />
                </button>

                <template v-for="group in filteredGroups" :key="group.provider">
                    <div class="px-4 py-1 text-[10px] uppercase tracking-wider bg-base-200/50 mb-1 font-bold block sticky top-0 backdrop-blur-md z-10">
                        {{ group.provider }}
                    </div>
                    <button v-for="m in group.models" :key="m.id" @click="emitSelect(group.provider, m.id)"
                        :data-current="currentModel === `${group.provider}/${m.id}` ? '' : null"
                        class="flex items-center gap-2 p-2 rounded-lg hover:bg-base-content/10 transition-colors cursor-pointer w-full text-left"
                        :class="{ 'bg-primary/10 text-primary': currentModel === `${group.provider}/${m.id}` }">
                        <span class="truncate block text-xs flex-1 min-w-0" :title="m.name">
                            {{ m.name }}
                        </span>
                        <CheckIcon v-if="currentModel === `${group.provider}/${m.id}`" class="h-4 w-4 shrink-0" />
                        <span v-else class="w-4 h-4 shrink-0"></span>
                    </button>
                </template>
            </div>
        </div>
    </div>
</template>
