<script setup lang="ts">
/**
 * 子代理轨迹抽屉：实时查看 + 刷新恢复重放。
 *
 * 数据流：GET /api/extensions/subagents/sessions/:parentSessionId/subagents/:subId?offset=N
 * 增量拉取落盘 jsonl（subagents 扩展写入），entries 只增不删，offset 累计即可。
 *
 * 渲染：与主会话共用同一套组件与转换器——entries → DisplayMessage[]（复用
 * useChatMessages 的 createContentConverter + toolResult 合并规则），再交给
 * MessageBubble 渲染。样式（气泡/thinking 折叠/ToolInvocation 卡片）与交互
 * （工具展开、路径按钮、markdown、复制、朗读）与主聊天完全一致。
 * 构造的 DisplayMessage 不带 entryId → MessageBubble 的编辑/重试/删除按钮自动隐藏。
 *
 * 轮询策略：抽屉打开期间持续轮询，间隔自适应——有增长立即回到 1.5s，
 * 无增长逐步退避到 8s 封顶（无需感知子代理运行状态；关闭抽屉即停）。
 *
 * 布局：桌面右侧滑入面板；移动端（<sm）底部 sheet（拖拽条/遮罩点击关闭）。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { XMarkIcon } from '@heroicons/vue/24/outline'
import { apiGet, ApiError } from '../../composables/api-client'
import { i18n } from '../../i18n'
import { useSubagentTrace, type SubagentTraceTarget } from '../../composables/useSubagentTrace'
import { createContentConverter, type DisplayMessage, type DisplayBlock } from '../../composables/useChatMessages'
import { useTTS } from '../../composables/useTTS'
import { writeClipboard } from '../../utils/clipboard'
import MessageBubble from './MessageBubble.vue'

const trace = useSubagentTrace()
const { currentReadingMsgId, readAloud: ttsReadAloud } = useTTS()

// ─── Tab（每个有 subagentSessionId 的子代理一个）───
const tabs = computed(() => {
    const t: SubagentTraceTarget | null = trace.current.value
    if (!t) return []
    return t.results.filter((r: any) => r?.subagentSessionId)
})
const activeSubId = ref('')
// activeSubId 的定位由下方主 watcher（trace.current）统一负责，不再另设 watcher：
// 两个 watcher 同时写 activeSubId 会在打开抽屉时触发两次 reload，
// 双 poll 并发导致 entries 重复追加、offset 游标翻倍（增量从此错位）。

const activeResult = computed(() => tabs.value.find((r: any) => r.subagentSessionId === activeSubId.value))

// 活跃子代理（状态非终态）：正在直播的轨迹尾块思考走纯文本（is-loading 透传给
// MessageBubble → ThinkingBlock），不做 markdown 全量重渲——抽屉 1.5s 轮询一次，
// markdown 分支会随思考文本增长每次全量双渲染，是抽屉卡顿主因
const traceActive = computed(() => {
    const r = activeResult.value as any
    return !!r && r.status !== 'completed' && r.status !== 'error' && r.status !== 'aborted'
})

// ─── 轨迹数据与轮询 ───
interface TraceEntry {
    type: string
    id: string
    timestamp?: string
    message?: {
        role: string
        content?: any[]
        toolCallId?: string
        toolName?: string
        isError?: boolean
        errorMessage?: string
        details?: any
    }
    [k: string]: any
}

const entries = ref<TraceEntry[]>([])
const loading = ref(false)
const loadError = ref('')
const containerRef = ref<HTMLElement | null>(null)
/** 用户是否在底部附近（决定是否自动滚动跟随新内容） */
const followTail = ref(true)

let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollDelay = 1500
/** 最近一次轮询错误的 HTTP 状态码（0 = 非 HTTP 错误），用于 404 友好提示 */
const lastErrorStatus = ref(0)
/**
 * 轮询代际号：reload / 关闭抽屉 / 组件卸载时递增，作废在途请求与旧轮询链。
 * stopPolling 只能清定时器，作废不了已发出的 fetch——不校验的话，切 tab 时
 * 旧响应晚到会把上一个 tab 的 entries 追加进当前列表并污染 offset 游标。
 */
