import type { ChatMessage, ChatSessionData } from '../composables/useChatState'
import { applyQueueSnapshot, type ServerQueueEntry } from './pending-queue.ts'

export interface AttachMessageState {
    messages?: ChatMessage[]
    deltaMessages?: ChatMessage[]
    streamMessage?: {
        content?: unknown
    } | null
    isStreaming?: boolean
    /** 上下文压缩进行中（服务端 attach 语义：压缩窗口非 run 但忙，随
     * message_state 下发；旧服务端无此字段，缺省不动本地状态） */
    compacting?: boolean
    /** 服务端权威排队队列快照：刷新/切会话后与消息同帧恢复（本地不持久化队列） */
    pendingQueue?: ServerQueueEntry[]
    /** 快照版本号：乱序防护门禁（客户端只应用比本地新的快照） */
    queueRev?: number
}

export function getLastMessageEntryId(messages: ChatMessage[]): string | undefined {
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined
    return lastMessage?.entryId || undefined
}

/**
 * 流内 delta 路由标记：块上记录它在 pi 消息 content 数组中的下标（即 SSE delta
 * 事件的 contentIndex）。写入方：attach 快照重放（本文件）与 live 新建块
 * （useChatState text/thinking_delta）；读取方：useChatState 按下标就地合并增量。
 * 不可枚举：不进 JSON 序列化（message_end 固化/快照拷贝天然剥离），deepEqual 不受污染。
 */
export function markContentIndex(block: object, contentIndex: number): void {
    Object.defineProperty(block, '_ci', { value: contentIndex, enumerable: false })
}

/**
 * 流内「正在增长」块标记：块收到 delta 即标记为活跃（多标记：不因后续 delta
 * 落到其他块上而丢失——交错推理时 thinking 与 text 块的 delta 交替到达，
 * 单标记会被来回挬走，仍在增长的思考块在 text_delta 间隙被误判为已定格，
 * 错误走进 markdown 全量重渲热路径）。
 * 展示层（useChatMessages.convertToBlocks → ThinkingBlock）据此选择纯文本直播渲染。
 *
 * 标记存在流数组本身的 __liveBlocks Set 上而非块对象上：
 * - JSON 深拷贝/固化天然剥离（数组不被拷贝，历史消息永远不带标记）；
 * - 每个 session 有独立 chatStream 数组，多会话并发互不串扰；
 * - message_end 置 chatStream = null 时标记随数组一起消失（思考定格）；
 * - 刻意不提供清除：流的生命周期就是标记的生命周期，避免相位边界/交错
 *   时序下的误清除。
 */
export function markLiveStreamBlock(stream: object[] | null | undefined, target: object | null | undefined): void {
    if (!stream || !target) return
    // 普通赋值而非 defineProperty：chatStream 可能是 Vue 响应式代理，
    // defineProperty 在 proxy 上会触发不可变式错误（get 包装后返回值不一致）；
    // 而赋值会透写到底层数组，raw/代理两侧读到同一属性。数组 expando
    // 不参与 JSON 序列化与数组遍历，仅在 deepEqual 整组比较时可见（测试侧规避）
    const existing = (stream as any).__liveBlocks
    const set: Set<object> = existing instanceof Set ? existing : ((stream as any).__liveBlocks = new Set())
    set.add(target)
}

/** 该块是否为所在流（content 即 chatStream 数组；历史消息数组无标记 → 恒 false）的活跃增长块 */
export function isLiveStreamBlock(stream: unknown, block: unknown): boolean {
    return !!stream && ((stream as any).__liveBlocks instanceof Set) && (stream as any).__liveBlocks.has(block as object)
}

/**
 * 流内「最近收到 delta 的块」单标记（覆盖式转移）：三点动画的判定信号。
 *
 * 与 __liveBlocks（多标记、不清除）的分工：
 * - __liveBlocks 服务渲染策略（纯文本直播 vs markdown 定格），语义是「曾经增长过」——
 *   交错推理防抖需要保守判定，见 markLiveStreamBlock 注释；
 * - __activeBlock 服务「正在思考/输出」的用户感知（ThinkingBlock 标题 loading-dots），
 *   语义是「最近一个 delta 落在这里」。若复用 __liveBlocks，单 phase 协议（thinking 与
 *   正文同一条消息）下思考块的三点会一直转到 message_end——「曾经增长过」被误读为
 *   「正在思考」（间歇性 bug：多 phase 协议 thinking 的 message_end 固化消息，
 *   三点恰好随思考结束消失，故表现为有时正常）。
 *
 * 覆盖式转移的正确性：text_delta 到达 → 活跃标记移到正文块 → 三点消失（思考已结束）；
 * 交错推理 thinking_delta 回注 → 标记拉回思考块 → 三点恢复（思考确实又开始了）。
 * 生命周期同 __liveBlocks：挂在流数组 expando 上，message_end 置 chatStream=null 随数组消失。
 */
