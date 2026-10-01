<script lang="ts">
/**
 * 模块级别的高度缓存，按 item key 存储测量高度。
 * 在组件卸载/重新挂载时保持数据（如首页 v-if 切换导致组件销毁并重建）。
 * 必须放在 <script>（非 setup）中，才是真正的模块级别代码。
 */
const globalHeights: Record<string, number> = {}
</script>

<script setup lang="ts">
import {
    ref,
    computed,
    watch,
    onMounted,
    onBeforeUnmount,
    nextTick,
} from 'vue'
import type { DisplayMessage } from '../../composables/useChatMessages'
import type { BranchInfo } from './MessageBubble.vue'
import { computeBranchTailFlags } from '../../utils/chatBranchTail'
import MessageBubble from './MessageBubble.vue'

// ──────────────────────────────────────────────────────────────────────────
// 属性 / 事件
// ──────────────────────────────────────────────────────────────────────────
const props = defineProps<{
    messages: DisplayMessage[]
    isBusy: boolean
    scrollContainer: HTMLElement | null
    getBranchInfo: (msg: DisplayMessage) => BranchInfo | null
    /** 跳转定位闪光：与此 entryId 匹配的气泡短暂高亮（HomeView 定时清除） */
    flashEntryId?: string | null
}>()

const emit = defineEmits<{
    (e: 'copy', msg: DisplayMessage): void
    (e: 'read-aloud', msg: DisplayMessage): void
    (e: 'retry', msg: DisplayMessage): void
    (e: 'fork', msg: DisplayMessage): void
    (e: 'edit', msg: DisplayMessage, newText: string): void
    (e: 'navigate-branch', msg: DisplayMessage, dir: 'prev' | 'next'): void
}>()

// ──────────────────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────────────────
// 视口上下额外渲染的像素范围（缓冲区）
const OVERSCAN_PX = 1200
// 行底部内边距（替代 CSS gap，使 ResizeObserver 能测量完整高度）
const ROW_GAP = 16 // px，等同于 space-y-4 / gap-4
// 未测量消息的预估高度
const ESTIMATED_HEIGHT = 120 + ROW_GAP

// ──────────────────────────────────────────────────────────────────────────
// 状态
// ──────────────────────────────────────────────────────────────────────────
/**
 * 每个消息的测量高度（内容 + ROW_GAP 内边距），按 item key 索引。
 * 包装模块级缓存 globalHeights，提供 Vue 响应式能力。
 */
const heights = ref(globalHeights)

/** 当前已挂载的 item key 集合（在缓冲区窗口内的行） */
const visibleKeys = ref<Set<string>>(new Set())

/** 视口中心线命中的 item key（滚动跟随高亮用，见 activeEntryId） */
const activeKey = ref<string | null>(null)

/** 监听每个已挂载行的 ResizeObserver */
let ro: ResizeObserver | null = null

// key → DOM 元素的映射
const rowEls = new Map<string, HTMLElement>()

// ──────────────────────────────────────────────────────────────────────────
// 辅助方法
// ──────────────────────────────────────────────────────────────────────────
const itemKey = (msg: DisplayMessage, index: number) =>
    msg.entryId ?? `idx-${index}`

const getHeight = (key: string): number =>
    heights.value[key] ?? ESTIMATED_HEIGHT

const estimateTopForKey = (targetKey: string): number => {
    let top = 0
    for (const item of enrichedItems.value) {
        if (item.key === targetKey) return top
        top += getHeight(item.key)
    }
    return -1
}

// ──────────────────────────────────────────────────────────────────────────
// 增强后的消息列表
// ──────────────────────────────────────────────────────────────────────────
const enrichedItems = computed(() => {
    // 分支尾锚判定抽到 utils/chatBranchTail.ts 的纯函数：公式虽一行，但正确性是
    // 拓扑相关的（死胡同末项 / 续写分支 / 正常回合 / 排队尾 / 瞬态行各有期望值），
    // 独立导出后可逐拓扑表驱动断言，而不是在 SFC 里只能做源码字符串钉子。
    const branchTailFlags = computeBranchTailFlags(props.messages)
    return props.messages.map((msg, i) => ({
        msg,
        key: itemKey(msg, i),
        index: i,
        isLast: i === props.messages.length - 1,
        isBranchTail: branchTailFlags[i],
    }))
})

