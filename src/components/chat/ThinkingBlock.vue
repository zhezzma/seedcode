<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownRenderer from './MarkdownRenderer.vue'

/**
 * 思考过程（thinking）折叠块。
 *
 * 性能关键设计：
 * - 折叠时内容用 v-if 完全不挂载（DaisyUI collapse 仅视觉隐藏，内容仍会全量渲染，
 *   长思考历史每次进视口都触发 markdown-it 全量渲染，是页面卡顿的主因）。
 * - 流式进行中（streaming）展开时显示纯文本：文本增量 patch 几乎零成本，
 *   避免 MarkdownRenderer 对整个累积文本做 O(n²) 重渲；
 *   流结束后切换 MarkdownRenderer 一次性渲染，之后静态不再变化。
 *   定格判定数据驱动（useChatMessages.convertToBlocks）：块在流的 __liveBlocks
 *   集合里（曾收到 delta）→ 仍按直播处理；不在 → 已定格。
 *
 * streaming 与 active 分工（见 chat-attach 两标记注释）：
 * - streaming（__liveBlocks 多标记，不清除）= 渲染策略「曾增长过」，保守防抖；
 * - active（__activeBlock 单标记，覆盖式转移）= 标题三点动画「正在思考」——
 *   正文 delta 到达即灭，不等整条回复 message_end。
 */
const props = defineProps<{
    text: string
    /** 该思考块是否仍处于流式增长中（渲染策略：纯文本直播） */
    streaming?: boolean
    /** 该思考块是否正在思考中（最近 delta 落在它上）→ 标题三点动画亮；
     * 正文 delta 到达即熄（思考已结束），不等整条回复 message_end。
     * 与 streaming 分工见 chat-attach.markActiveStreamBlock */
    active?: boolean
}>()

const { t } = useI18n()
const expanded = ref(false)
// 直播容器引用：流式期间文本增长时自动跟随滚动
const liveElement = ref<HTMLElement | null>(null)

// 已知间隙（不修，记录在此）：多 phase 协议（thinking 的 message_end 后、下一 phase
// 首个事件前）存在秒级窗口：思考已随 message_end 固化进历史（两个标记随
// chatStream 置空消失，三点同步灭），下一 phase 到达后以新消息继续；
// 展开/渲染状态在此窗口内定格，下一个 block 到达后自动切回，内容无损。

const toggle = () => {
    expanded.value = !expanded.value
}

// 按住 Enter/Space（keydown 自动重复）不应连续翻转展开状态
const onToggleKeydown = (e: KeyboardEvent) => {
    if (e.repeat) return
    toggle()
}

// 用 rAF 合并一帧内的多次滚到底部：流式热路径每个 delta 都会走到这里，
// 若每 delta 直接读布局+写 scrollTop 会造成强制 reflow 且高频 delta 下重复滚动；
// rAF 回调天然合并同帧多次调度，一帧最多滚一次
let followRafId = 0
const scrollToBottom = () => {
    if (followRafId) return
    followRafId = requestAnimationFrame(() => {
        followRafId = 0
        const el = liveElement.value
        if (el) el.scrollTop = el.scrollHeight
    })
}

// 展开瞬间定位到最新内容：直播跟随本来就是"看最新"，从顶部看起不符合预期
watch(expanded, (open) => {
    if (open && props.streaming) {
        scrollToBottom()
    }
})

// 直播自动跟随：仅当用户停留在底部附近（<60px，与 SubagentTraceDrawer/useScrollManager
// 同阈值）才跟随；用户向上回看时不强制拉底，滚回底部后自动恢复跟随。
// 时序注意：本 watch 为 pre-flush，回调触发时 DOM 尚未插入最新文本，此刻测距才准确；
// 若在 nextTick 后（内容已长高）再测，恰好位于底部的用户会被误判为"不在底部"而停止跟随。
watch(() => props.text, () => {
    if (!props.streaming || !expanded.value) return
    const el = liveElement.value
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight >= 60) return
    scrollToBottom()
})
</script>

<template>
    <div class=" collapse  bg-base-200  overflow-hidden rounded-box"
        :class="{ 'collapse-open': expanded }">
        <!-- role=button 使键盘用户（Tab/Enter/Space）也能切换展开 -->
        <div role="button" tabindex="0" 
            class="collapse-title px-3 py-2 text-sm font-medium flex items-center gap-2 cursor-pointer select-none bg-base-200 "  
          :aria-expanded="expanded" @click="toggle" @keydown.enter.prevent="onToggleKeydown"
            @keydown.space.prevent="onToggleKeydown">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"
                stroke="currentColor" class="w-5 h-5">
                <path stroke-linecap="round" stroke-linejoin="round"
                    d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
            </svg>
            {{ t('chat.reasoning') }}
            <!-- 三点动画=「正在思考」（active：最近 delta 落在此块）；置于标题文字之后；
                 streaming 只表示渲染策略上的直播态（曾增长过），单 phase 协议下
                 正文输出期间它仍为 true——若用作三点判定会转到回复结束才灭 -->
            <span v-if="active" class="loading loading-dots loading-xs" aria-hidden="true"></span>
        </div>
        <!-- 折叠时内容完全不挂载，彻底避免 markdown 全量渲染 -->
        <div v-if="expanded" class="collapse-content">
            <!-- 流式中：纯文本直播（增量 patch 成本极低） -->
            <div v-if="streaming" ref="liveElement"
                class="opacity-80 text-sm  pt-2 whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto">
                {{ text }}
            </div>
            <!-- 已定格：markdown 一次性渲染，之后内容不变 -->
            <div v-else class="opacity-80 text-sm  pt-2 ">
                <MarkdownRenderer :content="text" />
            </div>
        </div>
    </div>
</template>
