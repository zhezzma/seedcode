// src/utils/goal-snapshot.ts
// goal 状态条的数据形状守卫 + 面板关闭记忆状态机（纯函数、零 vue 依赖）。
// 数据源：服务端扩展事件推送（ext.goal_state，emitExtensionEvent/attach 快照线），
// 不再从会话消息流提取——UI 状态不落 transcript。
// 注意：事件名字面量 'ext.goal_state' 与服务端唯一真相源同值（ext. 前缀 = 两仓
// 契约，见 seedagent/src/agent/contracts/extension-events.ts）——
// seedagent/src/extensions/goal/index.ts 的 GOAL_STATE_EVENT；改名须两仓同步。

/** ext.goal_state 事件载荷形状（镜像服务端 GoalStatePayload，seedagent/src/extensions/goal/types.ts）。 */
export interface GoalStatePayload {
    enabled: boolean
    turnCount: number
    maxTurns: number
    startMessage: string
    turnMessage: string
    judgeEnabled: boolean
    /** "provider/model"（explicit 模式）；session 模式时 undefined */
    judgeModel?: string
    startedAt: number
    /** 停止后是否可 resume（服务端 off/judge-error=true；max/judge-stop=false）；
     *  运行中（enabled=true）恒 true——仅在停止态决定是否显示恢复按钮 */
    resumable: boolean
}

/** 事件载荷形状守卫（推送线/快照线统一入口：非法载荷拒绝应用）。 */
export function isGoalStatePayload(v: unknown): v is GoalStatePayload {
    if (!v || typeof v !== 'object') return false
    const p = v as Record<string, unknown>
    return (
        typeof p.enabled === 'boolean' &&
        typeof p.turnCount === 'number' &&
        typeof p.maxTurns === 'number' &&
        typeof p.startMessage === 'string' &&
        typeof p.turnMessage === 'string' &&
        typeof p.judgeEnabled === 'boolean' &&
        (p.judgeModel === undefined || typeof p.judgeModel === 'string') &&
        typeof p.startedAt === 'number' &&
        typeof p.resumable === 'boolean'
    )
}

// ============================================================
// 面板关闭记忆状态机（纯函数，同 tasklist-snapshot 模式）
// 语义：✕ 任何状态可关闭；重现只由「新 goal 启动 / resume」（新 startedAt）触发；
// 停止（enabled=false）不动记忆——状态条转为停止态（显示恢复按钮），
// 已关闭则保持隐藏（刷新加载窗口同 null 一样不吞 dismiss 记忆）。
// 同一运行内轮数推进（startedAt 不变）不影响可见性（已关就保持隐藏，
// 否则每轮 onYield 都会把刚关掉的状态条弹回来）。
// ============================================================

export interface GoalPanelMemory {
    /** 见过的运行周期 startedAt；新值出现 = 新 goal 启动 = 面板重现 */
    seenStartedAt: number | null
    /** 用户是否已关闭当前状态条 */
    dismissed: boolean
}

/**
 * 快照驱动面板记忆状态机：返回新记忆；无变化返回原引用（调用方据引用判断是否落盘）。
 * - null 快照 = 未知/加载中（attach 快照线未到、会话切换窗口）：不动记忆——同 tasklist
 *   （null 当作停止会把加载窗口的空窗当成「已停止」，吞掉 dismiss 记忆并
 *   在快照到达后误判为新 goal 而复活状态条）
 * - 停止（enabled=false）→ 不动记忆：状态条转为停止态（显示恢复按钮），
 *   已关闭则保持隐藏。不重置——重置会让刷新后停止态状态条反复弹出（用户每次
 *   刷新都要重新关闭）。resume 由服务端赋新 startedAt 触发重现。
 * - 新 startedAt（start/restart/resume 新周期）→ dismissed=false（重现）
 * - 同一运行内轮数推进 → 记忆不变（已关就保持隐藏）
 */
export function applyGoalStateToMemory(mem: GoalPanelMemory, state: GoalStatePayload | null): GoalPanelMemory {
    if (!state) return mem
    if (!state.enabled) return mem
    if (mem.seenStartedAt !== state.startedAt) {
        return { seenStartedAt: state.startedAt, dismissed: false }
    }
    return mem
}
