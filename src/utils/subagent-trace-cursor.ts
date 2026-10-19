/**
 * 子代理轨迹游标三态合并（纯函数，无 Vue 依赖——node:test 可直测）。
 *
 * 推送增量（ext.subagent_trace）与 HTTP 拉取（GET /subagents/:subId?offset=）
 * 两路共用同一游标（traceOffset）消费，offset/total/baseOffset 口径与只读轨迹
 * 路由严格同源（按全部非 header entry 计数）。
 *
 * 三态：
 * - noop：traceOffset ≥ total——无新条目（推送可能落后于已拉取状态）
 * - resync：traceOffset < baseOffset 或 total 收缩——缺口（错过事件）/ 子会话
 *   中途 compaction 使消息数回落，增量无法表达，调用方回退全量重拉
 * - apply：baseOffset ≤ traceOffset < total——重叠续接，sliceStart 起为本端缺失段
 */
export interface TraceCursorInput {
    /** 服务端权威总数（全部非 header entry 数） */
    total: number
    /** 本批增量的起始游标（服务端上次扇出点；HTTP 拉取 = 请求时的 offset） */
    baseOffset: number
    /** 客户端当前已消费游标 */
    traceOffset: number
}

export interface TraceCursorResult {
    action: 'apply' | 'noop' | 'resync'
    /** apply 时本端缺失段的起始下标（相对增量数组） */
    sliceStart: number
    /** 应用后的新游标（apply = total；noop/resync = 原值不动，由调用方裁决） */
    nextOffset: number
}

export function resolveTraceDelta({ total, baseOffset, traceOffset }: TraceCursorInput): TraceCursorResult {
    // total 收缩（compaction 改写子会话）与缺口同样无法用增量表达：回退全量重拉
    if (traceOffset > total || traceOffset < baseOffset) {
        return { action: 'resync', sliceStart: 0, nextOffset: traceOffset }
    }
    if (traceOffset >= total) {
        return { action: 'noop', sliceStart: 0, nextOffset: traceOffset }
    }
    return { action: 'apply', sliceStart: traceOffset - baseOffset, nextOffset: total }
}
