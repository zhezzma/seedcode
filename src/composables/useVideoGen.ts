// src/composables/useVideoGen.ts
// 视频生成状态条的数据源（seedagent extensions/video-gen/video-task.ts 对位）：
// 服务端扩展事件推送（ext.video_state）驱动的状态 ref。三条到达线（零轮询，
// useMusicGen 同模式）：
// - 推送线：工具提交成功 + 任务终态时服务端 emitVideoState 实时扇出
//   （run 进行中 SSE 常开必达；idle 时走 WS 慢线）→ useChatState 转发 → extension-events 总线
// - 快照线：attach/刷新/切会话时 attach 流携带服务端从 tasks 表重建的现态
// - 按钮线：stop POST 响应直接带回新清单（面板 stopVideo 调 applyVideos）
// 视频状态不落聊天 transcript（状态面与内容面分离，bg-agents 同模式）。
import { computed, effectScope, ref, watch } from 'vue'
import { onExtensionEvent, type ExtensionEventListener } from './extension-events'
import { useChatState } from './useChatState'
import { apiPost } from './api-client'
import { sortMusicTasks } from '../utils/music-tasks-sort'

/** 视频生成状态条目（服务端 VideoTaskStatus 同形状；两仓契约）。 */
export interface VideoTaskEntry {
    /** 上游视频任务 id（本主会话内唯一寻址键，stop 的路由参数）。 */
    taskId: string
    /** 生成请求描述（截断 200；面板展示）。 */
    caption: string
    /** 模型（MiniMax-H3 / MiniMax-H3-Max 等；展示用）。 */
    model: string
    /** working = 轮询中；completed/error/aborted = 终态。 */
    status: 'working' | 'completed' | 'error' | 'aborted'
    /** 最近活动时刻（ms；服务端终态时刷新，单调递增）。 */
    lastActivityAt?: number
}

/** ext.video_state 载荷形状守卫（非法载荷拒绝，防脏数据进面板）。 */
export function isVideoStatePayload(data: unknown): data is { videos: VideoTaskEntry[] } {
    if (!data || typeof data !== 'object') return false
    const videos = (data as { videos?: unknown }).videos
    if (!Array.isArray(videos)) return false
    return videos.every((v) => {
        if (!v || typeof v !== 'object') return false
        const entry = v as Record<string, unknown>
        return (
            typeof entry.taskId === 'string'
            && typeof entry.caption === 'string'
            && typeof entry.model === 'string'
            && typeof entry.status === 'string'
        )
    })
}

// ── X 关闭记忆（localStorage，按会话键；MusicBar/BgAgentsBar 同模式）──
const PANEL_PREFIX = 'video-bar:'

/** 面板记忆：dismissed 跨刷新持久。恢复判据与音乐面板同解（两条都必须是
 *  任意一帧快照都能判定的单调事实——恢复不能依赖恰好看到 working 帧）：
 *  - seen：已见 taskId 名单。出现未见 taskId = 新提交；
 *  - activityAt：dismiss 落盘时各条目的 lastActivityAt 快照。任一时间戳变大
 *    = dismiss 之后发生过新终态（提交推送 / 终态推送都会刷新它）。 */
interface VideoPanelMemory {
    seen: string[]
    dismissed: boolean
    activityAt?: Record<string, number>
}

function loadPanelMemory(sessionKey: string): VideoPanelMemory {
    try {
        const raw = localStorage.getItem(PANEL_PREFIX + sessionKey)
        if (raw) {
            const parsed = JSON.parse(raw) as VideoPanelMemory
            if (Array.isArray(parsed?.seen)) {
                return {
                    seen: parsed.seen,
                    dismissed: !!parsed.dismissed,
                    activityAt: !!parsed.activityAt && typeof parsed.activityAt === 'object'
                        ? parsed.activityAt
                        : undefined,
                }
            }
        }
    } catch {
        /* 隐私模式等不可用场景：记忆退化为会话内内存态 */
    }
    return { seen: [], dismissed: false }
}

function savePanelMemory(sessionKey: string, mem: VideoPanelMemory): void {
    try {
        localStorage.setItem(PANEL_PREFIX + sessionKey, JSON.stringify(mem))
    } catch {
        /* 同上，写入失败静默（关闭记忆退化为仅本次驻留有效） */
    }
}

