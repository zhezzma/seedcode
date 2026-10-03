import { reactive, computed, type ComputedRef } from 'vue'

import { SessionRow, useSessionsState } from './useSessionsState'
import { apiGet, apiPost, apiDelete } from './api-client'
import { startChatSSE, attachSessionSSE, startRetrySSE, startEditSSE, type ChatPromptBody, type SSEConnection, type SSEEventHandler } from './sse-client'
import { AgentInfo, useAgentsState } from './useAgentsState'
import { applyAttachMessageState, getLastMessageEntryId, markContentIndex, replayPartialBlocks, shouldAttachSession } from '../utils/chat-attach'
import { blocksTextSignature, hasAssistantTextContent, solidifyAssistantContent } from '../utils/chat-solidify'
import { findToolBlockInMessages } from '../utils/tool-event-target'
import { isAbortErrorMessage } from '../utils/chatMessageRender'
import { type KnownApi } from './useModelsState'
import { useToast } from './useToast'
import { clearAllSurfaces } from './useA2UISurfaces'
import { createRuntimeId } from '../utils/runtime-id.ts'
import { onServerMessage } from './notify-server-connection'
import { i18n } from '../i18n'
import {
    applyQueueSnapshot,
    consumeQueueHead,
    consumeRemovedEcho,
    extractUserText,
    type PendingItem,
    type PendingSendMode,
    type RemovedEcho,
    type ServerQueueEntry,
} from '../utils/pending-queue'
import router from '../router'

// ==================== Types ====================
export interface ChatMessage {
    id?: string
    role: 'user' | 'assistant' | 'toolResult' | 'custom'
    content: any
    timestamp?: number
    model?: string
    provider?: string
    api?: KnownApi | (string & {})
    errorMessage?: string
    toolCallId?: string
    isError?: boolean
    details?: any
    entryId?: string
    parentEntryId?: string | null
    toolName?: string // 历史 /messages 与流式 tool_execution_end 的 toolResult 均携带（todo 提取器两条路径都依赖）
    /** pi 消息通用字段：display=false 面向模型（扩展注入的隐性提醒等），不进用户聊天记录 */
    display?: boolean
    /** 展示类 custom（面板/图片卡）：服务端通道归位后的 custom_message 条目
     * （/messages 投影携带 type==='custom_message' + customType；旧引擎历史与
     *  live 追加为 role==='custom' + customType）——展示层并入前一条 assistant 气泡 */
    type?: string
    customType?: string
}

export interface ChatAttachment {
    id: string
    name: string
    dataUrl: string
    mimeType: string
    content?: string
}

export interface SessionUsage {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    /** pi 0.80.x 起 usage 可单独累计 reasoning tokens（output 的子集）；缺省时按 0 处理 */
    reasoning?: number
    cost: number
    /** 当前上下文占用的 token 数（预留字段，前端暂未使用，后端在 compaction 后可能返回 null） */
    contextTokens: number | null
    contextWindow: number
    percent: number | null
    autoCompactEnabled: boolean
}

export interface ChatSessionData {
    chatMessages: ChatMessage[]
    chatToolMessages: ChatMessage[]
    /** busy 期间 steer/follow-up 的排队队列（服务端权威，快照整体替换） */
    pendingQueue: PendingItem[]
    /** 队列快照版本号：applyQueueSnapshot 乱序防护门禁 */
    queueRev?: number
    /** 近期被快照移除的条目（WS 快照先于 SSE 回显时补齐正式气泡的比对缓存） */
    queueRemovedEchoes?: RemovedEcho[]
    // Branch navigation uses a flat entry list, not a nested tree payload.
    sessionTree: SessionTreeEntry[] | null
    sessionLeafId: string | null
    chatStream: any[] | null
    chatStreamStartedAt: number | null
    chatSending: boolean
    chatRunId: string | null
    chatLoading: boolean
    /** 上下文压缩进行中（compaction_start/end 事件驱动；手动 /compact、阈值自动压缩、
     * 扩展触发的在线压缩均适用）。瞬态：随 resetStreamState 兑底清零防断连残留 */
    compacting?: boolean
    sessionUsage: SessionUsage | null
}

export interface ChatState {
    sessionKey: string
    sessionsMap: Map<string, ChatSessionData>
    // 当前会话信息不再缓存行对象：同一 session 在列表桶与历史快照里可能存在多个
    // 行实例（列表刷新/upsert 会换新对象），缓存实例会让标签写入与读取源分叉。
    // currentSession 由 currentSession computed 按 sessionKey 实时从列表行推导（见 _methods）。
    // 当前选中的 Agent ID（新会话场景下由 UI 下拉菜单驱动）
    agentsSelectedId: string
}

// Per-session SSE connections
const sseConnections = new Map<string, SSEConnection>()

const state = reactive<ChatState>({
    sessionKey: '',
    sessionsMap: new Map<string, ChatSessionData>(),
    agentsSelectedId: '',
})

// ==================== Helpers ====================

function generateUUID(): string {
    return createRuntimeId('chat')
}

/** 重置会话的流状态（chatSending / chatRunId / chatStreamStartedAt / chatStream / compacting） */
function resetStreamState(sd: ChatSessionData) {
    sd.chatSending = false
    sd.chatRunId = null
    sd.chatStreamStartedAt = null
    sd.chatStream = null
    // 压缩状态跟随 SSE 生命周期兑底清理：正常由 compaction_end 驱动，
    // 连接收尾/中断时事件可能缺失，残留会让压缩指示器永久亮着
    sd.compacting = false
}

/** 绑定 SSE 连接的生命周期清理：done / catch 时统一重置状态并移除连接。
 *  cleanup 必须做身份校验：retry/edit/compact 是先 abort 旧流再绑新流，
 *  旧流的 done 在微任务里兑现时新流可能已完成绑定，若无校验会把新 run 的
 *  状态清零、并把新连接从 sseConnections 误删（导致连接配额耗尽问题复发）。 */
function bindSSELifecycle(sse: SSEConnection, targetKey: string) {
    sseConnections.set(targetKey, sse)
    const cleanup = () => {
        if (sseConnections.get(targetKey) !== sse) return
        resetStreamState(getSessionData(targetKey))
        sseConnections.delete(targetKey)
    }
    sse.done.then(cleanup).catch(cleanup)
}

/** 切走会话时断开该会话的本地 SSE 连接（attach / chat / retry / edit 流共用一个 Map）。
 *  背景：浏览器 HTTP/1.1 对同一 host 的并发连接上限为 6 条，此前切走会话不 abort，
 *  每个运行中的 session 长期占用一条连接，≥5 个运行中会话即耗尽配额，导致后续所有
 *  请求全局排队（Stalled），只有刷新页面才恢复。断开后客户端任意时刻只持有当前会话
 *  的 1~2 条连接，与运行中 session 数量解耦。
 *  语义：只断本地流，不请求服务端停止——服务端 run 继续跑完，切回时
 *  attachToSessionIfNeeded 以 afterEntryId 增量重放 + partialText 追平 UI。 */
function abortSessionSSE(targetKey: string) {
    const sse = sseConnections.get(targetKey)
    if (sse) {
        sse.abort()
        sseConnections.delete(targetKey)
    }
}

// 各 session 最近一次完整历史加载（loadChatHistory 成功拉到 /messages）的时间。
// attach 对空闲会话立即回 message_state -> done，若历史刚全量加载过（间隔仅一个
// RTT），done 分支的消息/树重拉与这次加载完全重复，可据此跳过（见
// attachToSessionIfNeeded 的 skipSettledRefresh）。时间上远于窗口的 done、或 attach
// 期间见过流活动的真实流 done 不受影响。
// 用 performance.now()（单调时钟）：Date.now() 会被 NTP 回拨/休眠恢复拉长窗口，
// 危险方向是「非新鲜被误判为新鲜」，跳过本该追平离开期间变化的刷新。
const historyLoadedAt = new Map<string, number>()
const HISTORY_LOAD_FRESH_MS = 1500

function isHistoryLoadFresh(targetKey: string): boolean {
    const loadedAt = historyLoadedAt.get(targetKey)
    return loadedAt !== undefined && performance.now() - loadedAt < HISTORY_LOAD_FRESH_MS
}

