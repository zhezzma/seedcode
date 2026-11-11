// src/composables/useBackgroundAgents.ts
// 后台子代理面板的数据源（seedagent extensions/subagents/background.ts 对位）：
// 服务端扩展事件推送（ext.subagent_state）驱动的状态 ref。三条到达线（零轮询）：
// - 推送线：run 进行中（SSE 常开）服务端 spawn/send/stop/settle 时 emitExtensionEvent
//   实时扇出 → useChatState 转发 → extension-events 总线
// - 快照线：attach/刷新/切会话时 attach 流携带服务端 collected 现态
//   （BackgroundAgents doc + LiveDoc busy 判定）
// - 按钮线：stop POST 响应直接带回新清单（面板 stopAgent 调 applyAgents）
// 后台子代理列表不落聊天 transcript（状态面与内容面分离，goal 同模式）。
import { computed, effectScope, ref, watch } from 'vue'
import { onExtensionEvent, type ExtensionEventListener } from './extension-events'
import { useChatState } from './useChatState'
import { apiPost } from './api-client'
import { sortBackgroundAgents } from '../utils/background-agents-sort'

/** 后台子代理状态条目（服务端 BackgroundAgentStatus 同形状；两仓契约）。 */
export interface BackgroundAgentEntry {
    /** 后台名（本主会话内唯一寻址键，stop 的路由参数）。 */
    name: string
    /** 子代理配置 id（展示）。 */
    subagentId: string
    /** 后台子代理会话 id（字符串化）。 */
    conversationId: string
    /** working = 子会话有 run 在跑；idle = 空闲；completed/error/aborted = 最近终态。 */
    status: 'working' | 'idle' | 'completed' | 'error' | 'aborted'
    /** 最近任务文本（截断 200；面板展示）。 */
    task?: string
    /** 最近活动时刻（ms；服务端 spawn/send 登记、settle 时刷新，单调递增）。 */
    lastActivityAt?: number
}

/** ext.subagent_state 载荷形状守卫（非法载荷拒绝，防脏数据进面板）。 */
export function isBackgroundStatePayload(data: unknown): data is { agents: BackgroundAgentEntry[] } {
    if (!data || typeof data !== 'object') return false
    const agents = (data as { agents?: unknown }).agents
    if (!Array.isArray(agents)) return false
    return agents.every((a) => {
        if (!a || typeof a !== 'object') return false
        const entry = a as Record<string, unknown>
        return (
            typeof entry.name === 'string'
            && typeof entry.subagentId === 'string'
            && typeof entry.conversationId === 'string'
            && typeof entry.status === 'string'
        )
    })
}

// ── X 关闭记忆（localStorage，按会话键；TaskBar/GoalBar panel 同模式）──
const PANEL_PREFIX = 'bg-agents-panel:'

/** 面板记忆：dismissed 跨刷新持久。恢复判据两条，都必须是「任何一帧快照都能判定」
 *  的单调事实——恢复不能依赖恰好看到某个瞬时状态帧（working 帧会因 WS 断连/SSE
 *  关闭而丢失，丢了之后到达的第一帧往往已是 completed）：
 *  - seen：已见工人名单。出现未见名字 = 新 spawn（刷新后快照全员重放时名单不变，
 *    不会复活已关状态——TaskBar seen 同解法）；
 *  - activityAt：dismiss 落盘时各工人的 lastActivityAt 快照。任一工人时间戳变大
 *    = dismiss 之后发生过新活动（send 追问登记 / 新一轮 settle 都会刷新它）。
 *    send 不带来新名字，只判名字时 dismiss 后 send 的整个工作周期（含停止按钮、
 *    报告提醒）都不可见；而「时间戳更大」在 working 帧丢失、只剩 completed 帧时
 *    依然成立。
 */
interface BgPanelMemory {
    seen: string[]
    dismissed: boolean
    activityAt?: Record<string, number>
}