// 模块级单例（useMusicGen 同模式）：状态条组件与未来消费方共享同一份列表。
function buildVideoGenState() {
    const chatState = useChatState()

    // 状态 ref：三条到达线统一写入口（归属校验：非当前会话的事件不应用）
    const videos = ref<VideoTaskEntry[]>([])

    // X 关闭记忆（按会话键持久化，刷新后仍保持关闭；seen/activityAt 见上）
    const panelMem = ref<VideoPanelMemory>({ seen: [], dismissed: false })

    /** 更新记忆并落盘（会话键缺失时仅内存态，等首次 applyVideos 补写） */
    function persistPanel(patch: Partial<VideoPanelMemory>): void {
        panelMem.value = { ...panelMem.value, ...patch }
        const key = chatState.sessionKey
        if (key) savePanelMemory(key, panelMem.value)
    }

    function applyVideos(list: VideoTaskEntry[] | null, key?: string): void {
        if (key !== undefined && key !== chatState.sessionKey) return
        const next = list ?? []
        const ids = next.map(v => v.taskId)
        // 恢复条件（单调事实，任意一帧可判）：① 未见新 taskId（新提交）；② 任一
        // 条目 lastActivityAt 超过 dismiss 快照（新终态刷新时间戳——working 帧丢失
        // 只剩终态帧也能触发）。
        if (panelMem.value.dismissed) {
            const newVideo = ids.some(id => !panelMem.value.seen.includes(id))
            const newActivity = next.some(v => (v.lastActivityAt ?? 0) > (panelMem.value.activityAt?.[v.taskId] ?? 0))
            if (newVideo || newActivity) {
                persistPanel({ dismissed: false })
            }
        }
        persistPanel({ seen: [...new Set([...panelMem.value.seen, ...ids])] })
        videos.value = next
    }

    // 推送线 + 快照线：ext.video_state（两仓契约，与服务端 VIDEO_STATE_EVENT 同值；
    // 改名须同步 seedagent video-task.ts）
    const listener: ExtensionEventListener = (data, key) => {
        if (!isVideoStatePayload(data)) return
        applyVideos(data.videos, key)
    }
    onExtensionEvent('ext.video_state', listener)

    /** 折叠条点击 / 客户端命令 /videobar 入口：切换 inline 展开（逐条清单）。
     *  无视频任务返回 false（调用方 toast 提示）；被 X 关掉时先恢复显示并落盘 */
    const panelOpen = ref(false)
    function togglePanel(): boolean {
        if (videos.value.length === 0) return false
        if (panelMem.value.dismissed) persistPanel({ dismissed: false })
        panelOpen.value = !panelOpen.value
        return true
    }

    /** bar 的 X：收起清单 + 隐藏状态条并落盘（新提交 / 新终态 / 会话切换自动恢复
     *  ——见 applyVideos 恢复判据） */
    function dismissBar(): void {
        persistPanel({
            seen: videos.value.map(v => v.taskId),
            dismissed: true,
            activityAt: Object.fromEntries(videos.value.map(v => [v.taskId, v.lastActivityAt ?? 0])),
        })
        panelOpen.value = false
    }

    // 会话切换：清空现态，收起清单；关闭记忆按会话键从盘上取回（跨会话互不窜台；
    // immediate：刷新直接落在会话上时首个快照到达前先就位，否则全员快照会复活已关状态）
    watch(() => chatState.sessionKey, (key) => {
        videos.value = []
        panelOpen.value = false
        panelMem.value = key ? loadPanelMemory(key) : { seen: [], dismissed: false }
    }, { immediate: true })

    /** 有视频任务（数据在不在）。 */
    const hasVideos = computed(() => videos.value.length > 0)
    /** 状态条显隐 = 有数据且未被 X 关闭（跨刷新持久；bar v-if 消费）。 */
    const barVisible = computed(() => hasVideos.value && !panelMem.value.dismissed)
    /** 运行中数量（折叠条徽标）。 */
    const workingCount = computed(() => videos.value.filter((v) => v.status === 'working').length)

    /** 展示序：运行中置顶，其余按最近活动倒序。复用音乐的排序泛型函数
     *  sortMusicTasks（条目形状同构：status + lastActivityAt），不复制规则。
     *  供 bar 清单 v-for 消费；stopVideo/寻址仍按 taskId，与顺序无关。 */
    const sortedVideos = computed(() => sortMusicTasks(videos.value))

    /** 按钮线：停掉某个在飞的视频生成任务（durable abortTask → abort 终态，不注入
     *  回执；仅 queued 能在上游取消，running 本地停止照常计费）。POST 响应带回
     *  停止后的清单；busy 流开时推送线已到，此处幂等。 */
    async function stopVideo(taskId: string): Promise<boolean> {
        const key = chatState.sessionKey
        if (!key) return false
        try {
            const res = await apiPost<{ ok?: boolean; videos?: VideoTaskEntry[] }>(
                `/api/extensions/video-gen/sessions/${encodeURIComponent(key)}/video/${encodeURIComponent(taskId)}/stop`,
            )
            if (Array.isArray(res?.videos)) applyVideos(res.videos, key)
            return true
        } catch {
            // apiPost 已弹 toast
            return false
        }
    }

    return { videos, sortedVideos, hasVideos, barVisible, workingCount, stopVideo, applyVideos, panelOpen, togglePanel, dismissBar }
}

// 模块级共享单例（useMusicGen 同模式）
//
// ⚠ detached effectScope（缘由同 useMusicGen）：首个调用方 HomeView setup 内构建的
// 「切会话清空」watch 会随 HomeView 卸载（离开聊天页 / 跨 1024px 断点换布局）而失效，
// 之后切到无视频任务的会话，状态条残留上个会话的条目。detached 让 effect 与模块同寿命。
let shared: ReturnType<typeof buildVideoGenState> | undefined

export function useVideoGen() {
    if (!shared) shared = effectScope(true).run(() => buildVideoGenState())!
    return shared
}