// 导出供跨 composable 复用（useA2UIActions：面板提交后服务端 steer 续跑 run 的流附着入口）。
// 语义不变：已有活跃 SSE 时跳过（shouldAttachSession）。
export function attachToSessionIfNeeded(targetKey: string) {
    if (!shouldAttachSession(sseConnections.has(targetKey))) {
        return
    }

    const sessionData = getSessionData(targetKey)
    const afterEntryId = getLastMessageEntryId(sessionData.chatMessages)
    // 是否见过流中信号：见过则后续 done 是真实流结束，必须全量刷新，不可跳过
    let attachSawStreaming = false
    const sse = attachSessionSSE(
        targetKey,
        (event) => {
            if (event.event === 'message_state') {
                const currentSessionData = getSessionData(targetKey)
                applyAttachMessageState(currentSessionData, event.data || {})
                // attach 快照携带服务端权威排队队列：刷新/切会话后与消息同帧恢复

                if (event.data?.isStreaming || event.data?.compacting) {
                    attachSawStreaming = true
                    currentSessionData.chatRunId = currentSessionData.chatRunId || generateUUID()
                    currentSessionData.chatStreamStartedAt = currentSessionData.chatStreamStartedAt || Date.now()
                }
                return
            }

            // 加固：message_state 之外的任何事件（delta/start/end/error 等）都是
            // 真实流活动的证据——快照说空闲但随后来了流事件，说明 attach 落在了
            // 运行间隙，其 done 必须刷新，不可按空闲 done 跳过
            if (event.event !== 'done') {
                attachSawStreaming = true
            }

            // 空闲 attach 的 done：紧随 loadChatHistory 的全量加载，重拉纯重复，跳过。
            // 真实流 done（见过 streaming）与历史非新鲜的空闲 done（缓存会话切回，
            // 靠它追平离开期间的变化）都不跳过。
            const skipSettledRefresh = event.event === 'done' && !attachSawStreaming
                && isHistoryLoadFresh(targetKey)
            handleSSEEvent(event.event, event.data, targetKey, { skipSettledRefresh })
        },
        () => resetStreamState(sessionData),
        { afterEntryId }
    )

    bindSSELifecycle(sse, targetKey)
}

function getSessionData(key: string): ChatSessionData {
    let data = state.sessionsMap.get(key)
    if (!data) {
        data = reactive<ChatSessionData>({
            chatMessages: [],
            chatToolMessages: [],
            pendingQueue: [],
            sessionTree: null,
            sessionLeafId: null,
            chatStream: null,
            chatStreamStartedAt: null,
            chatSending: false,
            chatRunId: null,
            chatLoading: false,
            compacting: false,
            sessionUsage: null,
        })
        state.sessionsMap.set(key, data)
    }
    return data
}

// ==================== Pending Queue（busy 期间 steer/follow-up 排队可视化） ====================
// 服务端权威：本地只维护内存视图，三个同步通道（attach 快照 / WS queue_state 广播 /
// DELETE 响应）到达即整体替换；回显命中仅做无 RTT 的即时出队，随后快照权威修正。

/** 入队（steer/follow API 成功后调用；id 为服务端账本签发的 entryId）。
 *  按 id 去重：服务端 registerQueued 的 WS 快照可能先于 HTTP 响应到达（跨连接无顺序
 *  保证），快照已含本条目时跳过 append，避免同一气泡出现两次。
 *  queueRev 门禁：本地已应用「比登记更新」的快照（消息入队后立即被 drain/删除），
 *  append 会复活已消费条目的幻影气泡，直接跳过（后续无快照修正它，不能加）。 */
function enqueuePendingItem(targetKey: string, id: string, text: string, mode: PendingSendMode, queueRev?: number) {
    const sd = getSessionData(targetKey)
    if (sd.pendingQueue.some(entry => entry.id === id)) return
    if (typeof queueRev === 'number' && typeof sd.queueRev === 'number' && sd.queueRev > queueRev) return
    sd.pendingQueue = [...sd.pendingQueue, { id, text, mode, timestamp: Date.now() }]
}


// ==================== Actions ====================

/**
 * 随消息一并提交给服务端的会话状态覆盖。
 * 新会话页的模型/思考选择不即时下发，在首条消息发送时一起生效。
 */
export interface ChatSendOverrides {
    /** 'provider/modelId' 格式 */
    model?: string
    thinkingLevel?: string
}

/** 拆分 'provider/modelId'；modelId 本身可含 '/'（如 openrouter 的 vendor 前缀），第一段为 provider */
export function splitModelId(model: string): { provider: string; model: string } | null {
    const sep = model.indexOf('/')
    if (sep <= 0) return null
    return { provider: model.slice(0, sep), model: model.slice(sep + 1) }
}

const sendMessage = async (message?: string, attachments?: ChatAttachment[], sessionKey?: string, overrides?: ChatSendOverrides) => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) {
        console.error('[useChatState] sendMessage called without sessionKey')
        return
    }

    const text = message || ''
    const images = attachments?.filter(a => a.dataUrl).map(a => a.dataUrl) || []

    if (!text.trim() && images.length === 0) return

    const sessionData = getSessionData(targetKey)
    const sessionId = targetKey

    // Prepare optimistic content (text + images)
    let optimisticContent: any = text
    if (images.length > 0) {
        const blocks: any[] = []
        if (text) {
            blocks.push({ type: 'text', text })
        }
        images.forEach(webUrl => {
            const matches = webUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (matches) {
                blocks.push({
                    type: 'image',
                    mimeType: matches[1],
                    data: matches[2]
                })
            }
        })
        optimisticContent = blocks
    }

    // Add user message to per-session data
    sessionData.chatMessages = [...sessionData.chatMessages, {
        role: 'user',
        content: optimisticContent,
        timestamp: Date.now(),
        id: generateUUID()
    }]

    const runId = generateUUID()
    sessionData.chatSending = true
    sessionData.chatRunId = runId
    sessionData.chatStreamStartedAt = Date.now()
    sessionData.chatStream = [] // Initialize as array

    // Start SSE
    const body: ChatPromptBody = { prompt: text }
    if (images.length > 0) {
        body.images = images
    }
    // 覆盖的模型格式见 splitModelId
    if (overrides?.model) {
        const split = splitModelId(overrides.model)
        if (split) {
            body.provider = split.provider
            body.model = split.model
        }
    }
    if (overrides?.thinkingLevel) {
        body.thinkingLevel = overrides.thinkingLevel
    }

    // Abort any existing SSE for this session
    const existingSSE = sseConnections.get(targetKey)
    if (existingSSE) {
        existingSSE.abort()
    }

    const sse = startChatSSE(
        sessionId,
        body,
        (event) => {
            handleSSEEvent(event.event, event.data, targetKey)
        },
        (error) => {
            // HTTP 级失败（网络断开/服务重启/双窗口并发首发 409）：流未建立，乐观 user
            // 消息从未被持久化——按 case 'error' 同规则回滚末条无 entryId 的 user 消息并
            // toast，否则幻影气泡残留至下次 done 全量刷新（与流内 error 路径口径一致）
            resetStreamState(sessionData)
            const msgs = sessionData.chatMessages
            if (msgs.length > 0) {
                const lastMsg = msgs[msgs.length - 1]
                if (lastMsg.role === 'user' && !lastMsg.entryId) {
                    sessionData.chatMessages = msgs.slice(0, -1)
                }
            }
            useToast().error(error.message, 5000)
        }
    )

    bindSSELifecycle(sse, targetKey)
}

// 处理 command_delta 事件的副作用
// 后端通过 command_delta 显式告知命令类型和数据，前端根据命令名执行对应的副作用
const handleCommandDelta = (data: any, targetKey: string) => {
    const sessionData = getSessionData(targetKey)
    const command = data?.command as string
    if (!command) return

    switch (command) {
        case 'model': {
            // /model 命令：更新当前会话的模型
            // 契约：handleModelCommand 的 data 恒含 provider + model，二者缺一即异常
            // 回声，跳过以免把 modelProvider 写成 undefined 导致标签回退 agent 默认值
            const model = data.data?.model
            const provider = data.data?.provider
            if (model && provider) {
                patchSessionRowEverywhere(targetKey, { model, modelProvider: provider })
            }
            break
        }
        case 'thinking': {
            // /thinking 命令：更新当前会话的思考状态（统一走双面写入出口）
            const thinking = data.data?.thinkingLevel
            if (thinking) {
                patchSessionRowEverywhere(targetKey, { thinkingLevel: thinking })
            }
            break
        }
        case 'reset':
            // /reset 命令：清空当前会话的所有消息
            sessionData.chatMessages = []
            sessionData.chatToolMessages = []
            sessionData.chatStream = null
            break
        case 'name': {
            // /name 命令：更新会话名称（后端已持久化，此处仅同步前端状态）
            const newName = data.data?.name
            if (newName) {
                patchSessionRowEverywhere(targetKey, { name: newName })
            }
            break
        }
        case 'new':
        case 'fork': {
            // /new、/fork 命令：服务端已创建/分叉新会话，前端切换过去
            const newSessionId = data.data?.sessionId
            if (newSessionId) {
                const sessionsState = useSessionsState()
                // 刷新会话列表（让新会话出现在侧边栏）
                sessionsState.loadSessions()
                // 切换到新会话并导航
                setSessionKey(newSessionId)
                router.push({ name: 'chat', params: { sessionkey: newSessionId } })
            }
            break
        }
        default:
            // 其他命令暂无特殊前端副作用
            break
    }
}

const allowCustomType = ["generated_image"]

