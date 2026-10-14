// src/utils/tasklist-snapshot.ts
// 从会话消息流提取会话清单（tasklist）全量快照（服务端工具结果的 details 持久化格式）。
// 纯函数、零 vue 依赖 —— node --test 回归基线直接可跑。
// 历史（GET /messages）与流式（SSE）同一入口，天然覆盖刷新/重连/实时更新三场景。
// 注意：工具名字面量 'tasklist' 与服务端唯一真相源同值——
// seedagent/src/extensions/tasklist/tasklist.ts 的 export const TOOL_NAME；改名须两仓同步，否则面板静默消失。
// 命名约定：本面板是「会话清单」（会话工作步骤）；「任务清单」一词留给外部待办类扩展，两者不混用。

export type TasklistTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

export interface TasklistTask {
    id: number
    subject: string
    description?: string
    activeForm?: string
    status: TasklistTaskStatus
}

export interface TasklistSnapshot {
    tasks: TasklistTask[]
    nextId: number
}

/** 提取器只关心的最小消息形状（兼容 /messages 原始消息与流式增量）。 */
export interface MinimalMessage {
    role?: string
    toolName?: string
    details?: unknown
}

function isTasklistDetails(v: unknown): v is { tasks: TasklistTask[]; nextId: number } {
    if (!v || typeof v !== 'object') return false
    const d = v as Record<string, unknown>
    // Number.isSafeInteger：非整数 nextId（如 2.5）会让服务端 create 派生出非法 id 快照，
    // 该快照再被本守卫拒绝 → 双端静默失步（与服务端守卫同强度）
    if (!Array.isArray(d.tasks) || typeof d.nextId !== 'number' || !Number.isSafeInteger(d.nextId)) return false
    // 规模上限：与服务端守卫同值，防手编/失控数据拖垮渲染
    if (d.tasks.length > 1000) return false
    // 逐项形状守卫：防旧版本/手编数据把面板渲染炸掉（id 必须整数，小数/负数渲染成 #1.5/#-1）
    if (
        !d.tasks.every(
            (t) =>
                t && typeof t === 'object' &&
                Number.isInteger((t as TasklistTask).id) &&
                typeof (t as TasklistTask).subject === 'string' &&
                typeof (t as TasklistTask).status === 'string' &&
                ((t as TasklistTask).description === undefined || typeof (t as TasklistTask).description === 'string') &&
                ((t as TasklistTask).activeForm === undefined || typeof (t as TasklistTask).activeForm === 'string'),
        )
    )
        return false
    // id/nextId 一致性 + 唯一性（与服务端守卫同源）：正整数 id、nextId ≥ 1、所有 id < nextId；
    // 重复 id 会使 Vue :key 冲突、徽章语义混乱
    if ((d.nextId as number) < 1) return false
    const ids = new Set(d.tasks.map((t) => (t as TasklistTask).id))
    if (ids.size !== d.tasks.length) return false
    const nextId = d.nextId as number
    return d.tasks.every((t) => (t as TasklistTask).id >= 1 && (t as TasklistTask).id < nextId)
}

/** 正序扫描，取最后一条形状匹配的 tasklist 工具结果快照；没有则 null。 */
export function extractTasklistSnapshot(messages: MinimalMessage[]): TasklistSnapshot | null {
    let snap: TasklistSnapshot | null = null
    for (const m of messages) {
        if (!m || m.role !== 'toolResult' || m.toolName !== 'tasklist') continue
        if (!isTasklistDetails(m.details)) continue
        snap = { tasks: m.details.tasks.map((t) => ({ ...t })), nextId: m.details.nextId }
    }
    return snap
}

// ============================================================
// 面板关闭记忆状态机（纯函数纳入 node --test 基线）
// 语义：✕ 任何状态可关闭；重现只由「新步骤创建」触发；
// 回退（快照回到已见过的结构）、改名、完成、删除都不再影响面板可见性。
// ============================================================

export interface TasklistPanelMemory {
    /** 见过（曾显示/已关闭）的活步骤 id；新 id 出现 = 新工作开始 = 面板重现 */
    seen: number[]
    /** 用户是否已关闭当前清单 */
    dismissed: boolean
}

/**
 * 快照驱动面板记忆状态机：返回新记忆；无变化返回原引用（调用方据引用判断是否落盘）。
 * - 新活步骤 id 出现 → dismissed=false（面板重现）
 * - clear（空快照且 nextId 归位）→ 记忆重置（新周期视为全新工作）
 * - 其余一切变化（完成/删除/改名/回退）→ 记忆不变（已关就保持隐藏，没关就保持显示）
 */
export function applySnapshotToMemory(mem: TasklistPanelMemory, snapshot: TasklistSnapshot | null): TasklistPanelMemory {
    if (!snapshot) return mem
    const live = snapshot.tasks.filter((t) => t.status !== 'deleted')
    // clear 的标志：快照清空且 nextId 归位（delete 全部不清 nextId，不会误触）
    if (live.length === 0 && snapshot.nextId === 1) {
        return mem.seen.length > 0 || mem.dismissed ? { seen: [], dismissed: false } : mem
    }
    const seen = new Set(mem.seen)
    if (!live.some((t) => !seen.has(t.id))) return mem // 无新活步骤：记忆不变
    for (const t of live) seen.add(t.id)
    return { seen: [...seen].sort((a, b) => a - b), dismissed: false }
}

/**
 * 并入活步骤 id（去重升序）：dismiss 时把当前可见清单固化进 seen，
 * 防止 seen 落后于可见清单（快照稳定期挂载 → 非 immediate watch 从未触发）时，
 * 已关步骤被误判为新步骤而复活面板。
 */
export function unionSeen(seen: number[], liveIds: number[]): number[] {
    const set = new Set(seen)
    for (const id of liveIds) set.add(id)
    return [...set].sort((a, b) => a - b)
}

/**
 * 双源拼接入口：流式条目必须排在历史之后（last-write-wins 按数组位置取末条）。
 * 抽成独立函数并纳入测试基线：若有人交换拼接顺序或在中间插入去重/切片，
 * 流式实时更新会静默退化为「回合结束才更新」——这是必须被测试钉住的顺序假设。
 */
export function extractTasklistSnapshotFromSources(
    history: MinimalMessage[],
    streaming: MinimalMessage[],
): TasklistSnapshot | null {
    return extractTasklistSnapshot([...history, ...streaming])
}