export function markActiveStreamBlock(stream: object[] | null | undefined, target: object | null | undefined): void {
    if (!stream || !target) return
    ;(stream as any).__activeBlock = target
}

/** 该块是否为所在流中最近收到 delta 的块（历史消息数组无标记 → 恒 false） */
export function isActiveStreamBlock(stream: unknown, block: unknown): boolean {
    return !!stream && (stream as any).__activeBlock === block
}

/**
 * pi partial 消息 content → 流内块数组。两个消费方共用：
 * - attach 快照重放（streamMessage，本文件）；
 * - live assistant message_start 首批播种（useChatState）——pi-durable 语义下首批
 *   文本只随 message_start 的 partial 落位（后续 delta 由 viewOps 追加派生，与首批
 *   互斥），不播种则每条 live 观看的消息缺头。
 *
 * 剥掉 toolCall block：客户端收不到 toolcall 参数增量（服务端只转发
 * text/thinking delta），partial 里的 toolCall 是 partial-json 的流式中间态
 * （参数可能缺到只剩 task:""）。原样恢复会在 message_end 时被固化进历史，
 * 渲染成永远转圈的 calling 卡；随后 tool_execution_start 再 push 一份
 * 完整参数的同 id block，同一调用出现两张卡。toolCall 卡统一由
 * tool_execution_start 用完整参数重建（与 live 流程一致）。
 * 保留块时按下标打 _ci 标记：content 即 pi partial 消息的 content 数组，
 * 原始数组下标 = 后续 live delta 的 contentIndex，重放/播种后增量按 _ci 就地合并
 * （见 useChatState text/thinking_delta）；toolCall 占位下标不能挤占文本/思考
 * 块的下标，故必须在过滤前计算下标。_ci 为不可枚举：JSON 拷贝/固化天然剥离。
 * 返回值已是逐块深拷贝（切断对快照/事件对象的引用）。
 */
export function replayPartialBlocks(content: unknown): any[] {
    if (!Array.isArray(content)) return []
    const replayed: any[] = []
    content.forEach((block: any, index: number) => {
        if (block?.type === 'toolCall') return
        // 空 text/thinking 块照播种（位置占位）：保证后续 delta 按 _ci 路由命中正确位置
        //（跳过会让新块被 push 到流尾，思考跑到正文后面）；空块不会进历史——
        // 固化时 solidifyAssistantContent 丢弃无内容占位块
        const copy = JSON.parse(JSON.stringify(block))
        markContentIndex(copy, index)
        replayed.push(copy)
    })
    return replayed
}

export function shouldAttachSession(hasActiveSSE: boolean): boolean {
    return !hasActiveSSE
}

/** 会话内本地回执条目（`!!` 的 bash-receipt：master 裁决排除≈不存档，仅客户端驻留）：
 *  在 ChatMessage 基础上多一个定位锚。 */
export interface LocalReceipt extends ChatMessage {
    /** 登记时所在位置前一条 durable 消息的 entryId（null = 当时会话无 durable 消息）
 *  ——重挂定位用，取代 timestamp 比较（免客户端/服务端钟差错位） */
    anchor: string | null
}

/**
 * 重挂本地回执：chatMessages 被服务端权威数据整体替换（done/abort/load/
 * navigate/attach 全量五出口）后的统一补挂。
 *
 * 锚点规则：anchor 命中快照 → 插锚后（同锚多条按登记顺序接续）；快照非空而
 * anchor 缺失 → 丢弃（回执所属时代已被 /reset 或分支切换抹去——跨窗口 reset
 * 与跨分支不复活）；无 anchor（登记时会话尚无 durable 消息）→ 插头部；
 * 快照为空 → 保留尾部。按 id 去重幂等（回滚快照已含回执条目时跳过）。
 */
export function remountLocalReceipts(sessionData: ChatSessionData): void {
    const receipts = sessionData.localReceipts
    if (!receipts || receipts.length === 0) return
    const next = [...sessionData.chatMessages]
    for (const receipt of receipts) {
        if (next.some((message) => message.id === receipt.id)) continue
        if (receipt.anchor) {
            const anchorIdx = next.findIndex((message) => message.entryId === receipt.anchor)
            if (anchorIdx === -1) continue
            let pos = anchorIdx + 1
            // 同锚多条按登记顺序接续（已挂载的同锚回执对象自带 anchor 字段）
            while (pos < next.length && (next[pos] as LocalReceipt | undefined)?.anchor === receipt.anchor) pos++
            next.splice(pos, 0, receipt)
        } else if (next.length > 0) {
            let pos = 0
            while (pos < next.length && (next[pos] as LocalReceipt | undefined)?.anchor === null) pos++
            next.splice(pos, 0, receipt)
        } else {
            next.push(receipt)
        }
    }
    sessionData.chatMessages = next
}

