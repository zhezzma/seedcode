/**
 * 发送队列（pending queue）客户端模型——服务端权威，本地零持久化。
 *
 * busy 期间 steer / follow-up 的文本已在服务端排队。队列的唯一权威是
 * seedagent 侧的影子账本（queue-registry）：入队时签发 id，客户端本地条目
 * 的 id 即服务端签发的 entryId。
 *
 * 客户端视图的三个同步通道（收到即整体替换，本地不做任何猜测性修剪）：
 * - attach 快照：message_state 事件携带 pendingQueue（刷新/切会话/重连对齐）；
 * - WS 广播：服务端账本任何变更（入队/回显出账/删除/abort 清账）广播
 *   queue_state 快照，多窗口收敛；
 * - DELETE 响应：单条删除后返回删除后的权威快照。
 *
 * 本模块仅保留三件本地职责：
 * - consumeQueueHead：message_start(role=user) 回显命中队头时立即出队转正
 *   （无 RTT 的即时反馈；随后到达的 queue_state 快照是权威修正）；
 * - consumeRemovedEcho：回显 miss 时检查该文本是否刚被权威快照移除，命中则补齐
 *   正式气泡（乐观气泡不存在的 drain 场景专用）；
 * - consumeInFlightSend / toPendingItems：在途本地发送判别（removedEcho 误补
 *   双气泡的隔离凭据，见下方函数注释）+ 服务端快照载荷 → 本地展示模型。
 *
 * 注意：回显文本是服务端展开后的文本，模板/skill 展开改写时 consumeQueueHead
 * 精确匹配失效——条目残留由下一个 queue_state 快照权威修正，无害。
 */

export type PendingSendMode = 'follow' | 'steer'

export interface PendingItem {
    /** 服务端排队账本签发的 entryId（删除/对账的唯一凭据） */
    id: string
    /** 原始文本（与服务端账本 raw 一致） */
    text: string
    mode: PendingSendMode
    /** 本地展示用时间戳（快照下发时不携带，落地时取当下） */
    timestamp: number
}

/** 服务端队列条目载荷（queue-registry.QueueEntryView / queue_state 广播） */
export interface ServerQueueEntry {
    id: string
    mode: 'steer' | 'followUp'
    text: string
}

/**
 * 快照落地目标（ChatSessionData 的结构子集）：版本门禁 + 整体替换。
 *
 * DELETE 响应与 WS 广播走不同 TCP 连接，到达顺序无保证：跨操作的旧快照
 * 可能晚于新快照到达，无门禁时会复活已删条目。queueRev 由服务端账本
 * 单调递增，只应用比本地新的快照；无 rev（异常路径/旧载荷）保守应用。
 *
 * 附带维护 queueRemovedEchoes（近期被快照移除的条目文本）：服务端 WS 删除
 * 快照恒先于 SSE 回显到达（账本监听器先注册，_emit 同步广播早于 SSE 转发），
 * message_start 的 consumeQueueHead 必然 miss——回显凭此缓存补齐正式气泡，
 * 避免「条目被快照撤了、消息气泡也没了」的长 run 隐身窗口。
 */
export interface QueueSnapshotTarget {
    queueRev?: number
    pendingQueue: PendingItem[]
    /** 近期被快照移除的条目（回显补齐气泡的比对缓存，applyQueueSnapshot 自动维护） */
    queueRemovedEchoes?: RemovedEcho[]
}

export interface RemovedEcho {
    /** 原始文本（与回显 extractUserText 结果比对） */
    text: string
    /** 移除时刻（ms）：过期剔除，防普通消息撞文误补气泡 */
    at: number
}

/** 回显补齐缓存保留窗口：正常 drain→回显延迟为亚秒级，过期条目视为陈旧 */
const REMOVED_ECHO_TTL_MS = 60_000
const REMOVED_ECHO_CAP = 32

export function applyQueueSnapshot(
    target: QueueSnapshotTarget,
    queueRev: number | undefined,
    entries: ServerQueueEntry[] | null | undefined,
): void {
    if (typeof queueRev === 'number' && typeof target.queueRev === 'number' && queueRev <= target.queueRev) {
        return
    }
    const next = toPendingItems(entries)
    // 记录被本快照移除的条目（按 id 差集），供回显补齐气泡；过期条目顺带清琀
    const now = Date.now()
    const nextIds = new Set(next.map(item => item.id))
    const removed = target.pendingQueue
        .filter(item => !nextIds.has(item.id))
        .map(item => ({ text: item.text, at: now }))
    const aliveEchoes = (target.queueRemovedEchoes ?? []).filter(e => now - e.at < REMOVED_ECHO_TTL_MS)
    target.queueRemovedEchoes = [...aliveEchoes, ...removed].slice(-REMOVED_ECHO_CAP)
    if (typeof queueRev === 'number') {
        target.queueRev = queueRev
    }
    target.pendingQueue = next
}

