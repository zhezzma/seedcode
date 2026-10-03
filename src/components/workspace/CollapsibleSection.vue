<script setup lang="ts">
/**
 * VSCode 风格的可折叠 section：
 * - header 始终可见，点击 toggle；左侧 chevron + 标题 + 可选 count 徽章
 * - 可选 #actions slot：放右侧操作按钮（如 + 文件 / + 目录），与 toggle 按钮平级，
 *   点击不会触发 section 折叠/展开（不嵌在 toggle button 内，事件天然不冒泡）
 * - body 在 open 时固定高度（默认 240px）、内部独立滚动
 * - 可选 resizable：body 顶部渲染拖动 handle，向上拖增大高度；拖动期间本地
 *   dragHeight 实时刷新，mouseup 才 emit 一次 resize（父组件持久化），
 *   与 WorkspacePanel 宽度 splitter 同模式；上限按父容器高度动态 clamp
 * - 视觉风格匹配 daisyUI 主题；header 用 base-200 底色与 panel 区分
 *
 * 父组件持有 open 状态（受控），方便持久化到 settings store。
 */
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { ChevronRightIcon, ChevronDownIcon } from '@heroicons/vue/24/outline'

const props = withDefaults(defineProps<{
    title: string
    open: boolean
    /** 可选数量徽章（如提交数、文件数） */
    count?: number | null
    /** body 固定高度，单位 px。默认 240。 */
    maxHeight?: number
    /** 可选受控高度（px）：传入时优先于 maxHeight，配合 resizable 使用。 */
    height?: number | null
    /** 开启后 body 顶部渲染拖动 handle，拖动调整高度，mouseup 时 emit resize。 */
    resizable?: boolean
}>(), {
    count: null,
    maxHeight: 240,
    height: null,
    resizable: false,
})

const emit = defineEmits<{ toggle: [open: boolean]; resize: [height: number] }>()

// ── resizable 拖动 ─────────────────────────────────────────────
// 拖动期间用 dragHeight 驱动 UI（避免每帧 emit）；null 表示未在拖动。
const rootRef = ref<HTMLElement | null>(null)
const dragHeight = ref<number | null>(null)
let dragStartY = 0
let dragStartHeight = 0
/** 上方（RepoSelector + commit bar / 状态区）至少保留的空间。 */
const RESERVED_ABOVE = 160
/** 拖动高度下限；上限按父容器高度动态 clamp。 */
const MIN_RESIZE_HEIGHT = 100

const effectiveHeight = computed(() => dragHeight.value ?? props.height ?? props.maxHeight)
const bodyStyle = computed(() => ({ height: `${effectiveHeight.value}px` }))

/** 动态上限：父容器（tab 内容区）高度减去上方保留空间，避免把上面状态区完全挤没。 */
function clampHeight(h: number): number {
    const parentH = rootRef.value?.parentElement?.clientHeight ?? 0
    const max = parentH > 0 ? parentH - RESERVED_ABOVE : Infinity
    return Math.max(MIN_RESIZE_HEIGHT, Math.min(max, h))
}

function onResizeMouseDown(e: MouseEvent) {
    dragStartY = e.clientY
    dragStartHeight = effectiveHeight.value
    dragHeight.value = dragStartHeight
    document.body.style.cursor = 'row-resize'
    e.preventDefault()
}
function onMouseMove(e: MouseEvent) {
    if (dragHeight.value === null) return
    // handle 在区块顶部：鼠标向上 → 高度增加
    dragHeight.value = clampHeight(dragStartHeight + (dragStartY - e.clientY))
}
function onMouseUp() {
    if (dragHeight.value === null) return
    const h = dragHeight.value
    dragHeight.value = null
    document.body.style.cursor = ''
    if (h !== dragStartHeight) emit('resize', h)
}

function onHeaderClick() {
    emit('toggle', !props.open)
}

onMounted(() => {
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
})
onUnmounted(() => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    // 防 mid-drag 时组件被卸载（切 tab / 关面板）造成全局光标残留
    document.body.style.cursor = ''
})
</script>

<template>
    <div ref="rootRef" class="border-t border-base-300 shrink-0">
        <!-- header：toggle button + 可选 actions slot 平级；统一 bg-base-200/50 看上去是一行 -->
        <div class="flex items-stretch bg-base-300/50">
            <button type="button"
                class="flex-1 flex items-center gap-1 px-2 py-1.5 hover:bg-base-300 text-xs font-semibold uppercase tracking-wide text-base-content/70 select-none"
                @click="onHeaderClick">
                <ChevronDownIcon v-if="open" class="h-3.5 w-3.5 shrink-0" />
                <ChevronRightIcon v-else class="h-3.5 w-3.5 shrink-0" />
                <span class="flex-1 text-left truncate">{{ title }}</span>
                <span v-if="count !== null && count > 0"
                    class="text-[10px] font-mono normal-case text-base-content/50 shrink-0">
                    {{ count }}
                </span>
            </button>
            <div v-if="$slots.actions" class="flex items-center gap-0.5 pr-1 shrink-0">
                <slot name="actions" />
            </div>
        </div>
        <!-- 拖动 handle：仅 resizable 且展开时显示；向上拖增大 body 高度 -->
        <div v-if="resizable && open"
            class="h-1 cursor-row-resize hover:bg-primary/40 transition-colors shrink-0"
            :class="{ 'bg-primary/40': dragHeight !== null }" @mousedown="onResizeMouseDown" />
        <div v-if="open" class="overflow-y-auto" :style="bodyStyle">
            <slot />
        </div>
    </div>
</template>