// ──────────────────────────────────────────────────────────────────────────
// 可见范围计算
// ──────────────────────────────────────────────────────────────────────────
const updateVisibleRange = () => {
    const container = props.scrollContainer

    if (!container) {
        // 容器尚未挂载 — 回退渲染全部
        visibleKeys.value = new Set(enrichedItems.value.map(i => i.key))
        return
    }

    const scrollTop = container.scrollTop
    const clientHeight = container.clientHeight
    const winTop = scrollTop - OVERSCAN_PX
    const winBottom = scrollTop + clientHeight + OVERSCAN_PX

    const next = new Set<string>()
    let accum = 0

    // 视口中心线的绝对 Y 坐标：落在哪条消息上，rail 的加粗短横就指向哪条
    const centerLine = scrollTop + clientHeight / 2
    let centerKey: string | null = null
    let closestDistance = Infinity

    for (const item of enrichedItems.value) {
        const h = getHeight(item.key)
        const top = accum
        const bottom = accum + h

        if (bottom > winTop && top < winBottom) {
            next.add(item.key)
        }

        // 视口中心命中的消息（尚未命中时取最近的一条，避免消息间隙/空档时丢失指示）
        const distance = centerLine >= top && centerLine < bottom
            ? 0
            : Math.min(Math.abs(centerLine - top), Math.abs(centerLine - bottom))
        if (distance < closestDistance) {
            closestDistance = distance
            centerKey = item.key
        }

        // 始终保持最后一条消息渲染（流式输出 / 加载指示器）
        if (item.isLast) next.add(item.key)

        accum += h
    }

    visibleKeys.value = next
    activeKey.value = centerKey
}

// ──────────────────────────────────────────────────────────────────────────
// ResizeObserver — 测量真实行高度
// ──────────────────────────────────────────────────────────────────────────
const setupRO = () => {
    ro = new ResizeObserver(entries => {
        let changed = false
        for (const entry of entries) {
            const key = (entry.target as any).__vl_key as string | undefined
            if (!key) continue

            // 使用 borderBoxSize（含内边距），使测量值等于行在布局中占据的完整垂直空间
            const newH =
                entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height

            if (newH > 0 && heights.value[key] !== newH) {
                heights.value[key] = newH
                changed = true
            }
        }
        if (changed) updateVisibleRange()
    })
}

const observeEl = (el: HTMLElement, key: string) => {
    ; (el as any).__vl_key = key
    ro?.observe(el)
}

const unobserveEl = (el: HTMLElement) => {
    ro?.unobserve(el)
}

