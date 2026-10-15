// src/composables/useGoalState.ts
// GoalBar 的数据源：服务端扩展事件推送（ext.goal_state）驱动的状态 ref。
// 三条到达线（零轮询）：
// - 推送线：run 进行中（SSE 常开）服务端 emitExtensionEvent 实时扇出 → useChatState 转发 → extension-events 总线
// - 快照线：attach/刷新/切会话时 attach 流携带服务端收集的现态（读 seed.goal，扩展自有 durable doc）
// - 按钮线：停止/恢复 POST 响应直接带回新状态（GoalBar 调 applyState）
// 流未开时（idle）goal 状态只会因用户动作变化——按钮响应/attach 兜底，无需轮询。
// 历史（GET /messages）不再承载 goal 状态：UI 状态不落 transcript、不当对话内容重放。
import { computed, ref, watch } from 'vue'
import {
    applyGoalStateToMemory,
    isGoalStatePayload,
    type GoalPanelMemory,
    type GoalStatePayload,
} from '../utils/goal-snapshot'
import { onExtensionEvent, type ExtensionEventListener } from './extension-events'
import { useChatState } from './useChatState'

const PANEL_PREFIX = 'goal-panel:'

function loadPanelMemory(sessionKey: string): GoalPanelMemory {
    try {
        const raw = localStorage.getItem(PANEL_PREFIX + sessionKey)
        if (raw) {
            const parsed = JSON.parse(raw) as GoalPanelMemory
            if (typeof parsed?.dismissed === 'boolean') {
                return {
                    seenStartedAt: typeof parsed.seenStartedAt === 'number' ? parsed.seenStartedAt : null,
                    dismissed: parsed.dismissed,
                }
            }
        }
    } catch {
        /* 隐私模式等不可用场景：记忆退化为会话内内存态 */
    }
    return { seenStartedAt: null, dismissed: false }
}

function savePanelMemory(sessionKey: string, mem: GoalPanelMemory): void {
    try {
        localStorage.setItem(PANEL_PREFIX + sessionKey, JSON.stringify(mem))
    } catch {
        /* 同上，写入失败静默（关闭记忆退化为仅本次驻留有效） */
    }
}

// 模块级单例（与 useTasklistState 同模式）：HomeView 的 /goalbar 客户端命令
// 与 GoalBar 必须共享同一份 panelMem——若按实例各持一份，restore() 翻转的内存态
// 落不到 GoalBar 正在渲染的那份上。
function buildGoalState() {
    const chatState = useChatState()

    // 状态 ref：三条到达线统一写入口（applyState 校验会话归属）
    const goalState = ref<GoalStatePayload | null>(null)

    // 统一应用口：事件线带 sessionKey（非当前会话的事件不应用）；按钮线传点击时捕获的 key。
    // 归属检查对 null 同样生效：null 是「清除现态」信号，跨会话的清除会把新会话
    // 刚由快照线恢复的状态误抹掉（state 为 falsy 时不得短路守卫）。
    function applyState(state: GoalStatePayload | null, key?: string): void {
        if (key !== undefined && key !== chatState.sessionKey) return
        goalState.value = state
    }

    // 推送线 + 快照线：ext.goal_state 事件 → 状态 ref（形状守卫拒绝非法载荷）
    const listener: ExtensionEventListener = (data, key) => {
        if (!isGoalStatePayload(data)) return
        applyState(data, key)
    }
    onExtensionEvent('ext.goal_state', listener)

    // 会话切换：清空现态——切会话触发 attach，快照线补充新会话现态
    watch(() => chatState.sessionKey, () => {
        goalState.value = null
    })

    // 面板可见性状态机（GoalPanelMemory）：✕ 关闭 + 跨刷新持久化；
    // 重现只由「新 goal 启动 / resume」（新 startedAt）触发；停止不动记忆
    // （v2：停止态转为停止展示 + 恢复按钮，已关保持隐藏——详见 goal-snapshot.ts）。
    // 跨会话一致性：快照与会话键同源求值（元组 watch 在同一 job 内读两个 source），
    // memOwner 归属兜底同 useTasklistState——两者任意顺序到达，写入前归属一致。
    // /goalbar 命令的展开请求通道：restore() 自增，GoalBar watch 后展开详情 + 脉冲
    const expandRequest = ref(0)
    const panelMem = ref<GoalPanelMemory>(loadPanelMemory(chatState.sessionKey))
    const memOwner = ref(chatState.sessionKey)
    watch(() => chatState.sessionKey, (key) => {
        memOwner.value = key
        panelMem.value = loadPanelMemory(key)
    })
    watch([goalState, () => chatState.sessionKey], ([snap, key]) => {
        if (memOwner.value !== key) {
            // 归属不符：本 flush 内 sessionKey watch 尚未运行，同步重载后再应用
            memOwner.value = key
            panelMem.value = loadPanelMemory(key)
        }
        const next = applyGoalStateToMemory(panelMem.value, snap)
        if (next !== panelMem.value) {
            panelMem.value = next
            savePanelMemory(key, next)
        }
    })

    const visibleBar = computed(() => goalState.value !== null && !panelMem.value.dismissed)

    function dismiss(): void {
        // 把当前运行周期 startedAt 固化进 seen：非 immediate 的 goalState watch 在
        // 「快照稳定期挂载」下可能从未触发，seen 可能为 null；固化后同周期的后续
        // 快照不会被误判为新 goal 而复活面板
        const seenStartedAt = goalState.value?.startedAt ?? panelMem.value.seenStartedAt
        panelMem.value = { seenStartedAt, dismissed: true }
        savePanelMemory(chatState.sessionKey, panelMem.value)
    }

    // /goalbar 客户端命令（HomeView 拦截，不经服务端）：重现已关闭的状态条。
    // 返回 false = 当前没有 goal 状态（运行中或已停止均算有——停止态有恢复按钮），
    // 调用方据此提示而非静默。已在显示时也自增 expandRequest：GoalBar 展开详情 + 脉冲，
    // 保证命令永远有可见反馈。
    function restore(): boolean {
        if (!goalState.value) return false
        if (panelMem.value.dismissed) {
            panelMem.value = { ...panelMem.value, dismissed: false }
            savePanelMemory(chatState.sessionKey, panelMem.value)
        }
        expandRequest.value++
        return true
    }

    return { goalState, visibleBar, dismiss, restore, expandRequest, applyState }
}

const _goalState = buildGoalState()

export function useGoalState() {
    return _goalState
}

export type { GoalStatePayload }