/** 压缩失败文案本地化：服务端固定英文原文（Nothing to compact / Already compacted）。
 * 未命中映射返回原文，保留真实错误信息 */
const localizeCompactError = (raw: string): string => {
    if (/nothing to compact/i.test(raw)) return (i18n.global as any).t('chat.compactNothingToDo')
    if (/already compacted/i.test(raw)) return (i18n.global as any).t('chat.compactAlreadyDone')
    return raw
}
// 处理 SSE 事件，更新会话状态
// 【重要】服务器协议说明：
// - 每次对话开始时，服务器会先通过 message_start/message_end 回显用户发送的消息（role: user）
// - 然后才开始推送 assistant 的响应（message_start + text_delta/thinking_delta + message_end）
// - Gemini 等模型可能在一个 turn 内发生多次 message_start/message_end（分别对应 thinking、工具调用、回复等）
const handleSSEEvent = (eventType: string, data: any, targetKey: string, options?: { skipSettledRefresh?: boolean }) => {
    const sessionData = getSessionData(targetKey)
    // chatStream 为 null 时（如 message_end 后等待下一条消息），懒初始化为空数组
    // 这样后续的 delta 事件可以直接 push，无需额外判断
    if (!sessionData.chatStream) {
        sessionData.chatStream = []
    }
    const stream = sessionData.chatStream as any[]

    switch (eventType) {
        case 'message_start': {
            // 消息开始：服务器可能推送 user 消息回显或 assistant 消息开始
            // steer / follow-up 落盘时的 user 回显：命中本地 pending 队头 → 立即出队，
            // 回显内容直接 append 为正式气泡（无缝转正）；
            // sendMessage 正常路径的回显不命中（队列为空或文本不符）→ 忽略，乐观气泡已覆盖
            const echoMsg = data?.message
            if (echoMsg?.role === 'user') {
                const echoText = extractUserText(echoMsg.content)
                // 即时出队（无 RTT）；模板展开改写导致未命中时，由服务端 queue_state 快照权威修正
                const consumed = echoText ? consumeQueueHead(sessionData.pendingQueue, echoText) : null
                if (consumed) {
                    sessionData.pendingQueue = consumed.rest
                    sessionData.chatMessages = [...sessionData.chatMessages, {
                        role: 'user',
                        content: echoMsg.content,
                        timestamp: typeof echoMsg.timestamp === 'number' ? echoMsg.timestamp : consumed.item.timestamp,
                        id: generateUUID(),
                    }]
                } else if (echoText && consumeRemovedEcho(sessionData, echoText)) {
                    // 服务端 WS 删除快照恒先于本回显到达（账本监听器先注册，广播早于 SSE 转发），
                    // 条目已被权威快照出队；回显即证明消息已实际投递 → 照常补齐正式气泡，
                    // 避免长 run 期间消息在聊天区隐身（直到 done 全量刷新才出现）
                    sessionData.chatMessages = [...sessionData.chatMessages, {
                        role: 'user',
                        content: echoMsg.content,
                        timestamp: typeof echoMsg.timestamp === 'number' ? echoMsg.timestamp : Date.now(),
                        id: generateUUID(),
                    }]
                }
            }
            // 特殊处理带有完整 content 的初始消息（如 custom 角色消息等）
            if (data?.message?.role == "custom" && allowCustomType.includes(data?.message?.customType)) {
                if (Array.isArray(data.message.content)) {
                    stream.push(...data.message.content)
                } else if (typeof data.message.content === 'string') {
                    stream.push({ type: 'text', text: data.message.content })
                }
            }
            // assistant 首批播种：pi-durable 语义下首批文本只随 message_start 的 partial
            // 消息落位（后续 text_delta 由 viewOps 追加派生，与首批互斥），不播种则每条
            // live 观看的消息缺头（缺多少 = 首个 ~100ms flush 窗口的 token 量；
            // openai-completions/gemini 协议建块即带文本几乎必缺，anthropic/responses
            // 空块先落、首批跨 flush 边界才缺）。重放消息（message_start 携带全文）经此
            // 即时上屏，与 attach 快照重放同构（replayPartialBlocks）。
            if (echoMsg?.role === 'assistant') {
                // 防重：attach 快照重放 / 重发 message_start 已按 _ci 播种过的块不重复入流
                //（否则重复消息头部翻倍）；text_delta 路径本身有 _ci 查重，这里补齐播种侧
                for (const block of replayPartialBlocks(echoMsg.content)) {
                    const seededCi = (block as any)?._ci
                    if (typeof seededCi === 'number' && stream.some((b: any) => b._ci === seededCi)) continue
                    stream.push(block)
                }
            }
            break
        }
        case 'text_delta':
        case 'thinking_delta': {
            // 合并文本增量（text_delta）或思考过程增量（thinking_delta）
            // 定位策略（两层）：
            // 1. 优先按服务端转发的 contentIndex（pi 消息 content 数组下标）定位目标块：
            //    openai 兼容网关（如 step 系列模型）的 reasoning 增量可能交错出现在
            //    正文中间，但始终指向消息里同一个 thinking 块（contentIndex 不变）。若按
            //    「末尾块同类型才合并」处理，mid-text 思考增量会被当成新块插进正文中间，
            //    正文被劈成两段、思考块翻倍（流式渲染与落盘历史不一致）。
            //    新下标首次出现 → 在末尾新建带 _ci 标记的块（内容顺序与下标顺序一致）。
            // 2. contentIndex 缺省（旧服务端）：退回「末尾块同类型则追加，否则新建」。
            // _ci 是纯前端流内路由标记：定义与打标见 chat-attach.markContentIndex，
            // 固化时随 JSON 深拷贝天然剥离，不进历史。
            const type = eventType === 'text_delta' ? 'text' : 'thinking'
            const contentKey = type // 'text' or 'thinking'

            if (data?.delta) {
                const ci = typeof data.contentIndex === 'number' ? data.contentIndex : null
                let targetBlock: any = null
                if (ci !== null) {
                    targetBlock = stream.find((b: any) => b._ci === ci)
                    if (!targetBlock) {
                        targetBlock = { type, [contentKey]: data.delta }
                        markContentIndex(targetBlock, ci)
                        stream.push(targetBlock)
                    } else {
                        targetBlock[contentKey] = (targetBlock[contentKey] || '') + data.delta
                    }
                } else {
                    const lastBlock = stream.length > 0 ? stream[stream.length - 1] : null
                    if (lastBlock?.type === type) {
                        // 同类型：追加到末尾 block
                        lastBlock[contentKey] = (lastBlock[contentKey] || '') + data.delta
                    } else {
                        // 不同类型（如从 thinking 切换到 text）：插入新 block
                        stream.push({ type, [contentKey]: data.delta })
                    }
                }
            }
            break
        }
        case 'tool_execution_start':
            // 查重（与 update/end 的查找同规则）：重连/attach 场景下 toolCall block
            // 可能已存在于本地——服务端在 assistant message_end（消息落盘，含
            // toolCall block）之后才执行工具并发 start；而 loadChatHistory/attach
            // 快照拉回的正是落盘数据。此时再无条件 push 会产生同 id 双卡（历史卡
            // 永远转圈 calling + stream 卡正常跑完），直到 done 全量刷新才消失。
            // 正常 live 流不受影响：message_end 固化的是本地 stream（服务端只转发
            // text/thinking delta，本地 stream 无 toolCall block），start 到达时历史
            // 无同 id 卡，照常建卡。
            if (data.toolCallId) {
                const existing = stream.find(item => item.type === 'toolCall' && item.id === data.toolCallId)
                    || findToolBlockInMessages(sessionData.chatMessages, data.toolCallId)
                if (existing) break
            }
            // 添加新的工具调用 Block
            stream.push({
                type: 'toolCall',
                id: data.toolCallId,
                name: data.toolName,
                toolState: 'calling',
                arguments: data.args
            })
            break
        case 'tool_execution_update':
            // 工具参数更新，支持 partialResult
            if (data) {
                let toolCallItem = null
                if (data.toolCallId) {
                    toolCallItem = stream.find(item => item.type === 'toolCall' && item.id === data.toolCallId)
                }

                // Fallback to last item (optional but safe)
                if (!toolCallItem && stream.length > 0) {
                    const last = stream[stream.length - 1]
                    if (last.type === 'toolCall' && last.name === data.toolName) {
                        toolCallItem = last
                    }
                }

                // 刷新重连场景：工具执行于 assistant message_end 之后（pi 落盘后清空
                // streamingMessage），toolCall block 只在历史消息里，chatStream 恒为空。
                // 服务端 attach 重放的快照与后续 live 事件都靠这里落到历史 block 上
                if (!toolCallItem) {
                    toolCallItem = findToolBlockInMessages(sessionData.chatMessages, data.toolCallId)
                }

                if (toolCallItem) {
                    // Update arguments if present
                    if (data.args) {
                        // If args is string, append (for streaming args). If object, merge/replace.
                        if (typeof data.args === 'string') {
                            toolCallItem.arguments = (toolCallItem.arguments || '') + data.args
                        } else {
                            toolCallItem.arguments = { ...toolCallItem.arguments, ...data.args }
                        }
                    }

                    // Update partial result (e.g. streaming output)
                    if (data.partialResult) {
                        toolCallItem.toolResult = data.partialResult.content
                        // 存储 details（subagent 工具的进度数据）
                        if (data.partialResult.details) {
                            toolCallItem.toolDetails = data.partialResult.details
                        }
                    }
                }
            }
            break
        case 'tool_execution_end':
            // 1. Find the tool call item
            let toolCallItem = null

            if (data.toolCallId) {
                // Precise lookup by ID
                toolCallItem = stream.find(item => item.type === 'toolCall' && item.id === data.toolCallId)
            }

            // Fallback: search by name and state (as before)
            if (!toolCallItem && stream.length > 0) {
                for (let i = stream.length - 1; i >= 0; i--) {
                    const item = stream[i]
                    if (item.type === 'toolCall' && item.name === data.toolName && (!item.toolState || item.toolState === 'calling')) {
                        toolCallItem = item
                        break
                    }
                }
            }

            // 刷新重连场景的历史 block 二级查找（同 tool_execution_update 的回退逻辑）
            if (!toolCallItem) {
                toolCallItem = findToolBlockInMessages(sessionData.chatMessages, data.toolCallId)
            }

            if (toolCallItem) {
                // Update final result and status
                toolCallItem.toolResult = data.result.content
                toolCallItem.toolError = data.isError ? (typeof data.result === 'string' ? data.result : JSON.stringify(data.result)) : undefined
                toolCallItem.toolState = data.isError ? 'error' : 'success'
                // 保存 details（subagent 最终结果详情）
                if (data.result.details) {
                    toolCallItem.toolDetails = data.result.details
                }
            }

            // 2. Add independent ToolResult message for history integrity
            sessionData.chatToolMessages = [...sessionData.chatToolMessages, {
                role: 'toolResult',
                content: data.result.content,
                toolName: data.toolName,
                timestamp: Date.now(),
                // 变体兜底：历史 block 形如 {type:'toolCall', toolCallId:'x'}（无 id）时，
                // 仅取 item.id 会丢失定位 → 1.1 合并静默失效（就地写入已保终态，此为备份路径）
                toolCallId: toolCallItem ? (toolCallItem.id ?? toolCallItem.toolCallId) : data.toolCallId,
                isError: data.isError,
                details: data.result?.details
            }]

            break
        case 'message_end': {
            // 【关键逻辑】仅当 stream 有实际内容（或服务端权威全文/错误信息在位）时，
            // 才将其固化为正式消息并重置 chatStream
            //
            // 背景：服务器在每次对话开始时会先发一对 message_start/message_end 来回显用户消息
            // （此时 stream 为空），随后才会开始推送 assistant 的内容；空 stream 不固化，
            // 避免 [] → null → [] 的状态跳变破坏 loading 动画连续性。
            //
            // 中断签名（abort，用户停止 / 扩展设计内中断如在线压缩前的 abort）语义是
            // 「有意中断」而非故障：空内容不产生气泡（压缩窗口由瞬态压缩行接管展示）；
            // 半截内容照常固化。errorMessage 始终如实保留（含未执行 toolCall 的终态
            // 标记依赖它），中性渲染由 processedMessages 按中断签名统一决定——流式与
            // 历史两路径同规则，不会出现流式无错、done 刷新后变红色错误的分叉
            const endMsg = data?.message
            const rawError = endMsg?.role === 'assistant' ? endMsg?.errorMessage : undefined
            const aborted = isAbortErrorMessage(rawError)
            const hasError = !!rawError && !aborted

            if (stream.length > 0 || hasError || hasAssistantTextContent(endMsg)) {
                // 用服务端权威全文修补本地拼接流后再固化（补首/末批与跨块首批；
                // 超短回复整条只在 message_end 落位的也经此上屏），详见 chat-solidify.ts。
                // 仅 assistant 消息提供权威全文；user 回显 / 旧服务端路径原样固化。
                const solidifyContent = solidifyAssistantContent(
                    stream,
                    endMsg?.role === 'assistant' ? endMsg?.content : undefined,
                    { isToolCallInHistory: (id) => !!findToolBlockInMessages(sessionData.chatMessages, id) },
                )
                // 有内容或有错误信息：固化为一条正式的 assistant 消息
                if (solidifyContent.length > 0 || hasError) {
                    // 防重放：同一 assistant message_end 重复到达（快照重放/重试流，含
                    // 播种后流非空的路径）不固化第二条——签名 = 文本签名 + 服务端
                    // 时间戳：同一消息重放两因子必相同；两条合法的连续同文回复时间戳
                    // 必不同，不会误杀。仅在服务端携带 timestamp 时生效（旧服务端
                    // 不具备新门禁，维持旧行为；误漏的重复由 done 全量刷新兑底）
                    if (!hasError && typeof endMsg?.timestamp === 'number') {
                        const signature = blocksTextSignature(solidifyContent)
                        // 有界窗口扫描而非只看末条：原消息与重放之间可能插入了
                        // custom 面板消息、回显气泡等非 assistant 条目
                        if (signature && sessionData.chatMessages.slice(-4).some((last: any) =>
                            last?.role === 'assistant'
                            && last.timestamp === endMsg.timestamp
                            && blocksTextSignature(last.content) === signature)) {
                            sessionData.chatStream = null
                            break
                        }
                    }
                    const msg: ChatMessage = {
                        role: 'assistant',
                        content: solidifyContent, // 深拷贝，防止引用被后续操作修改
                        timestamp: endMsg?.timestamp || Date.now(),
                        id: generateUUID(),
                        model: endMsg?.model,
                        provider: endMsg?.provider,
                        api: endMsg?.api,
                    }
                    if (rawError) {
                        msg.errorMessage = rawError
                    }
                    sessionData.chatMessages = [...sessionData.chatMessages, msg]
                }
                // 全部被去重淘汰时同样要重置流（残留块已无效，不能留在 chatStream 里
                // 继续双显）；空 stream + 无错误的回显路径保持 [] 不变（loading 连续性）
                sessionData.chatStream = null
            }
            // stream 为空且无错误（user 消息回显）：直接跳过，保持 chatStream 为 [] 不变
            // loading 动画得以保持连续，不产生闪烁
            break
        }
        case 'custom_message': {
            // 展示类 custom 条目（服务端通道归位：question-render / questionnaire-render /
            // generated_image 等）：而板作为「当前 AI 回复的内嵌展示附件」落地——直接追加
            // 一条 role:'custom' 原始消息，展示层（useChatMessages 1.15）会把它并入前一条
            // assistant 气泡，不独立成「第二条 AI 回复」。与历史路径同形状，done 全量
            // 刷新幂等。
            const panelMsg: ChatMessage = {
                role: 'custom',
                customType: data?.customType,
                content: data?.data ?? [],
                entryId: data?.entryId,
                timestamp: Date.now(),
            }
            sessionData.chatMessages = [...sessionData.chatMessages, panelMsg]
            break
        }
        case 'command_delta':
            stream.push({ type: 'text', text: data.delta })
            // 命令事件：由后端显式推送，触发前端副作用（如 /reset 清空消息、/name 更新标题等）
            handleCommandDelta(data, targetKey)
            break
        case 'compaction_start':
            // 上下文压缩开始（手动 /compact、阈值自动压缩、扩展在线压缩均适用）：
            // 压缩期间流内无任何内容事件（实测 26~89s），记录状态供消息列表尾部的
            // 瞬态压缩行展示，避免用户误判为卡死
            sessionData.compacting = true
            break
        case 'compaction_end':
            // 压缩结束：无条件清零（start 丢失/乱序时也能收敛）
            sessionData.compacting = false
            break
        case 'turn_end':
        case 'agent_end':
        case 'agent_settled':
            // agent_end 在重试场景中每轮都会触发（auto_retry）；
            // agent_settled 在重试/压缩/continuation 全部完成后触发。
            // SSE done 由服务端在 settled 后发送，客户端只在 done 里终止会话。
            break
        case 'auto_retry_start':
            // 服务器开始自动重试，确保 chatSending 保持为 true
            // （stream 在上一轮 message_end 已重置为 null，此处重新初始化）
            sessionData.chatStream = []
            break
        case 'error': {
            // 服务端错误：回滚乐观插入的用户消息并清理状态
            resetStreamState(sessionData)
            // 注：此处刻意不清 chatToolMessages —— 工具结果可能在错误前已落盘，
            // 临时条目恰是最新真相（与 abort catch 路径同理）；残留由下次 done/retry/load 清理
            // 移除最后一条未被服务端确认的 user 消息（没有 entryId 说明从未被持久化）
            const msgs = sessionData.chatMessages
            if (msgs.length > 0) {
                const lastMsg = msgs[msgs.length - 1]
                if (lastMsg.role === 'user' && !lastMsg.entryId) {
                    sessionData.chatMessages = msgs.slice(0, -1)
                }
            }
            // 显示错误提示（压缩类固定英文文案本地化，避免中文 UI 裸英 toast）
            const errorMsg = localizeCompactError(data?.error || 'Unknown error')
            useToast().error(errorMsg, 5000)
            break
        }
        case 'done':
            // 会话彻底结束（包括所有重试完成后）
            resetStreamState(sessionData)
            // 空闲 attach 的 done（见 attachToSessionIfNeeded）：历史刚全量加载过，
            // 下面的 /messages + /entries 重拉与 loadChatHistory 完全重复，跳过；
            // 真实流 done 必须刷新——最后一条消息、树、usage 都在这次落地
            if (options?.skipSettledRefresh) {
                // usage 是三者中唯一没有其他追平通道的请求（loadChatHistory finally
                // 里那次若失败，这里就是唯一兜底），跳过重拉时仍轻量补一次
                fetchSessionUsage(targetKey)
                break
            }
            // 静默刷新消息，补上 entryId/parentEntryId（不设置 chatLoading，避免页面闪烁）
            apiGet<{ messages: ChatMessage[] }>(`/api/chat/${targetKey}/messages`).then(result => {
                if (result?.messages) {
                    const sd = getSessionData(targetKey)
                    sd.chatMessages = result.messages
                    // 服务端已持久化全部 toolResult entry，本地临时条目同步清空
                    //（同 loadChatHistory 规则）：不清会与持久化消息双重参与 1.1 合并，
                    // 幂等但永久残留，且随 sessionsMap 永不驱逐
                    sd.chatToolMessages = []
                    // Messages reloaded -> Tree structure definitely valid now
                    fetchSessionTree(targetKey)
                }
            }).catch(() => { /* 静默失败不影响使用 */ })
            // 刷新 usage 统计（消息结束后上下文占比可能已变化）
            fetchSessionUsage(targetKey)
            break
    }
}