let pollEpoch = 0
/**
 * 服务端游标：已消费的非 header entry 总数。必须采用服务端返回的 total，不能用
 * 本地 entries.length——服务端 offset 按全部 entry（含 compaction/label 等非消息
 * 条目）计数，本地只保留 message 类型，用 length 计数会游标偏小 → 重复拉取甚至停滞。
 */
let traceOffset = 0

async function poll() {
    const t = trace.current.value
    const subId = activeSubId.value
    if (!t || !subId) return
    const epoch = pollEpoch
    try {
        const res = await apiGet<any>(
            `/api/extensions/subagents/sessions/${t.parentSessionId}/subagents/${subId}?offset=${traceOffset}`,
            true // 轮询静默：失败由内联 loadError 呈现，不弹全局 toast（持续出错时避免刷屏）
        )
        // 代际已过（切 tab / 重开 / 关闭 / 卸载）：丢弃响应且不再续链，新链由 reload 发起
        if (epoch !== pollEpoch || t !== trace.current.value || subId !== activeSubId.value) return
        loadError.value = ''
        lastErrorStatus.value = 0
        // 服务端权威游标（全部非 header entry 数），覆盖被过滤掉的非消息条目
        if (typeof res.total === 'number') traceOffset = res.total
        if (res.entries?.length) {
            // 只保留可渲染的消息 entry；其余（compaction/label 等）跳过——游标已按 total 前进，不会重复
            const renderable = res.entries.filter((e: TraceEntry) => e.type === 'message')
            if (renderable.length) {
                entries.value.push(...renderable)
                pollDelay = 1500 // 有增长：立即恢复快轮询
                if (followTail.value) {
                    await nextTick()
                    containerRef.value?.scrollTo({ top: containerRef.value.scrollHeight })
                }
            }
        } else {
            // 无增长：退避
            pollDelay = Math.min(pollDelay * 2, 8000)
        }
    } catch (e: any) {
        if (epoch !== pollEpoch || t !== trace.current.value || subId !== activeSubId.value) return
        // 主 session 删除后目录级联清理 / 服务不可达：显示并退避
        loadError.value = e?.message || (i18n.global as any).t('subagentTrace.loadFailed')
        lastErrorStatus.value = e instanceof ApiError ? e.code : 0
        pollDelay = Math.min(pollDelay * 2, 8000)
    }
    // await 挂起期间代际可能已变（如 nextTick 后切 tab）：旧链不复活，避免与新链并发双写
    if (epoch !== pollEpoch) return
    scheduleNext()
}

function scheduleNext() {
    stopPolling()
    if (trace.current.value) {
        pollTimer = setTimeout(poll, pollDelay)
    }
}

function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
}

/** 切 tab / 打开：清空重放（清状态后立即拉一次，后续进入轮询循环） */
async function reload() {
    stopPolling()
    pollEpoch++ // 作废在途请求与旧轮询链
    entries.value = []
    traceOffset = 0
    // 全局 surface 注册表会被会话切换 clearAllSurfaces 清空，持久 Set 若不同步清理
    // 会与全局表脱同步（has 为真但表里没有 → a2ui 面板不再重建）；重放即重建，安全
    renderedSurfaceIds.clear()
    loadError.value = ''
    lastErrorStatus.value = 0
    followTail.value = true
    pollDelay = 1500
    loading.value = true
    await poll()
    loading.value = false
}

/** 打开/重开抽屉：定位目标 tab。同 tab 重开时 watch(activeSubId) 不触发，需手动重放 */
watch(() => trace.current.value, (t) => {
    if (!t) {
        pollEpoch++
        stopPolling()
        entries.value = [] // 释放大轨迹内存
        return
    }
    const target = t.activeSubId || tabs.value[0]?.subagentSessionId || ''
    if (activeSubId.value === target) reload()
    else activeSubId.value = target // 变化则由 watch(activeSubId) 负责重放
}, { immediate: true })

