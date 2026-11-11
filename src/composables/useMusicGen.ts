// src/composables/useMusicGen.ts
// 音乐生成状态条的数据源（seedagent extensions/audio-gen/music-task.ts 对位）：
// 服务端扩展事件推送（ext.music_state）驱动的状态 ref。三条到达线（零轮询，后台
// 子代理同模式）：
// - 推送线：工具提交成功 + 任务终态时服务端 emitMusicState 实时扇出
//   （run 进行中 SSE 常开必达；idle 时走 WS 慢线）→ useChatState 转发 → extension-events 总线
// - 快照线：attach/刷新/切会话时 attach 流携带服务端从 tasks 表重建的现态
// - 按钮线：stop POST 响应直接带回新清单（面板 stopMusic 调 applyMusics）
// 音乐状态不落聊天 transcript（状态面与内容面分离，bg-agents 同模式）。
import { computed, effectScope, ref, watch } from 'vue'
import { onExtensionEvent, type ExtensionEventListener } from './extension-events'
import { useChatState } from './useChatState'
import { apiPost } from './api-client'
import { sortMusicTasks } from '../utils/music-tasks-sort'

/** 音乐生成状态条目（服务端 MusicTaskStatus 同形状；两仓契约）。 */
export interface MusicTaskEntry {
    /** 上游音乐任务 id（本主会话内唯一寻址键，stop 的路由参数）。 */
    taskId: string
    /** 生成请求描述（截断 100；面板展示）。 */
    caption: string
    /** provider id（stepmusic 等；展示用）。 */
    provider: string
    /** working = 轮询中；completed/error/aborted = 终态。 */
    status: 'working' | 'completed' | 'error' | 'aborted'
    /** 最近活动时刻（ms；服务端终态时刷新，单调递增）。 */
    lastActivityAt?: number
}

/** ext.music_state 载荷形状守卫（非法载荷拒绝，防脏数据进面板）。 */
export function isMusicStatePayload(data: unknown): data is { musics: MusicTaskEntry[] } {
    if (!data || typeof data !== 'object') return false
    const musics = (data as { musics?: unknown }).musics
    if (!Array.isArray(musics)) return false
    return musics.every((m) => {
        if (!m || typeof m !== 'object') return false
        const entry = m as Record<string, unknown>
        return (
            typeof entry.taskId === 'string'
            && typeof entry.caption === 'string'
            && typeof entry.provider === 'string'
            && typeof entry.status === 'string'
        )
    })
}

// ── X 关闭记忆（localStorage，按会话键；BgAgentsBar/TaskBar/GoalBar 同模式）──
const PANEL_PREFIX = 'music-bar:'

/** 面板记忆：dismissed 跨刷新持久。恢复判据与 bg-agents 面板同解（两条都必须是
 *  任意一帧快照都能判定的单调事实——恢复不能依赖恰好看到 working 帧）：
 *  - seen：已见 taskId 名单。出现未见 taskId = 新提交；
 *  - activityAt：dismiss 落盘时各曲的 lastActivityAt 快照。任一时间戳变大
 *    = dismiss 之后发生过新终态（提交推送 / 终态推送都会刷新它）。 */
interface MusicPanelMemory {
    seen: string[]
    dismissed: boolean
    activityAt?: Record<string, number>
}