const abortChat = async (sessionKey?: string) => {
    const targetKey = sessionKey || state.sessionKey
    const sse = sseConnections.get(targetKey)
    if (sse) {
        sse.abort()
        sseConnections.delete(targetKey)
    }
    if (targetKey) {
        const sd = getSessionData(targetKey)
        // 快照落地守卫：/abort 在途期间用户可能已 retry/edit/发新消息（新 run 的
        // chatRunId 会变、且会绑定新 SSE）。此刻的快照对新 run 是陈旧数据：落地会清掉
        // 新 run 的流状态、用旧分支消息覆盖 chatMessages（运行中带 entryId 的消息会让
        // 分支导航中途显形，进而在运行中切分支，把别的分支的流式气泡/思考占位符泄漏到
        // 目标分支视图）。新 run 的 SSE/done 自会刷新，整包丢弃。
        // 注意：被中止的 run 自身 chatRunId 恒非空，不能作为陈旧信号——必须比对
        // runId 是否发生变化（旧 SSE 的 cleanup 因身份校验不会 resetStreamState）。
        const runIdAtAbort = sd.chatRunId
        const abortSnapshotStale = () => sseConnections.has(targetKey) || sd.chatRunId !== runIdAtAbort
        try {
            const result = await apiPost<{ messages?: ChatMessage[], isStreaming?: boolean }>(`/api/chat/${targetKey}/abort`)
            if (abortSnapshotStale()) return
            // 服务端 /abort 已同步清空 steer/followUp 队列（含账本），本地排队视图一并清空
            if (sd.pendingQueue.length > 0) {
                sd.pendingQueue = []
            }
            if (result) {
                if (result.messages) {
                    sd.chatMessages = result.messages
                    // 与 done/loadChatHistory 同规则：持久化消息已落地，流式临时条目一并清空
                    //（否则 abort 后同一 toolResult 双份残留，随 sessionsMap 永不驱逐）。
                    // 已知空窗：并行批在 tool_execution_end 与批尾落盘之间被 abort 时，
                    // /abort 快照不含该未落盘 toolResult，面板短暂回退到上一条持久化快照。
                    // abort 后本轮不会再有 done 事件：收敛靠下一次 todo 调用（服务端重放对齐）、
                    // 下一轮 run 的 done 全量刷新或 loadChatHistory（error 路径保留临时条目同理）
                    sd.chatToolMessages = []
                }
                if (typeof result.isStreaming === 'boolean') {
                    sd.chatSending = result.isStreaming
                } else {
                    sd.chatSending = false
                }
            } else {
                sd.chatSending = false
            }
        } catch {
            // Ignore abort errors
            // 守卫同上：catch 路径的 chatSending=false / resetStreamState 同样不能压掉
            // 在途期间新启动 run 的状态
            if (abortSnapshotStale()) return
            sd.chatSending = false
        }
        resetStreamState(sd)

        // Refresh tree structure just in case the aborted message was saved
        fetchSessionTree(targetKey)
    }
}