/** 切 tab：清空重放 */
watch(activeSubId, () => reload())

/** 组件卸载（HomeView 是路由组件，切页面会连带卸载）：停轮询并作废在途请求。
 *  否则裸 setTimeout 链在 watcher 全停后仍会无限轮询，重挂载时再叠出第二条链。 */
onUnmounted(() => {
    pollEpoch++
    stopPolling()
})

/** 用户滚动：离底则暂停跟随，回到底部恢复 */
function onScroll() {
    const el = containerRef.value
    if (!el) return
    followTail.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

// ─── entries → DisplayMessage[]（与主会话 processedMessages 同规则）───
// 转换器生命周期跟随抽屉模块；renderedSurfaceIds 持久（surface 幂等更新），
// 但 reload 时会 clear（见 reload 注释）与全局 surface 注册表重新对齐
const renderedSurfaceIds = new Set<string>()
const converter = createContentConverter(renderedSurfaceIds)

const displayMessages = computed<DisplayMessage[]>(() => {
    const out: DisplayMessage[] = []
    for (const e of entries.value) {
        const m = e.message
        if (!m) continue

        // toolResult：不作为独立气泡，合并回对应 toolCall block（同主会话 1.1 规则）
        if (m.role === 'toolResult') {
            const target = findToolBlock(out, m.toolCallId)
            if (target) {
                target.toolResult = m.content
                if (m.details) target.toolDetails = m.details
                // 错误判定与主会话同规则：isError 之外还看 details.status
                let isError = false
                let errorMsg = ''
                if (m.isError) {
                    isError = true
                    errorMsg = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
                } else if (m.details?.status === 'error') {
                    isError = true
                    errorMsg = m.details.error || 'Unknown error'
                }
                if (isError) {
                    target.toolState = 'error'
                    target.toolError = errorMsg
                } else if (!target.toolState || target.toolState === 'calling') {
                    target.toolState = 'success'
                }
            }
            continue
        }

        if (m.role !== 'user' && m.role !== 'assistant') continue
        const blocks: DisplayBlock[] = converter(m.content)
        // 顶级错误信息（message_end error 原文）与主会话同样追加 error block
        if (m.errorMessage) blocks.push({ type: 'error', error: m.errorMessage })
        if (blocks.length > 0) {
            out.push({
                id: e.id,
                role: m.role,
                blocks,
                timestamp: e.timestamp ? new Date(e.timestamp).getTime() : undefined,
            })
        }
    }
    return out
})

/** 反向查找 toolCallId 对应的 tool block（toolResult 总是紧跟其调用之后）。
 *  与主会话 toolCallRegistry 同语义：按 id 合并，不看块当前状态 */
function findToolBlock(msgs: DisplayMessage[], toolCallId?: string): DisplayBlock | null {
    if (!toolCallId) return null
    for (let i = msgs.length - 1; i >= 0; i--) {
        for (let j = msgs[i].blocks.length - 1; j >= 0; j--) {
            const b = msgs[i].blocks[j]
            if (b.type === 'tool' && b.toolCallId === toolCallId) return b
        }
    }
    return null
}

// ─── 消息操作（与 HomeView 同实现）───
function copyMessage(msg: DisplayMessage) {
    const text = msg.blocks
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n')
    writeClipboard(text)
}

function readAloud(msg: DisplayMessage) {
    const text = msg.blocks
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n')
    ttsReadAloud(msg.id, text)
}

function statusBadge(r: any): { label: string; cls: string } {
    switch (r?.status) {
        case 'completed': return { label: '已完成', cls: 'badge-success' }
        case 'error': return { label: '出错', cls: 'badge-error' }
        case 'aborted': return { label: '已中止', cls: 'badge-error' }
        case 'thinking': return { label: '思考中', cls: 'badge-info' }
        case 'tool_running': return { label: '执行工具', cls: 'badge-warning' }
        case 'initializing': return { label: '初始化', cls: 'badge-ghost' }
        default: return { label: '运行中', cls: 'badge-ghost' }
    }
}

function close() { trace.close() }
</script>

<template>
    <Teleport to="body">
        <!-- 遮罩：移动端 + 桌面统一交互，点击任意非面板区域均可关闭抽屉 -->
        <div v-if="trace.isActive.value" class="fixed inset-0 z-40 app-backdrop"
            @click="close()" />

        <Transition enter-active-class="transition-transform duration-200 ease-out"
            leave-active-class="transition-transform duration-150 ease-in"
            enter-from-class="max-sm:translate-y-full sm:translate-x-full"
            leave-to-class="max-sm:translate-y-full sm:translate-x-full">
            <div v-if="trace.isActive.value"
                class="fixed z-50 bg-base-100 border border-base-300 shadow-2xl flex flex-col
                       inset-x-0 bottom-0 h-[85vh] rounded-t-2xl
                       sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:w-[520px] sm:rounded-none sm:border-l">

                <!-- Header：移动端以拖拽条作为关闭热区（桌面点标题不关闭，防误触） -->
                <div class="flex-none px-4 pt-3 pb-2 border-b border-base-300 bg-base-200/50">
                    <div class="sm:hidden mx-auto mb-2 h-1 w-10 cursor-pointer rounded-full bg-base-content/20"
                        @click="close()"></div>
                    <div class="flex items-center gap-2">
                        <div class="text-sm font-semibold text-base-content/80 flex-1">{{ $t('subagentTrace.title') }}</div>
                        <button class="btn btn-ghost btn-sm btn-circle" @click.stop="close()">
                            <XMarkIcon class="w-4 h-4" />
                        </button>
                    </div>
                    <!-- Tab：并行/chain 多子代理切换 -->
                    <div v-if="tabs.length > 0" class="flex gap-1 mt-2 overflow-x-auto">
                        <button v-for="r in tabs" :key="r.subagentSessionId"
                            class="btn btn-xs font-mono shrink-0"
                            :class="activeSubId === r.subagentSessionId ? 'btn-primary' : 'btn-ghost text-base-content/60'"
                            @click="activeSubId = r.subagentSessionId">
                            {{ r.agent }}
                        </button>
                    </div>
                    <!-- 状态徽标行 -->
                    <div v-if="activeResult" class="flex items-center gap-2 flex-wrap mt-2 text-xs text-base-content/50">
                        <span class="badge badge-sm" :class="statusBadge(activeResult).cls">{{ statusBadge(activeResult).label }}</span>
                        <span v-if="activeResult.model" class="font-mono">{{ activeResult.model }}</span>
                        <span v-if="Number(activeResult.usage?.turns) > 0">Turn {{ activeResult.usage.turns }}</span>
                    </div>
                </div>

                <!-- 轨迹内容：与主会话同款 MessageBubble -->
                <div ref="containerRef" class="flex-1 overflow-y-auto px-3 py-3" @scroll.passive="onScroll">

                    <div v-if="loadError" class="text-xs text-error bg-error/10 rounded p-2 mb-2">
                        {{ loadError }}<template v-if="lastErrorStatus === 404">{{ $t('subagentTrace.cleaned') }}</template>
                    </div>

                    <div v-if="loading && entries.length === 0" class="flex justify-center py-8">
                        <span class="loading loading-spinner loading-sm text-primary"></span>
                    </div>

                    <div v-if="!loading && entries.length === 0 && !loadError" class="text-center text-xs text-base-content/40 py-8">
                        {{ $t('subagentTrace.empty') }}
                    </div>

                    <MessageBubble v-for="(m, mi) in displayMessages" :key="m.id" :message="m"
                        :is-busy="traceActive"
                        :is-loading="traceActive && mi === displayMessages.length - 1"
                        :agent-name="activeResult?.agent" @copy="copyMessage" @read-aloud="readAloud" />
                </div>
            </div>
        </Transition>
    </Teleport>
</template>