/**
 * 回显补齐：consumeQueueHead miss 时，检查该文本是否刚被权威快照移除。
 * 命中则消费一条缓存并返回 true（调用方照常 append 正式 user 气泡）。
 * 只消费一条：同文本多条被连续 drain 时，每条回显各补一个气泡。
 * TTL 外不命中：防普通 sendMessage 的回显文本恰与陈旧条目相同时重复补
 * 气泡（乐观气泡已覆盖，误补会双气泡，done 全量刷新才自愈）。
 */
export function consumeRemovedEcho(target: QueueSnapshotTarget, text: string): boolean {
    const buffer = target.queueRemovedEchoes
    if (!buffer || !text) return false
    const now = Date.now()
    const idx = buffer.findIndex(e => e.text === text && now - e.at < REMOVED_ECHO_TTL_MS)
    if (idx < 0) return false
    target.queueRemovedEchoes = [...buffer.slice(0, idx), ...buffer.slice(idx + 1)]
    return true
}

// ==================== 在途本地发送判别 ====================

/** 在途本地发送登记目标（ChatSessionData 的结构子集） */
export interface InFlightSendTarget {
    /** 当前 run 的本地发送文本（sendMessage 启动时登记，resetStreamState 兑底清零） */
    inFlightSendTexts?: string[]
}

/**
 * 在途发送命中：该文本的 user 回显是否已被本地乐观气泡覆盖。
 *
 * removedEcho 缓存与排队队头都无法区分「被 drain 的排队条目（回显随后必到，需转正/补齐）」
 * 与「被手动删除/abort 清账的条目（永不投递、永无回显）」及「本地发起的 sendMessage /
 * retry / edit（乐观气泡/乐观分支已覆盖）」——后者残留文本会误命中同文本回显，在乐观
 * 气泡/乐观分支之外补第二个气泡（双气泡）。
 * 判别凭据：sendMessage / retry / edit 启动时登记文本；回显命中在途登记即证明这是
 * 本地发送自己的回显 → 消费一条登记并返回 true，调用方跳过转正与补齐（队头条目留在
 * 队内，服务端仍排队，自身 drain 回显照常转正）。
 * 一次性消费：登记只覆盖一个回显，消费后同文本 drain 回显照常走队头/removedEcho。
 */
export function consumeInFlightSend(target: InFlightSendTarget, text: string): boolean {
    const list = target.inFlightSendTexts
    if (!list || list.length === 0 || !text) return false
    const idx = list.indexOf(text)
    if (idx < 0) return false
    target.inFlightSendTexts = [...list.slice(0, idx), ...list.slice(idx + 1)]
    return true
}

// ==================== 纯函数 ====================

/** 把 SSE / 历史消息的 user content 归一为纯文本（string 或 [{type:'text'}] blocks） */
export function extractUserText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''

    const parts: string[] = []
    for (const block of content) {
        if (
            block && typeof block === 'object'
            && (block as any).type === 'text'
            && typeof (block as any).text === 'string'
        ) {
            parts.push((block as any).text)
        }
    }
    return parts.join('\n')
}

/**
 * 服务端 steer / followUp 是两条独立队列：steer 在当前 run 内注入、followUp 在本轮
 * 结束后 drain，投递顺序不保证全局 FIFO。故按「各自队头 + 文本精确匹配」识别回显；
 * 两条队头同文本时取更早入队者（回退全局 FIFO）。未命中返回 null（交给服务端快照修正）。
 */
export function consumeQueueHead(
    queue: PendingItem[],
    text: string,
): { item: PendingItem; rest: PendingItem[] } | null {
    if (!text || queue.length === 0) return null

    const steerHead = queue.findIndex(i => i.mode === 'steer')
    const followHead = queue.findIndex(i => i.mode === 'follow')

    let idx = -1
    if (steerHead >= 0 && queue[steerHead].text === text) idx = steerHead
    if (followHead >= 0 && queue[followHead].text === text && (idx < 0 || followHead < idx)) {
        idx = followHead
    }
    if (idx < 0) return null

    return { item: queue[idx], rest: [...queue.slice(0, idx), ...queue.slice(idx + 1)] }
}

/** 服务端快照载荷 → 本地展示模型（mode 归一；timestamp 仅展示排序用） */
export function toPendingItems(entries: ServerQueueEntry[] | null | undefined): PendingItem[] {
    if (!Array.isArray(entries)) return []
    return entries
        .filter(entry =>
            !!entry && typeof entry === 'object'
            && typeof entry.id === 'string' && entry.id.length > 0
            && typeof entry.text === 'string'
            && (entry.mode === 'steer' || entry.mode === 'followUp'))
        .map(entry => ({
            id: entry.id,
            mode: entry.mode === 'followUp' ? 'follow' as const : 'steer' as const,
            text: entry.text,
            timestamp: Date.now(),
        }))
}