const loadChatHistory = async (sessionKey?: string) => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) return
    const sd = getSessionData(targetKey)
    sd.chatLoading = true
    try {
        const sessionId = targetKey
        const result = await apiGet<{ messages: ChatMessage[], isStreaming?: boolean, partialText?: string }>(`/api/chat/${sessionId}/messages`)
        sd.chatMessages = result?.messages || []
        // 记录全量加载时间：紧随其后的 attach 若收到空闲 done，据此跳过重复刷新
        historyLoadedAt.set(sessionId, performance.now())
        // 页面刷新/切会话恢复：排队队列由紧随其后的 attach 快照（message_state）权威下发
        // 清空本地临时存储的 toolResult 消息，因为历史记录中应该已经包含（或者由 chatMessages 自行管理）
        sd.chatToolMessages = []

        // 不再依赖 /messages.isStreaming 决定是否 attach。
        // 只要本地没有该 session 的活跃 SSE，就 attach 一次，让服务端决定
        // 是立即 done（空闲）还是继续附着到当前已有流。
        attachToSessionIfNeeded(sessionId)
    } catch (err: any) {
        console.error('Failed to load chat history:', err)
    } finally {
        // Only set loading to false, don't touch chatSending if we are streaming
        sd.chatLoading = false
        // Finally, load the tree structure and usage stats for this session
        if (targetKey) {
            fetchSessionTree(targetKey)
            fetchSessionUsage(targetKey)
        }
    }
}

/**
 * 切换到已有会话
 * 1. 设置 sessionKey
 * 2. 通过 getSessionById 获取 session 信息 → upsert 进列表桶（currentSession computed 随之收敛）
 * 3. 通过 session.agentId 推导 agentsSelectedId 和 currentAgent
 * 4. 加载聊天历史
 */
const setSessionKey = async (key: string) => {
    // 切换到不同会话：先断开旧会话的 SSE 连接（见 abortSessionSSE 说明）。
    // 首次进入（sessionKey 为空串）与原地重进同一会话不 abort，
    // 切回正在流式的会话时其现有 SSE 保留不动（attachToSessionIfNeeded 会跳过）。
    const previousKey = state.sessionKey
    if (previousKey && previousKey !== key) {
        abortSessionSSE(previousKey)
    }

    // 在设置 sessionKey 之前先判断是否需要加载历史
    // 因为设置 sessionKey 后，UI 会通过 getter 读取数据，自动创建 sessionsMap entry
    const needsLoad = !state.sessionsMap.has(key)

    // 切换会话时清空 A2UI Surface 注册表（防止跨会话数据泄漏）
    clearAllSurfaces()

    state.sessionKey = key

    // 获取 session 信息（未缓存时拉取并 upsert 进列表桶）。
    // currentSession 由 computed 从列表行推导，无需在此赋值。
    const sessionsState = useSessionsState()
    const session = await sessionsState.getSessionById(key)
    if (session?.agentId) {
        state.agentsSelectedId = session.agentId
    }

    if (needsLoad) {
        await loadChatHistory(key)
    } else {
        attachToSessionIfNeeded(key)
    }
}

/**
 * 创建新会话（/new 页面）
 * 1. 清空 sessionKey（currentSession computed 随之归 null）
 * 2. currentAgent 由 agentsSelectedId 推导（用户通过下拉菜单选择）
 */
const createNewSession = async () => {
    // 返回 /new 页面：断开当前会话的 SSE 连接（同 setSessionKey，见 abortSessionSSE 说明）
    if (state.sessionKey) {
        abortSessionSSE(state.sessionKey)
    }
    state.sessionKey = ''

    // 新会话场景：currentAgent 将通过 getter 自动根据 agentsSelectedId 推导
}

/**
 * 选择 Agent（新会话下拉菜单触发）
 * 同时更新 agentsSelectedId 和 currentAgent
 */