// ──────────────────────────────────────────────────────────────────────────
// 模板 ref 回调（Vue 对每个 v-if 行调用）
// ──────────────────────────────────────────────────────────────────────────
const setRowRef = (key: string) => (el: Element | null) => {
    if (el instanceof HTMLElement) {
        rowEls.set(key, el)
        observeEl(el, key)
    } else {
        const old = rowEls.get(key)
        if (old) {
            unobserveEl(old)
            rowEls.delete(key)
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// 滚动容器绑定
// ──────────────────────────────────────────────────────────────────────────
const attachScroll = (el: HTMLElement | null) => {
    el?.addEventListener('scroll', updateVisibleRange, { passive: true })
}
const detachScroll = (el: HTMLElement | null) => {
    el?.removeEventListener('scroll', updateVisibleRange)
}

watch(
    () => props.scrollContainer,
    (newEl, oldEl) => {
        detachScroll(oldEl ?? null)
        attachScroll(newEl ?? null)
        nextTick(updateVisibleRange)
    }
)

// 消息列表变化时重新计算：长度或任何 key 变化
// （流式结束时最后一条消息的 key 从 idx-N 变为真实 entryId）
// 同时将旧 key 的测量高度迁移到新 key，保持位置准确。
let prevKeys: string[] = []
watch(
    () => enrichedItems.value.map(i => i.key),
    (newKeys) => {
        // 仅当长度相同且变化的 key 数量很少时才做高度迁移（流式重命名场景）。
        // 如果大量 key 变化（会话切换），跳过迁移以避免破坏已有的高度数据。
        if (prevKeys.length === newKeys.length) {
            const changedIndexes: number[] = []
            for (let i = 0; i < newKeys.length; i++) {
                if (prevKeys[i] !== newKeys[i]) {
                    changedIndexes.push(i)
                    if (changedIndexes.length > 2) break // 超过2个就不是 rename
                }
            }
            if (changedIndexes.length > 0 && changedIndexes.length <= 2) {
                for (const i of changedIndexes) {
                    const oldH = heights.value[prevKeys[i]]
                    if (oldH !== undefined) {
                        heights.value[newKeys[i]] = oldH
                        delete heights.value[prevKeys[i]]
                    }
                }
            }
        }
        prevKeys = newKeys
        nextTick(updateVisibleRange)
    }
)

// ──────────────────────────────────────────────────────────────────────────
// 生命周期
// ──────────────────────────────────────────────────────────────────────────
onMounted(() => {
    setupRO()
    attachScroll(props.scrollContainer)
    nextTick(updateVisibleRange)
})

/**
 * 视口中心当前命中的消息 entryId（滚动跟随高亮）。
 * 中心落在伪消息（streaming-pending / 压缩行，仅出现在列表末尾）上时，
 * 回退到之前最近一条有 entryId 的消息，避免流式期间 rail 丢失加粗指示。
 */
const activeEntryId = computed(() => {
    const items = enrichedItems.value
    const index = items.findIndex(item => item.key === activeKey.value)
    if (index < 0) return null
    for (let i = index; i >= 0; i--) {
        const entryId = items[i].msg.entryId
        if (entryId) return entryId
    }
    return null
})

const scrollToEntry = async (entryId: string): Promise<boolean> => {
    const container = props.scrollContainer
    if (!container) return false

    const item = enrichedItems.value.find(item => item.msg.entryId === entryId)
    if (!item) return false

    const estimatedTop = estimateTopForKey(item.key)
    if (estimatedTop < 0) return false

    container.scrollTop = Math.max(0, estimatedTop - container.clientHeight / 2 + getHeight(item.key) / 2)
    updateVisibleRange()
    await nextTick()

    const mountedRows = Array.from(container.querySelectorAll<HTMLElement>('[data-key]'))
    const row = rowEls.get(item.key) ?? mountedRows.find(el => el.dataset.key === item.key)
    if (!row) return true

    row.scrollIntoView({ block: 'center', inline: 'nearest' })
    return true
}

defineExpose({ scrollToEntry, activeEntryId })

onBeforeUnmount(() => {
    ro?.disconnect()
    ro = null
    detachScroll(props.scrollContainer)
})
</script>

<template>
    <!--
        每行是一个带 padding-bottom (= ROW_GAP) 的 div。
        ResizeObserver 使用 borderBoxSize，捕获内容 + 内边距，
        确保累计位置用于可见范围计算时的准确性。

        屏幕外的行用一个高度等于最后测量值的 spacer div 替代。
    -->
    <div class="virtual-message-list">
        <template v-for="item in enrichedItems" :key="item.key">
            <!-- 已挂载的行 -->
            <div v-if="visibleKeys.has(item.key)" :ref="setRowRef(item.key) as any" class="virtual-row" :data-key="item.key">
                <MessageBubble :message="item.msg" :is-loading="isBusy && item.isLast" :is-busy="isBusy"
                    :is-last-message="item.isLast"
                    :is-branch-tail="item.isBranchTail"
                    :flash="!!item.msg.entryId && item.msg.entryId === flashEntryId"
                    :branch-info="getBranchInfo(item.msg)" @copy="emit('copy', item.msg)"
                    @read-aloud="emit('read-aloud', item.msg)"
                    @retry="emit('retry', item.msg)" @fork="emit('fork', item.msg)"
                    @edit="(msg, text) => emit('edit', msg, text)"
                    @navigate-branch="(msg, dir) => emit('navigate-branch', msg, dir)" />
            </div>

            <!-- 占位符：行卸载时保持滚动高度稳定 -->
            <div v-else class="virtual-spacer" :data-key="item.key" :style="{ height: getHeight(item.key) + 'px' }" />
        </template>
    </div>
</template>

<style scoped>
.virtual-message-list {
    display: flex;
    flex-direction: column;
}

/*
  每行的 padding-bottom 形成行间距。
  使用 padding（而非 gap/margin），使 ResizeObserver 的 borderBoxSize
  能捕获行占据的完整垂直空间。
*/
.virtual-row {
    padding-bottom: 16px;
    /* ROW_GAP — 需与常量保持同步 */
}

.virtual-spacer {
    flex-shrink: 0;
}
</style>