export function applyAttachMessageState(sessionData: ChatSessionData, state: AttachMessageState): void {
    // 1. 对齐当前分支的持久化消息历史。
    if (Array.isArray(state.messages)) {
        sessionData.chatMessages = state.messages
        // 全量快照 = 服务端给出的当前分支权威历史：流式临时条目一并作废
        //（若服务端分支已被另一窗口改写，残留条目会以数组尾部位置赢得 last-write-wins）；delta 增量路径不动
        sessionData.chatToolMessages = []
        // 本地回执（!! bash-receipt）不在权威快照内，替换后重挂（锚点定位，
        // 跨窗口 reset / 跨分支自动丢弃，见 remountLocalReceipts）
        remountLocalReceipts(sessionData)
    } else if (Array.isArray(state.deltaMessages) && state.deltaMessages.length > 0) {
        const existingEntryIds = new Set(sessionData.chatMessages.map(message => message.entryId).filter(Boolean))
        const deduped = state.deltaMessages.filter(message => !message.entryId || !existingEntryIds.has(message.entryId))
        if (deduped.length > 0) {
            sessionData.chatMessages = [...sessionData.chatMessages, ...deduped]
            // delta 已带来服务端当前分支的持久化权威：流式临时条目一并作废（同全量路径规则），
            // 防他窗改写分支后旧快照以数组尾部位置赢得 LWW。
            // 注：流式态下在途条目由 attach 的 inflight 重放补齐（message_state → buffer → inflight 顺序保证
            // 清空发生在重放之前）；非流式态（run 已结束）无补发，残留本就该作废，随下次 done/load 收敛
            sessionData.chatToolMessages = []
        }
    }

    // 2. 对齐服务端对“当前是否仍在流”的判断。压缩也是忙态：切会话/刷新落在
    // 压缩窗口（isStreaming=false 而 compacting=true）时，据 compacting 恢复
    // busy 与压缩指示器——服务端 attach 在压缩期间保持订阅，compaction_end
    // 及续跑事件会继续到达，客户端不再呈现假空闲
    if (typeof state.compacting === 'boolean') {
        sessionData.compacting = state.compacting
    }
    if (typeof state.isStreaming === 'boolean') {
        sessionData.chatSending = state.isStreaming || state.compacting === true
    }

    // 2.5 排队队列：服务端权威快照（queueRev 门禁防乱序；全量/delta 快照均携带，无则保持本地不变）
    if (Array.isArray(state.pendingQueue)) {
        applyQueueSnapshot(sessionData, state.queueRev, state.pendingQueue)
    }

    // 3. 恢复或清空半截 assistant 流。
    if (state.streamMessage?.content && Array.isArray(state.streamMessage.content)) {
        // replayPartialBlocks 返回逐块深拷贝（与旧的整包 JSON 拷贝同语义，切断对快照对象的引用）
        const rebuilt = replayPartialBlocks(state.streamMessage.content)
        // 重放的思考块补上活跃标记：标记随 JSON 深拷贝丢失，而流仍在增长——
        // 若不补，重连后到下一个 delta 到达前的窗口内（推理停顿时可达秒级），
        // 增长中的思考块被误判为已定格而走 markdown 全量重渲
        for (const block of rebuilt) {
            if (block?.type === 'thinking') markLiveStreamBlock(rebuilt, block)
        }
        // 活跃标记补最后一个块（覆盖式单标记，快照无从得知下一个 delta 落点，
        // 取「最近增长」的尾块启发）：尾部是 text → 思考三点不闪；尾部是 thinking →
        // 重连窗口内三点连续。下一个 delta 到达后由真实事件修正
        const tail = rebuilt[rebuilt.length - 1]
        if (tail) markActiveStreamBlock(rebuilt, tail)
        sessionData.chatStream = rebuilt
        return
    }

    if (state.isStreaming) {
        // 旧连接遗留的 chatStream 一律作废（不能 `|| []` 保留）：切走再切回走
        // sessionsMap 缓存路径（不经 loadChatHistory），上一条连接 abort 前 push 进
        // 流的文本/工具卡仍残留，而快照历史（落盘数据）已含同一 assistant 消息
        // （pi 在 message_end 落盘、含 toolCall block，之后才执行工具）——
        //   · 遗留工具卡 + 历史 [text, toolCall] → 同 id 双卡，且随后被 toolResult
        //     的 message_end 固化成第二条永久消息（直到 done 全量刷新）；
        //   · 遗留文本（断开时未收 message_end）渲染在历史 [text, toolCall] 之后
        //     → 「调用工具前的文字跑到工具卡后面」，同样固化成重复消息。
        // 在飞内容唯一合法来源是上方 streamMessage 快照重建；运行中工具的卡片
        // 活在历史消息里（start 查重跳过 push，update/end 历史兜底就地更新），
        // 无需流内重建。[] 而非 null：保持流式态语义（loading 占位与后续 delta
        // 懒初始化行为一致）。
        sessionData.chatStream = []
        return
    }

    sessionData.chatStream = null
}