const selectAgent = (agentId: string) => {
    state.agentsSelectedId = agentId
}

const steerMessage = async (message: string, sessionKey?: string): Promise<boolean> => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) {
        console.error('[useChatState] steerMessage called without sessionKey')
        return false
    }

    try {
        // 打断注入：服务端入 steering 队列，当前 run 内被消费；
        // 入队成功返回服务端账本签发的 entryId（凭它做单条删除/对账）
        const result = await apiPost<{ id?: string | null; queueRev?: number }>(`/api/chat/${targetKey}/steer`, { text: message })
        if (!result?.id) return true // 未入队（扩展命令被立即执行）：无排队气泡，消息已生效
        enqueuePendingItem(targetKey, result.id, message, 'steer', result.queueRev)
    } catch (err: any) {
        console.error('Failed to steer:', err)
        // 404/409 是 api-client 的静默错误码（无全局 toast），此处显式提示；
        // 其余失败 api-client 已 toast 过，不重复弹。调用方按 false 恢复输入框文本
        if ([404, 409].includes(err?.code)) {
            useToast().error(err?.message, 5000)
        }
        return false
    }

    return true
}

const followMessage = async (message: string, sessionKey?: string): Promise<boolean> => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) {
        console.error('[useChatState] followMessage called without sessionKey')
        return false
    }

    try {
        // 控制面：排队到当前 run 结束后再投递；转正信号同 steer（回显 + 服务端快照修正）
        const result = await apiPost<{ id?: string | null; queueRev?: number }>(`/api/chat/${targetKey}/follow-up`, { text: message })
        if (!result?.id) return true // 未入队（扩展命令被立即执行）：无排队气泡，消息已生效
        enqueuePendingItem(targetKey, result.id, message, 'follow', result.queueRev)
    } catch (err: any) {
        console.error('Failed to follow-up:', err)
        if ([404, 409].includes(err?.code)) {
            useToast().error(err?.message, 5000)
        }
        return false
    }

    return true
}

/** 删除排队单条：请求服务端从队列移除（真删除，消息不再发送），按响应快照对齐本地 */
const removePendingItem = async (id: string, sessionKey?: string) => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) return
    try {
        // 无论删除成功与否，响应都携带服务端权威快照（404 = 目标已不存在），照单同步
        const result = await apiDelete<{ deleted: boolean, queueRev?: number, entries: ServerQueueEntry[] }>(
            `/api/chat/${targetKey}/queue/${encodeURIComponent(id)}`,
        )
        applyQueueSnapshot(getSessionData(targetKey), result?.queueRev, result?.entries)
    } catch (err) {
        // 请求失败保持本地不变：服务端快照（WS 广播/attach）稍后会权威收敛
        console.error('[useChatState] removePendingItem failed:', err)
    }
}


// ==================== Retry / Branch ====================

/**
 * retry / edit 共用的「乐观改写分支 + 接线重写流」骨架（两路径唯一的状态机入口）。
 * 除两处差异外逐行一致，差异由调用方注入：
 *  - snapshot + beginOptimistic：retry 仅整体重赋值数组（引用快照即可），
 *    edit 会就地改写用户消息 content（必须浅拷贝快照，否则回滚停留新文本）；
 *  - startSSE：SSE 端点与请求体。
 * 错误回滚语义由 sawStreamEvent 门闩决定：流未建立（HTTP 级失败 400/409/5xx）
 * 恢复快照并 toast；流已建立说明服务端已改写树，不回滚，交由 done 重拉/attach 收敛。
 */
function beginBranchRewriteSSE(
    targetKey: string,
    opts: {
        /** 乐观改写前的消息快照（调用方按自身语义备好：引用 or 浅拷贝） */
        snapshot: { messages: ChatMessage[]; toolMessages: ChatMessage[] }
        /** 乐观更新（只动 chatMessages；流式临时条目由骨架统一作废） */
        beginOptimistic: (sd: ChatSessionData) => void
        /** 差异化流入口：用传入的回调启动具体 SSE 端点；onOpen = response.ok（首字节前），
         * 对 /retry /edit 即导航已提交的确认信号 */
        startSSE: (onEvent: SSEEventHandler, onError: (error: Error) => void, onOpen?: () => void) => SSEConnection
    },
): void {
    const sessionData = getSessionData(targetKey)
    let sawStreamEvent = false

    opts.beginOptimistic(sessionData)
    // 分支被改写：流式临时条目一并作废（同 abort 规则），
    // 否则被放弃分支的 todo 快照会以“数组位置更靠后”赢得 last-write-wins。
    // 刻意不放进 beginOptimistic：本地 chatMessages 陈旧（找不到目标条目）时分支在服务端照样被改写，清理不可跳过
    sessionData.chatToolMessages = []

    const runId = generateUUID()
    sessionData.chatSending = true
    sessionData.chatRunId = runId
    sessionData.chatStreamStartedAt = Date.now()
    sessionData.chatStream = []

    // Abort any existing SSE for this session
    const existingSSE = sseConnections.get(targetKey)
    if (existingSSE) {
        existingSSE.abort()
    }

    const sse = opts.startSSE(
        (event) => {
            sawStreamEvent = true
            handleSSEEvent(event.event, event.data, targetKey)
        },
        (error) => {
            if (sawStreamEvent) {
                // 流已建立：服务端已改写树，本地以 done 重拉/attach 收敛，不回滚
                resetStreamState(sessionData)
                return
            }
            sessionData.chatMessages = opts.snapshot.messages
            sessionData.chatToolMessages = opts.snapshot.toolMessages
            useToast().error(error.message, 5000)
            resetStreamState(sessionData)
        },
        // response.ok 即置位门闩：/retry /edit 的 handler 先 await navigate 再 return
        // Response，headers 到达 = 导航已提交；否则「导航已提交、首字节未达」窗口内断连
        // 会误回滚——客户端回到旧分支空闲态，服务端却在新分支继续跑，状态分叉
        () => { sawStreamEvent = true },
    )

    bindSSELifecycle(sse, targetKey)
}

const retryMessage = async (entryId: string, sessionKey?: string) => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) {
        console.error('[useChatState] retryMessage called without sessionKey')
        return
    }

    // 乐观删除前快照：流未建立的 HTTP 级失败（400/409/5xx）时恢复——
    // 否则回复气泡被乐观删除后不回滚（root 重试 400 时代的可见症状）。
    // 引用即可：本函数无就地改写消息对象，仅整体重赋值数组
    const sessionData = getSessionData(targetKey)
    const snapshot = { messages: sessionData.chatMessages, toolMessages: sessionData.chatToolMessages }

    beginBranchRewriteSSE(targetKey, {
        snapshot,
        beginOptimistic: (sd) => {
            // Remove the assistant message being retried from local state
            // (the server navigates back and re-prompts, creating a new branch)
            const entryIndex = sd.chatMessages.findIndex(m => m.entryId === entryId)
            if (entryIndex >= 0) {
                // Remove from the assistant entry onwards (it and any subsequent messages on this branch)
                // If the entry being retried is a user message, retain it.
                const isUserMsg = sd.chatMessages[entryIndex].role === 'user'
                if (isUserMsg) {
                    sd.chatMessages = sd.chatMessages.slice(0, entryIndex + 1)
                } else {
                    sd.chatMessages = sd.chatMessages.slice(0, entryIndex)
                }
            }
        },
        startSSE: (onEvent, onError, onOpen) => startRetrySSE(targetKey, { entryId }, onEvent, onError, onOpen),
    })
}

const editMessage = async (entryId: string, newText: string, sessionKey?: string) => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) {
        console.error('[useChatState] editMessage called without sessionKey')
        return
    }

    // 乐观删除前快照：流未建立的 HTTP 级失败（400/409/5xx）时恢复——
    // 否则回复气泡被乐观删除后不回滚。必须浅拷贝：下方就地改写 content，
    // 引用快照会让回滚后的文本停留为新文本而服务端仍是旧文本
    const sessionData = getSessionData(targetKey)
    const snapshot = { messages: sessionData.chatMessages.map(m => ({ ...m })), toolMessages: sessionData.chatToolMessages }

    beginBranchRewriteSSE(targetKey, {
        snapshot,
        beginOptimistic: (sd) => {
            // Keep the user message but update its text, remove everything after it
            const entryIndex = sd.chatMessages.findIndex(m => m.entryId === entryId)
            if (entryIndex >= 0) {
                // Update the user message content in-place
                sd.chatMessages[entryIndex].content = newText
                // Remove all messages after the user message (assistant responses on this branch)
                sd.chatMessages = sd.chatMessages.slice(0, entryIndex + 1)
            }
        },
        startSSE: (onEvent, onError, onOpen) => startEditSSE(targetKey, { entryId, newText }, onEvent, onError, onOpen),
    })
}

// ==================== Fork ====================

