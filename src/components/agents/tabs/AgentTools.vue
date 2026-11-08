<script setup lang="ts">
import { watch, computed, ref } from 'vue'
import { useAgentsState } from '@/composables/useAgentsState'
import { CommandLineIcon, ShieldCheckIcon, ShieldExclamationIcon } from '@heroicons/vue/24/outline'

// Props
const props = defineProps<{
    agent: any
    /** 嵌入窄容器（workspace 面板）时置 true：网格固定移动端规格 2 列。
     *  视口断点管不到容器宽度：桌面开面板时 lg:grid-cols-5 仍生效，5 卡挤在窄面板里只剩 60px/张 */
    compact?: boolean
}>()

const agentsState = useAgentsState()

watch(() => props.agent?.id, (newId) => {
    if (newId) {
        agentsState.loadAgentTools(newId)
    }
}, { immediate: true })

const tools = computed(() => {
    if (!props.agent?.id) return []
    return agentsState.agentTools[props.agent.id] || []
})

const loading = computed(() => {
    if (!props.agent?.id) return false
    return agentsState.agentToolsBusy[props.agent.id] || false
})

const toggling = ref<Record<string, boolean>>({})

const toggleTool = async (toolName: string, currentState: boolean) => {
    if (!props.agent?.id) return

    toggling.value[toolName] = true
    try {
        await agentsState.toggleAgentTool(props.agent.id, toolName, currentState)
    } finally {
        toggling.value[toolName] = false
    }
}

const getTooltipTip = (tool: any) => {
    let tip = `${tool.name}\n${tool.description || ''}`

    // if (tool.parameters?.properties) {
    //     tip += '\n\nParameters:'
    //     for (const key in tool.parameters.properties) {
    //         const prop = tool.parameters.properties[key]
    //         tip += `\n• ${key}: ${prop.description || ''}`
    //     }
    // }
    return tip
}
</script>

<template>
    <div class="h-full flex flex-col">
        <div v-if="loading && !tools.length" class="flex justify-center p-8">
            <span class="loading loading-spinner loading-lg text-primary"></span>
        </div>

        <div v-else-if="!tools.length" class="text-center p-8 text-base-content/50">
            {{ $t('agent.noTools') || 'No tools available' }}
        </div>

        <div v-else class="grid grid-cols-2 gap-4 p-1"
            :class="compact ? '' : 'sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'">
            <div v-for="tool in tools" :key="tool.name"
                class="card bg-base-200 border border-base-300 shadow-sm hover:shadow-md transition-all h-full tooltip tooltip-top"
                :data-tip="getTooltipTip(tool)">
                <div class="card-body p-4 flex flex-col items-center text-center gap-2">
                    <!-- Icon -->
                    <div class="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 mb-1 transition-colors"
                        :class="tool.denied ? 'bg-base-300 text-base-content/30' : 'bg-primary/10 text-primary'">
                        <CommandLineIcon class="w-6 h-6" />
                    </div>

                    <!-- Content -->
                    <div class="w-full min-w-0 flex-1 flex flex-col items-center">
                        <h3 class="font-bold text-sm truncate w-full" :title="tool.name">{{ tool.name }}</h3>
                        <div class="flex items-center gap-1 mt-1 justify-center">
                            <span class="w-2 h-2 rounded-full"
                                :class="tool.denied ? 'bg-base-300' : 'bg-success'"></span>
                            <span class="text-xs text-base-content/60">
                                {{ tool.denied ? $t('agent.toolDenied') : $t('agent.toolActive') }}
                            </span>
                        </div>
                    </div>

                    <!-- Action -->
                    <div class="card-actions w-full justify-center mt-2 pt-2 border-t border-base-300">
                        <label class="label cursor-pointer gap-2 p-0">
                            <span class="label-text text-xs text-base-content/40 font-mono">{{ tool.denied ? 'OFF' :
                                'ON' }}</span>
                            <input type="checkbox" class="toggle toggle-success toggle-xs" :checked="!tool.denied"
                                :disabled="toggling[tool.name]" @change="toggleTool(tool.name, tool.denied)" />
                        </label>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* 气泡做成覆盖卡片本体的 overlay（inset:0）：严格限制在卡片四边内，
   不再向上/下/左/右伸出，任何滚动容器（页面 / workspace 窄面板）都不会被撑出滚动条 */
.tooltip:before {
    inset: 0;
    /* 覆盖 daisyUI 的 width:max-content：left/right/width 同设时 width 会赢，气泡重新变宽溢出 */
    width: auto;
    /* 覆盖 tooltip-top 的 translateX(-50%) 居中位移，否则 inset:0 后气泡被平移半个卡宽 */
    transform: none;
    border-radius: inherit;
    white-space: pre-wrap;
    text-align: left;
    /* 工具名常见 mcp__a__b 这类无空格长 token，pre-wrap 只认空格换行，需允许词内断行 */
    overflow-wrap: anywhere;
    /* 长描述按 6 行截断省略，兜底防止文字超过卡片高度向下溢出 */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    overflow: hidden;
    font-size: 0.75rem;
    line-height: 1.1rem;
    z-index: 1000;
}

/* overlay 模式下箭头无意义，且会伸出卡片上缘，隐藏 */
.tooltip:after {
    display: none;
}
</style>
