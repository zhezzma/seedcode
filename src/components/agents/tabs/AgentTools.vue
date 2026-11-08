<script setup lang="ts">
import { watch, computed, ref, nextTick, onMounted, onBeforeUnmount } from 'vue'
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

// ---- 自定义 tooltip ----
// daisyUI 的 CSS tooltip 以卡片为中心悬浮（宽至 20rem），在窄卡片/窄容器上必然伸出边界、
// 撑出横向/纵向滚动。改为 JS 定位：气泡 Teleport 到 body，position:fixed，
// 按触发卡片矩形计算坐标并钳制在视口内——永不产生滚动溢出，内容完整可读，尺寸不受卡片限制。
const tip = ref<{ tool: any; x: number; y: number; ready: boolean } | null>(null)
const tipEl = ref<HTMLElement | null>(null)
let tipSeq = 0 // 序号令牌：快速划过/开关时丢弃过期的异步定位结果

const TIP_GAP = 8    // 气泡与卡片的间距
const TIP_MARGIN = 8 // 气泡距视口边缘的最小留白

const hideTip = () => {
    tipSeq++
    tip.value = null
}

const showTip = async (trigger: HTMLElement, tool: any) => {
    const seq = ++tipSeq
    tip.value = { tool, x: 0, y: 0, ready: false } // 先以隐藏态渲染，才能测得气泡实际尺寸
    await nextTick()
    const el = tipEl.value
    if (seq !== tipSeq || !el) return

    const rect = trigger.getBoundingClientRect()
    const bw = el.offsetWidth
    const bh = el.offsetHeight

    // 水平：对准卡片中心，钳制在视口内
    let x = rect.left + rect.width / 2 - bw / 2
    x = Math.min(Math.max(x, TIP_MARGIN), window.innerWidth - TIP_MARGIN - bw)
    // 垂直：优先放上方，放不下翻到下方，仍放不下则贴边钳制
    let y = rect.top - bh - TIP_GAP
    if (y < TIP_MARGIN) y = rect.bottom + TIP_GAP
    if (y + bh > window.innerHeight - TIP_MARGIN) y = Math.max(TIP_MARGIN, window.innerHeight - TIP_MARGIN - bh)

    if (seq !== tipSeq) return
    tip.value = { tool, x: Math.round(x), y: Math.round(y), ready: true }
}

const onCardEnter = (e: PointerEvent, tool: any) => {
    if (e.pointerType === 'touch') return // 触屏走 pointerdown 开关，见 onCardDown
    if (tip.value?.tool === tool) return
    showTip(e.currentTarget as HTMLElement, tool)
}

const onCardLeave = (e: PointerEvent) => {
    // 触屏抬指后立即派发 pointerleave，会秒关点按展开的气泡，必须忽略
    if (e.pointerType === 'touch') return
    hideTip()
}

const onCardDown = (e: PointerEvent, tool: any) => {
    if (e.pointerType !== 'touch') return
    if ((e.target as HTMLElement).closest('label, input, button')) return // 点开关本身不展开气泡
    if (tip.value?.tool === tool) hideTip()
    else showTip(e.currentTarget as HTMLElement, tool)
}

const onCardFocusIn = (e: FocusEvent, tool: any) => {
    if (tip.value?.tool === tool) return
    showTip(e.currentTarget as HTMLElement, tool)
}

const onCardFocusOut = () => hideTip()

// 点气泡/卡片之外时关闭（触屏没有 hover-out，全靠这个兜底）
const onDocPointerDown = (e: PointerEvent) => {
    if (!tip.value) return
    const target = e.target as Element | null
    if (target?.closest('.agent-tool-card')) return
    hideTip()
}

// 滚动/改窗口尺寸后卡片位置已失效，直接关闭
const onViewportChange = () => hideTip()

onMounted(() => {
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('scroll', onViewportChange, true) // capture：捕获嵌套滚动容器的滚动
    window.addEventListener('resize', onViewportChange)
})

onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onDocPointerDown, true)
    document.removeEventListener('scroll', onViewportChange, true)
    window.removeEventListener('resize', onViewportChange)
    hideTip()
})
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
                class="agent-tool-card card bg-base-200 border border-base-300 shadow-sm hover:shadow-md transition-all h-full"
                @pointerenter="onCardEnter($event, tool)"
                @pointerleave="onCardLeave"
                @pointerdown="onCardDown($event, tool)"
                @focusin="onCardFocusIn($event, tool)"
                @focusout="onCardFocusOut">
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

        <!-- 自定义 tooltip：Teleport 到 body + fixed 定位，实现见脚本区注释 -->
        <Teleport to="body">
            <Transition name="tip-fade">
                <div v-if="tip" ref="tipEl" class="agent-tools-tip"
                    :style="{ left: `${tip.x}px`, top: `${tip.y}px`, visibility: tip.ready ? 'visible' : 'hidden' }">
                    <div class="font-bold">{{ tip.tool.name }}</div>
                    <div v-if="tip.tool.description" class="opacity-80">{{ tip.tool.description }}</div>
                </div>
            </Transition>
        </Teleport>
    </div>
</template>

<style scoped>
/* 自定义气泡（Teleport 到 body，fixed 定位）：不占文档流、不产生滚动溢出，视口钳制在 JS 里做 */
.agent-tools-tip {
    position: fixed;
    z-index: 9999;
    max-width: min(20rem, calc(100vw - 1rem));
    /* 超长描述兜底裁剪；pointer-events:none 下内部滚动无意义，故不用 overflow-y:auto */
    max-height: calc(100vh - 1rem);
    max-height: calc(100dvh - 1rem);
    overflow: hidden;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-field);
    background-color: var(--color-neutral);
    color: var(--color-neutral-content);
    font-size: 0.75rem;
    line-height: 1.1rem;
    text-align: left;
    white-space: pre-wrap;
    /* 工具名常见 mcp__a__b 这类无空格长 token，pre-wrap 只认空格换行，需允许词内断行 */
    overflow-wrap: anywhere;
    box-shadow: 0 6px 16px rgb(0 0 0 / 0.25);
    /* 关键：不拦截命中测试。若气泡可命中且悬在卡片上方，鼠标移入会触发卡片 pointerleave
       → 气泡消失 → 又触发 pointerenter → 闪烁死循环 */
    pointer-events: none;
}

.tip-fade-enter-active,
.tip-fade-leave-active {
    transition: opacity 0.15s ease;
}

.tip-fade-enter-from,
.tip-fade-leave-to {
    opacity: 0;
}
</style>