/**
 * 从指定消息处分叉出新会话（position:"at"，新会话包含该消息），成功后切换过去。
 * 用于用户/AI 消息下的“从此处分叉”按钮；原会话保留在侧边栏。
 */
const forkInFlight = reactive(new Set<string>())
const forkFromEntry = async (entryId: string, sessionKey?: string) => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) {
        console.error('[useChatState] forkFromEntry called without sessionKey')
        return
    }
    // 防双击：请求在途时忽略重复触发，避免分叉出多个会话
    const forkKey = `${targetKey}:${entryId}`
    if (forkInFlight.has(forkKey)) return
    forkInFlight.add(forkKey)

    try {
        const result = await apiPost<{ sessionId?: string }>(
            `/api/sessions/${encodeURIComponent(targetKey)}/fork`,
            { entryId, position: 'at' }
        )
        const newSessionId = result?.sessionId
        if (!newSessionId) return

        const sessionsState = useSessionsState()
        sessionsState.loadSessions()
        setSessionKey(newSessionId)
        router.push({ name: 'chat', params: { sessionkey: newSessionId } })
    } catch (err: any) {
        console.error('[useChatState] forkFromEntry failed:', err)
        // 404/409 在 api-client 的 SILENT_CODES 中不弹全局 toast，这里显式提示，避免按钮静默失败
        // （ApiError 恒带 message，无需兑底文案）
        if ([404, 409].includes(err?.code)) {
            useToast().error(err?.message, 5000)
        }
    } finally {
        forkInFlight.delete(forkKey)
    }
}

/** 某条消息的分叉请求是否在途（供按钮展示 loading/禁用） */
const isForkingEntry = (entryId: string, sessionKey?: string): boolean => {
    const targetKey = sessionKey || state.sessionKey
    return !!targetKey && forkInFlight.has(`${targetKey}:${entryId}`)
}

/** 会话是否正在压缩上下文（compaction_start/end 事件驱动，任意来源的压缩均适用） */
const isCompacting = (sessionKey?: string): boolean => {
    const targetKey = sessionKey || state.sessionKey
    return !!targetKey && getSessionData(targetKey).compacting === true
}

export interface SessionTreeEntry {
    id: string
    parentId: string | null
    type: string
    role?: string
    timestamp?: string
    preview?: string
}

/**
 * 会话偏好直改的在途请求记录（按 session 维护）。
 *
 * model / thinking 两类设置每次都改同一份 `SessionRow`（且 setModel 还会隐式重推
 * thinkingLevel），所以同一 session 的两次在途请求必须共用一个计数与一份确认态：
 *   - 无合并值的字段从当前行快照基准（视为「服务端已确认」；已被本批触碰的字段不补拍）；
 *   - 每次成功把响应的权威值合并进 confirmed（失败不合并）；
 *   - 在途数归零时把 confirmed 一次性写回缓存。
 *
 * 这样无论成功/失败如何交错，缓存最终要么是服务端确认的合成值，要么回退到
 * 最近一次确认值——不会停留在任何未被确认的乐观值（旧 seq 令牌方案在双失败
 * 交错时会落到 A 的未确认值上）。全局递增令牌还会把不同 session 的请求互相干扰，
 * 按 session 分桶一并解决。
 */
interface SessionSettingFlight {
    inflight: number
    /** 本批调用的发送序号（begin 递增），成功合并按此序号门闩，消除响应乱序影响 */
    seq: number
    confirmed: { modelProvider?: string; model?: string; thinkingLevel?: string }
    /** 各字段最后一次成功合并的发送序号 */
    mergedAt: { model: number; thinkingLevel: number }
    /** 本批是否有调用触碰过对应字段（settle 只写回触碰过的字段，不覆写外部并发修改） */
    dirty: { model: boolean; thinkingLevel: boolean }
}
const sessionSettingFlights = new Map<string, SessionSettingFlight>()

function beginSettingFlight(targetKey: string, targets: SessionRow[]): SessionSettingFlight {
    const session = targets[0] ?? null
    let entry = sessionSettingFlights.get(targetKey)
    if (!entry) {
        entry = {
            inflight: 0,
            seq: 0,
            confirmed: { modelProvider: undefined, model: undefined, thinkingLevel: undefined },
            mergedAt: { model: 0, thinkingLevel: 0 },
            dirty: { model: false, thinkingLevel: false },
        }
        sessionSettingFlights.set(targetKey, entry)
    }
    // 基准补拍（row 未就绪时延到后续调用）：只填「尚无合并值且未被本批触碰」的字段——
    // 已合并的权威值绝不能被晚到的基准快照覆盖；已被本批乐观补丁触碰的字段同样
    // 不能补拍，否则重叠双选全失败时会回滚到前一个 flight 的未确认乐观值
    // （dirty 由乐观补丁与成功合并共同置位，settle 后随记录一起销毁）
    if (entry.mergedAt.model === 0 && !entry.dirty.model) {
        entry.confirmed.modelProvider = session?.modelProvider
        entry.confirmed.model = session?.model
    }
    if (entry.mergedAt.thinkingLevel === 0 && !entry.dirty.thinkingLevel) {
        entry.confirmed.thinkingLevel = session?.thinkingLevel
    }
    entry.inflight++
    entry.seq++
    return entry
}

function endSettingFlight(targetKey: string, entry: SessionSettingFlight): void {
    entry.inflight--
    if (entry.inflight > 0) return
    sessionSettingFlights.delete(targetKey)
    // settle 时重新解析行实例：中途的列表刷新可能已把桶行换成新对象，
    // 确认值必须写进「现在还被 UI 读取」的实例
    const targets = resolveSettingTargets(targetKey)
    for (const session of targets) {
        if (entry.dirty.model) {
            session.modelProvider = entry.confirmed.modelProvider
            session.model = entry.confirmed.model
        }
        if (entry.dirty.thinkingLevel) {
            session.thinkingLevel = entry.confirmed.thinkingLevel
        }
    }
}

/**
 * 按 targetKey 解析写入目标。
 *
 * currentSession 是 derived computed（由 findSessionLocal(sessionKey) 实时推导），
 * 列表行即时唯一实例 —— 写入列表行即同时更新标签源与侧边栏，不再需要双写。
 * 会话未缓存（冷启动窗口）时返回空数组：请求照发，本地不写。
 */
function resolveSettingTargets(targetKey: string): SessionRow[] {
    const listed = useSessionsState().findSessionLocal(targetKey)
    return listed ? [listed] : []
}

/**
 * 等待目标行入桶（冷启动窗口：深链/刷新后 /info 在途，行尚未 upsert）。
 * 行出现前 begin flight 会因无写入目标而丢失本地确认值（settle 无处可写，
 * 记录随即删除）——表现为「切换成功但标签停在旧值」。故在 bounded 窗口内
 * 轮询等待；超时后照常继续（服务端仍会应用，本地标签待下次刷新收敛）。
 * 行已存在时为同步快速路径（零等待）。
 */
async function waitForSettingTargets(targetKey: string, timeoutMs = 2000): Promise<SessionRow[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const targets = resolveSettingTargets(targetKey)
        if (targets.length > 0) return targets
        if (Date.now() >= deadline) return []
        await new Promise((r) => setTimeout(r, 25))
    }
}

/**
 * 双写会话行的统一出口。
 *
 * 历史背景：同一 session 曾同时存在列表行与 currentSession 两个实例（upsert 双重
 * 展开所致），任何一个只能写单侧的写入方都会导致“切换/改名看起来没生效”。
 * 现在 currentSession 是 findSessionLocal 的 derived computed：写列表行即时同步
 * 标签源，本 helper 退化为语义占位，保证所有写入方走同一出口。
 */
const patchSessionRowEverywhere = (key: string, patch: Partial<SessionRow>): void => {
    useSessionsState().updateSessionLocal(key, patch)
}

/**
 * 直接切换当前会话模型（POST /model）：不写命令消息、不开 SSE。
 * 乐观回填本地 session 缓存让下拉标签立即切换；请求结束后由 flight 记录把缓存
 * 落定为服务端确认值（失败即回退基准快照）。
 * 404/409 是 api-client 的静默错误码，此处显式提示，其余失败 api-client 已 toast 过。
 * 响应携带服务端权威 thinkingLevel（setModel 会在 SDK 内按新模型隐式重推思考级别），
 * 成功后合并进确认态，避免标签停留在旧档位。
 */