function loadPanelMemory(sessionKey: string): BgPanelMemory {
    try {
        const raw = localStorage.getItem(PANEL_PREFIX + sessionKey)
        if (raw) {
            const parsed = JSON.parse(raw) as BgPanelMemory
            if (Array.isArray(parsed?.seen)) {
                return {
                    seen: parsed.seen,
                    dismissed: !!parsed.dismissed,
                    // 形状守卫：老记忆无此键 → undefined（判据退化为「首帧带时间戳即恢复」，
                    // 与未记录同义，可接受；正常路径 dismissBar 一定落盘完整快照）
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

function savePanelMemory(sessionKey: string, mem: BgPanelMemory): void {
    try {
        localStorage.setItem(PANEL_PREFIX + sessionKey, JSON.stringify(mem))
    } catch {
        /* 同上，写入失败静默（关闭记忆退化为仅本次驻留有效） */
    }
}

// 模块级单例（useGoalState 同模式）：ChatHeader 的按钮态与面板组件必须共享同一份
// agents 列表——按实例各持一份会互不同步。
function buildBackgroundAgentsState() {
    const chatState = useChatState()

    // 状态 ref：三条到达线统一写入口（归属校验：非当前会话的事件不应用）
    const agents = ref<BackgroundAgentEntry[]>([])

    // X 关闭记忆（按会话键持久化，刷新后仍保持关闭；seen/activityAt 见 BgPanelMemory 注释）
    const panelMem = ref<BgPanelMemory>({ seen: [], dismissed: false })

    /** 更新记忆并落盘（会话键缺失时仅内存态，等首次 applyAgents 补写） */
    function persistPanel(patch: Partial<BgPanelMemory>): void {
        panelMem.value = { ...panelMem.value, ...patch }
        const key = chatState.sessionKey
        if (key) savePanelMemory(key, panelMem.value)
    }

    function applyAgents(list: BackgroundAgentEntry[] | null, key?: string): void {
        if (key !== undefined && key !== chatState.sessionKey) return
        const next = list ?? []
        const names = next.map(a => a.name)
        // 恢复条件（单调事实，任意一帧可判）：
        // ① 未见新名字（spawn）；② 任一工人 lastActivityAt 超过 dismiss 快照（send
        // 登记 / 新一轮 settle 都刷新时间戳——working 帧丢失只剩 completed 帧也能触发）。
        // dismissed 期间无需随行更新 activityAt：记录停留在 dismiss 时刻，之后任何
        // 新活动的时间戳都大于它；纯刷新重放的同值快照不会复活。
        if (panelMem.value.dismissed) {
            const newWorker = names.some(n => !panelMem.value.seen.includes(n))
            const newActivity = next.some(a => (a.lastActivityAt ?? 0) > (panelMem.value.activityAt?.[a.name] ?? 0))
            if (newWorker || newActivity) {
                persistPanel({ dismissed: false })
            }
        }
        persistPanel({ seen: [...new Set([...panelMem.value.seen, ...names])] })
        agents.value = next
    }

    // 推送线 + 快照线：ext.subagent_state（两仓契约，与服务端
    // BACKGROUND_STATE_EVENT 同值；改名须同步 seedagent background.ts）
    const listener: ExtensionEventListener = (data, key) => {
        if (!isBackgroundStatePayload(data)) return
        applyAgents(data.agents, key)
    }
    onExtensionEvent('ext.subagent_state', listener)

    /** 浮出清单显隐（BgAgentsBar 与 /bgagents 命令共享，单例同源） */
    const panelOpen = ref(false)
    /** bar 的 X：收起面板 + 隐藏状态条并落盘（新工人 spawn / 已见工人新活动 /
     *  会话切换 / /bgagents 自动恢复——见 applyAgents 恢复判据） */
    function dismissBar(): void {
        persistPanel({
            seen: agents.value.map(a => a.name),
            dismissed: true,
            // dismiss 时刻的活动时间戳快照：「之后的新活动」据此判别（单调，免随行更新）
            activityAt: Object.fromEntries(agents.value.map(a => [a.name, a.lastActivityAt ?? 0])),
        })
        panelOpen.value = false
    }
    /** 客户端命令 /bgagents 入口：无后台子代理返回 false（调用方 toast 提示），
     *  有则切换面板（被 X 关掉时先恢复显示并落盘） */
    function togglePanel(): boolean {
        if (agents.value.length === 0) return false
        if (panelMem.value.dismissed) persistPanel({ dismissed: false })
        panelOpen.value = !panelOpen.value
        return true
    }

    // 会话切换：清空现态，面板收起；关闭记忆按会话键从盘上取回（跨会话互不窜台；
    // immediate：刷新直接落在会话上时首个快照到达前先就位，否则全员快照会复活已关状态）
    watch(() => chatState.sessionKey, (key) => {
        agents.value = []
        panelOpen.value = false
        panelMem.value = key ? loadPanelMemory(key) : { seen: [], dismissed: false }
    }, { immediate: true })

    /** 有后台子代理（数据在不在）。 */
    const hasAgents = computed(() => agents.value.length > 0)
    /** 状态条显隐 = 有数据且未被 X 关闭（跨刷新持久；bar v-if 消费）。 */
    const barVisible = computed(() => hasAgents.value && !panelMem.value.dismissed)
    /** 运行中数量（按钮徽标）。 */
    const workingCount = computed(() => agents.value.filter((a) => a.status === 'working').length)

    /** 展示序：运行中置顶，其余按最近活动倒序（规则与动机见 utils/background-agents-sort.ts）。
     *  供 bar/面板 v-for 消费；stopAgent/寻址仍按 name，与顺序无关。 */
    const sortedAgents = computed(() => sortBackgroundAgents(agents.value))

    /** 按钮线：停掉某个后台子代理的当前工作（会话保留，仍可 send）。
     *  POST 响应带回停止后的清单；busy 流开时推送线已到，此处幂等。 */
    async function stopAgent(name: string): Promise<boolean> {
        const key = chatState.sessionKey
        if (!key) return false
        try {
            const res = await apiPost<{ ok?: boolean; agents?: BackgroundAgentEntry[] }>(
                `/api/extensions/subagents/sessions/${encodeURIComponent(key)}/background/${encodeURIComponent(name)}/stop`,
            )
            if (Array.isArray(res?.agents)) applyAgents(res.agents, key)
            return true
        } catch {
            // apiPost 已弹 toast
            return false
        }
    }

    return { agents, sortedAgents, hasAgents, barVisible, workingCount, stopAgent, applyAgents, panelOpen, togglePanel, dismissBar }
}

// 模块级共享单例（与 useGoalState/useTaskBarState 同模式）
//
// ⚠ detached effectScope（useReplySuggestion 同解法）：懒构建的首个调用方是 HomeView setup，
// 构建期同步创建的 watch 会挂到 HomeView 实例作用域。离开聊天页（设置/
// 智能体等非聊天路由）或窗口跨 1024px 断点换布局都会卸载 HomeView，作用域 stop 杀掉
// 「切会话清空」watch，单例却留在模块里——之后切到无后台子代理的会话（服务端快照对空
// 列表不发事件），状态条残留上个会话的工人，刷新才恢复。detached 让单例的响应式
// effect 独立于任何组件实例存活（与模块同寿命）。
let shared: ReturnType<typeof buildBackgroundAgentsState> | undefined

export function useBackgroundAgents() {
    if (!shared) shared = effectScope(true).run(() => buildBackgroundAgentsState())!
    return shared
}
