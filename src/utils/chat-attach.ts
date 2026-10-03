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
        const copy = JSON.parse(JSON.stringify(block))
        if (typeof copy === 'object' && copy !== null) {
            markContentIndex(copy, index)
        }
        replayed.push(copy)
    })
    return replayed
}

export function shouldAttachSession(hasActiveSSE: boolean): boolean {
    return !hasActiveSSE
}

export function applyAttachMessageState(sessionData: ChatSessionData, state: AttachMessageState): void {
    // 1. 对齐当前分支的持久化消息历史。
    if (Array.isArray(state.messages)) {
        sessionData.chatMessages = state.messages
        // 全量快照 = 服务端给出的当前分支权威历史：流式临时条目一并作废
        //（若服务端分支已被另一窗口改写，残留条目会以数组尾部位置赢得 last-write-wins）；delta 增量路径不动
        sessionData.chatToolMessages = []
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
        // replayed 已是逐块深拷贝（与旧的整包 JSON 拷贝同语义，切断对快照对象的引用）
        sessionData.chatStream = replayPartialBlocks(state.streamMessage.content)
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