const setSessionModel = async (modelId: string): Promise<boolean> => {
    const targetKey = state.sessionKey
    if (!targetKey) return false
    const split = splitModelId(modelId)
    if (!split) return false

    const targets = await waitForSettingTargets(targetKey)
    const entry = beginSettingFlight(targetKey, targets)
    const callSeq = entry.seq
    for (const session of targets) {
        session.modelProvider = split.provider
        session.model = split.model
    }
    if (targets.length > 0) {
        entry.dirty.model = true
    }

    try {
        const result = await apiPost<{ thinkingLevel?: string }>(`/api/chat/${targetKey}/model`, {
            provider: split.provider,
            model: split.model,
        })
        // 按发送序合并：响应乱序时旧调用的迟到合并不覆盖新调用已确认的值。
        // 合并即置 dirty —— dirty 的语义是「本批有值要落行」，不能只在 begin
        // 有目标时设置，否则冷启动/补拍批次里确认值到不了 settle
        if (callSeq > entry.mergedAt.model) {
            entry.mergedAt.model = callSeq
            entry.confirmed.modelProvider = split.provider
            entry.confirmed.model = split.model
            entry.dirty.model = true
        }
        if (result?.thinkingLevel && callSeq > entry.mergedAt.thinkingLevel) {
            entry.mergedAt.thinkingLevel = callSeq
            entry.confirmed.thinkingLevel = result.thinkingLevel
            // 服务端按新模型重推导的权威级别必须落行：置 dirty 才能通过 settle 写回，
            // 否则纯模型切换批次里该值永远停留在 confirmed（标签滞留旧档位）
            entry.dirty.thinkingLevel = true
        }
        return true
    } catch (err: any) {
        if ([404, 409].includes(err?.code)) {
            useToast().error(err?.message, 5000)
        }
        return false
    } finally {
        endSettingFlight(targetKey, entry)
    }
}

/**
 * 直接设置当前会话思考级别（POST /thinking-level）：语义同 setSessionModel，
 * 共用同一份 per-session flight 记录。
 */
const setSessionThinkingLevel = async (level: string): Promise<boolean> => {
    const targetKey = state.sessionKey
    if (!targetKey) return false

    const targets = await waitForSettingTargets(targetKey)
    const entry = beginSettingFlight(targetKey, targets)
    const callSeq = entry.seq
    for (const session of targets) {
        session.thinkingLevel = level
    }
    if (targets.length > 0) {
        entry.dirty.thinkingLevel = true
    }

    try {
        const result = await apiPost<{ thinkingLevel?: string }>(`/api/chat/${targetKey}/thinking-level`, {
            thinkingLevel: level,
        })
        // 以服务端 clamp 后的权威值为准（按发送序合并；合并即置 dirty，语义同上）
        if (result?.thinkingLevel && callSeq > entry.mergedAt.thinkingLevel) {
            entry.mergedAt.thinkingLevel = callSeq
            entry.confirmed.thinkingLevel = result.thinkingLevel
            entry.dirty.thinkingLevel = true
        }
        return true
    } catch (err: any) {
        if ([404, 409].includes(err?.code)) {
            useToast().error(err?.message, 5000)
        }
        return false
    } finally {
        endSettingFlight(targetKey, entry)
    }
}


const fetchSessionUsage = async (sessionKey?: string) => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) return

    try {
        const result = await apiGet<SessionUsage>(`/api/chat/${targetKey}/usage`)
        if (result) {
            getSessionData(targetKey).sessionUsage = result
        }
    } catch {
        // 静默失败：usage 是辅助信息，不影响核心功能
    }
}

const fetchSessionTree = async (sessionKey?: string): Promise<SessionTreeEntry[] | null> => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) return null

    try {
        // 服务端返回轻量 flat entries；客户端分支导航只依赖 id / parentId / type。
        const result = await apiGet<{ leafId?: string | null, entries?: SessionTreeEntry[] } | SessionTreeEntry[]>(`/api/chat/${targetKey}/entries`)
        const entries = Array.isArray(result)
            ? result
            : (Array.isArray(result?.entries) ? result.entries : null)

        // Update store state
        const sd = getSessionData(targetKey)
        sd.sessionTree = entries
        sd.sessionLeafId = Array.isArray(result) ? null : (result?.leafId ?? null)

        return entries
    } catch (err: any) {
        console.error('[useChatState] fetchSessionTree failed:', err)
        return null
    }
}

const navigateBranch = async (targetEntryId: string, sessionKey?: string): Promise<boolean> => {
    const targetKey = sessionKey || state.sessionKey
    if (!targetKey) return false

    try {
        const result = await apiPost<{ messages: ChatMessage[], navigated: boolean }>(
            `/api/chat/${targetKey}/navigate`,
            { entryId: targetEntryId }
        )
        if (!result?.messages) return false

        // 直接用后端返回的消息列表更新 chatMessages；targetEntryId 是已解析出的分支 leaf。
        const sd = getSessionData(targetKey)
        sd.chatMessages = result.messages
        // 分支已切换：流式临时条目属旧分支，一并作废（同 abort 规则），
        // 否则旧分支 todo 快照在拼接序列尾部残留、误导 last-write-wins
        sd.chatToolMessages = []
        sd.sessionLeafId = targetEntryId
        // 切换 rebind 了服务端会话（fork 语义），树的作用域可能变化；
        // 不刷新会让后续分支切换用陈旧条目定位（服务端 404 → 「切换分支失败」）
        fetchSessionTree(targetKey)
        return true
    } catch (err: any) {
        console.error('[useChatState] navigateBranch failed:', err)
        return false
    }
}

// ==================== Derived Computeds（模块级，仅初始化一次）====================
const chatMessages = computed(() => getSessionData(state.sessionKey).chatMessages)
const chatToolMessages = computed(() => getSessionData(state.sessionKey).chatToolMessages)
const sessionTree = computed(() => getSessionData(state.sessionKey).sessionTree)
const sessionLeafId = computed(() => getSessionData(state.sessionKey).sessionLeafId)
const chatStream = computed(() => getSessionData(state.sessionKey).chatStream)
// 当前会话信息：按 sessionKey 实时从会话列表桶推导。
// 不缓存行实例 —— 列表刷新/upsert 会把桶行换成新对象，缓存实例会让标签写入与
// 读取源分叉（历史 bug：切换模型/思考后标签不动，刷新页面才恢复）。
const currentSession = computed<SessionRow | null>(() => {
    if (!state.sessionKey) return null
    return useSessionsState().findSessionLocal(state.sessionKey) ?? null
})
const chatSending = computed(() => getSessionData(state.sessionKey).chatSending)
const chatRunId = computed(() => getSessionData(state.sessionKey).chatRunId)
const chatStreamStartedAt = computed(() => getSessionData(state.sessionKey).chatStreamStartedAt)
const chatLoading = computed(() => getSessionData(state.sessionKey).chatLoading)
const sessionUsage = computed(() => getSessionData(state.sessionKey).sessionUsage)
const compacting = computed(() => getSessionData(state.sessionKey).compacting === true)
const pendingQueue = computed(() => getSessionData(state.sessionKey).pendingQueue)
const currentAgent = computed(() => {
    const agentsState = useAgentsState()
    return agentsState.agentsList?.find(a => a.id === state.agentsSelectedId) || null
})

// 将 ComputedRef<T> 解包为 T，使 TypeScript 类型与 Vue reactive 自动解包行为一致
// Vue 运行时会自动解包 reactive 对象中的 ComputedRef，
// 但 TypeScript 静态分析感知不到这个行为，需要手动告知类型系统。
// 参见：https://vuejs.org/guide/essentials/reactivity-fundamentals.html#reactive-proxy-vs-original
type UnwrapComputed<T extends object> = {
    [K in keyof T]: T[K] extends ComputedRef<infer V> ? V : T[K]
}


// 预组装单例（模块加载时执行一次，避免每次调用 useChatState 重复创建 computed）
const _methods = {
    chatMessages, chatToolMessages, sessionTree, sessionLeafId, chatStream,
    currentSession,
    chatSending, chatRunId, chatStreamStartedAt, chatLoading, sessionUsage, currentAgent,
    compacting,
    pendingQueue, removePendingItem,
    sendMessage, steerMessage, followMessage, abortChat, loadChatHistory,
    setSessionModel, setSessionThinkingLevel, patchSessionRowEverywhere,
    setSessionKey, createNewSession, selectAgent, getSessionData,
    retryMessage, editMessage, fetchSessionTree, fetchSessionUsage, navigateBranch, forkFromEntry,
    isForkingEntry,
    isCompacting,
}
const _chatState = Object.assign(state, _methods) as unknown as typeof state & UnwrapComputed<typeof _methods>

// ==================== 服务端队列快照同步 ====================
// 服务端 steer/followUp 影子账本任何变更（入队登记 / 回显出账 / 删除 / abort 清账）
// 都会广播 queue_state 权威快照：多窗口收敛 + 断线重连后的陈旧视图修正。
// 本地不再持久化队列（无 localStorage），快照经 queueRev 门禁后整体替换。
onServerMessage((msg: any) => {
    if (msg?.type !== 'event' || msg?.event !== 'queue_state') return
    const sessionId = msg.payload?.sessionId
    const sd = sessionId ? state.sessionsMap.get(sessionId) : undefined
    if (!sd) return
    applyQueueSnapshot(sd, msg.payload?.queueRev, msg.payload?.entries)
})

export function useChatState() {
    return _chatState
}