function loadPanelMemory(sessionKey: string): MusicPanelMemory {
    try {
        const raw = localStorage.getItem(PANEL_PREFIX + sessionKey)
        if (raw) {
            const parsed = JSON.parse(raw) as MusicPanelMemory
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

function savePanelMemory(sessionKey: string, mem: MusicPanelMemory): void {
    try {
        localStorage.setItem(PANEL_PREFIX + sessionKey, JSON.stringify(mem))
    } catch {
        /* 同上，写入失败静默（关闭记忆退化为仅本次驻留有效） */
    }
}

// 模块级单例（useBackgroundAgents 同模式）：状态条组件与未来消费方共享同一份列表。
function buildMusicGenState() {
    const chatState = useChatState()

    // 状态 ref：三条到达线统一写入口（归属校验：非当前会话的事件不应用）
    const musics = ref<MusicTaskEntry[]>([])

    // X 关闭记忆（按会话键持久化，刷新后仍保持关闭；seen/activityAt 见上）
    const panelMem = ref<MusicPanelMemory>({ seen: [], dismissed: false })

    /** 更新记忆并落盘（会话键缺失时仅内存态，等首次 applyMusics 补写） */
    function persistPanel(patch: Partial<MusicPanelMemory>): void {
        panelMem.value = { ...panelMem.value, ...patch }
        const key = chatState.sessionKey
        if (key) savePanelMemory(key, panelMem.value)
    }

    function applyMusics(list: MusicTaskEntry[] | null, key?: string): void {
        if (key !== undefined && key !== chatState.sessionKey) return
        const next = list ?? []
        const ids = next.map(m => m.taskId)
        // 恢复条件（单调事实，任意一帧可判）：① 未见新 taskId（新提交）；② 任一曲
        // lastActivityAt 超过 dismiss 快照（新终态刷新时间戳——working 帧丢失只剩
        // 终态帧也能触发）。
        if (panelMem.value.dismissed) {
            const newMusic = ids.some(id => !panelMem.value.seen.includes(id))
            const newActivity = next.some(m => (m.lastActivityAt ?? 0) > (panelMem.value.activityAt?.[m.taskId] ?? 0))
            if (newMusic || newActivity) {
                persistPanel({ dismissed: false })
            }
        }
        persistPanel({ seen: [...new Set([...panelMem.value.seen, ...ids])] })
        musics.value = next
    }

    // 推送线 + 快照线：ext.music_state（两仓契约，与服务端 MUSIC_STATE_EVENT 同值；
    // 改名须同步 seedagent music-task.ts）
    const listener: ExtensionEventListener = (data, key) => {
        if (!isMusicStatePayload(data)) return
        applyMusics(data.musics, key)
    }
    onExtensionEvent('ext.music_state', listener)

    /** 折叠条点击 / 客户端命令 /musicbar 入口：切换 inline 展开（逐曲清单）。
     *  无音乐任务返回 false（调用方 toast 提示，bgagents 同模式）；被 X 关掉时
     *  先恢复显示并落盘 */
    const panelOpen = ref(false)
    function togglePanel(): boolean {
        if (musics.value.length === 0) return false
        if (panelMem.value.dismissed) persistPanel({ dismissed: false })
        panelOpen.value = !panelOpen.value
        return true
    }

    /** bar 的 X：收起清单 + 隐藏状态条并落盘（新提交 / 已见曲目新终态 / 会话切换
     *  自动恢复——见 applyMusics 恢复判据） */
    function dismissBar(): void {
        persistPanel({
            seen: musics.value.map(m => m.taskId),
            dismissed: true,
            activityAt: Object.fromEntries(musics.value.map(m => [m.taskId, m.lastActivityAt ?? 0])),
        })
        panelOpen.value = false
    }

    // 会话切换：清空现态，收起清单；关闭记忆按会话键从盘上取回（跨会话互不窜台；
    // immediate：刷新直接落在会话上时首个快照到达前先就位，否则全员快照会复活已关状态）
    watch(() => chatState.sessionKey, (key) => {
        musics.value = []
        panelOpen.value = false
        panelMem.value = key ? loadPanelMemory(key) : { seen: [], dismissed: false }
    }, { immediate: true })

    /** 有音乐任务（数据在不在）。 */
    const hasMusics = computed(() => musics.value.length > 0)
    /** 状态条显隐 = 有数据且未被 X 关闭（跨刷新持久；bar v-if 消费）。 */
    const barVisible = computed(() => hasMusics.value && !panelMem.value.dismissed)
    /** 运行中数量（折叠条徽标）。 */
    const workingCount = computed(() => musics.value.filter((m) => m.status === 'working').length)

    /** 展示序：运行中置顶，其余按最近活动倒序（规则与动机见 utils/music-tasks-sort.ts）。
     *  供 bar 清单 v-for 消费；stopMusic/寻址仍按 taskId，与顺序无关。 */
    const sortedMusics = computed(() => sortMusicTasks(musics.value))

    /** 按钮线：停掉某个在飞的音乐生成任务（durable abortTask → abort 终态，不注入
     *  回执）。POST 响应带回停止后的清单；busy 流开时推送线已到，此处幂等。 */
    async function stopMusic(taskId: string): Promise<boolean> {
        const key = chatState.sessionKey
        if (!key) return false
        try {
            const res = await apiPost<{ ok?: boolean; musics?: MusicTaskEntry[] }>(
                `/api/extensions/audio-gen/sessions/${encodeURIComponent(key)}/music/${encodeURIComponent(taskId)}/stop`,
            )
            if (Array.isArray(res?.musics)) applyMusics(res.musics, key)
            return true
        } catch {
            // apiPost 已弹 toast
            return false
        }
    }

    return { musics, sortedMusics, hasMusics, barVisible, workingCount, stopMusic, applyMusics, panelOpen, togglePanel, dismissBar }
}

// 模块级共享单例（useBackgroundAgents 同模式）
//
// ⚠ detached effectScope（缘由同 useBackgroundAgents）：首个调用方 HomeView setup 内构建的
// 「切会话清空」watch 会随 HomeView 卸载（离开聊天页 / 跨 1024px 断点换布局）而失效，
// 之后切到无音乐任务的会话，状态条残留上个会话的曲目。detached 让 effect 与模块同寿命。
let shared: ReturnType<typeof buildMusicGenState> | undefined

export function useMusicGen() {
    if (!shared) shared = effectScope(true).run(() => buildMusicGenState())!
    return shared
}
