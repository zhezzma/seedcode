import { computed } from 'vue'
import { useChatState, type ChatMessage } from './useChatState'
import { useUiSettingsStore } from '../stores/setting'
import type { A2UIComponent } from '../components/a2ui/types'
import { getOrCreateSurface, updateSurfaceDataModel, deleteSurface } from './useA2UISurfaces'
import { ensureRenderableBlocks, markErroredToolBlocks, isAbortErrorMessage } from '../utils/chatMessageRender'
import { resolveMediaUrl } from '../utils/media-url'
import type { PendingItem, PendingSendMode } from '../utils/pending-queue'
import { i18n } from '../i18n'
import { isSupportedA2uiMessage, isSurfaceCatalogAllowed, isComponentCatalogAllowed } from './a2uiClient'

// Types for internal display
export interface DisplayBlock {
    type: 'text' | 'tool' | 'image' | 'thinking' | 'error' | 'unknown' | 'a2ui' | 'a2ui_loading' | 'a2ui-action' | 'compacting'
    text?: string
    toolCallId?: string
    toolName?: string
    toolArgs?: any
    toolResult?: any
    toolState?: 'calling' | 'success' | 'error'
    toolError?: string
    toolDetails?: any  // subagent 工具的进度详情
    error?: string // For top-level message errors
    source?: {
        type: 'base64' | 'url'
        media_type?: string
        data?: string
        url?: string
        name?: string
    }
    // A2UI 相关字段
    a2uiComponents?: A2UIComponent[]
    a2uiDataModel?: Record<string, any>
    a2uiSurfaceId?: string
    a2uiRootIds?: string[]
    // A2UI User Action 字段
    a2uiEventName?: string
    a2uiPayload?: any
}

export interface DisplayMessage {
    id: string
    role: 'user' | 'assistant'
    blocks: DisplayBlock[]
    timestamp?: number
    entryId?: string
    parentEntryId?: string | null
    /** 合并气泡（assistantMsgMerge）下组内最后一条 entry 的 id；
     *  fork 等以「气泡末尾」为锚点的操作应优先用它，entryId 保持指向组内第一条
     *  （会话树跳转的反向定位依赖该语义，不可改动） */
    lastEntryId?: string
    /** steer / follow-up 排队中标识：气泡半透明 + 徽标，无 entryId 时操作按钮自动隐藏 */
    pending?: PendingSendMode
}

export interface ChatStateShape {
    chatMessages: ChatMessage[]
    chatToolMessages?: ChatMessage[]
    chatStream: any[] | null
    chatSending?: boolean
    chatRunId?: string | null
    chatLoading?: boolean
    sessionKey?: string
    /** busy 期间 steer/follow-up 的本地排队队列（会话页消息末尾追加为半透明气泡） */
    pendingQueue?: PendingItem[]
    /** 上下文压缩进行中（compaction_start/end 事件驱动），消息列表尾部追加瞬态压缩行 */
    compacting?: boolean
    [key: string]: any
}

/**
 * 共用的 content → DisplayBlock 转换器（主会话 processedMessages 与子代理轨迹抽屉共用）。
 * 含 <a2ui> 标签解析（surface 注册/更新）、toolCall/image/thinking block 映射。
 * renderedSurfaceIds 由调用方持有：主会话每次列表重算新建（原语义），
 * 抽屉整个生命周期持有一个（轨迹只读重放，surface 幂等更新）。
 */
export function createContentConverter(renderedSurfaceIds: Set<string>) {
    // 辅助函数：将API返回的内容项转换为显示 Block
    /**
     * 解析文本中的 <a2ui> 标签，将其拆分为文本 block 和 a2ui block
     */
    const parseA2UIFromText = (rawText: string, renderedSurfaceIds: Set<string>): DisplayBlock[] => {
        // 预处理1：去掉包裹完整 <a2ui>...</a2ui> 的 markdown 代码块围栏（已闭合）
        let text = rawText.replace(/```[^\n]*\n\s*(<a2ui>[\s\S]*?<\/a2ui>)\s*\n?```/g, '$1')

        // 预处理2：流式场景——代码块尚未闭合时，去掉包裹 <a2ui> 开标签的围栏前缀。
        // 同时覆盖 <a2ui> 尚未完整输出的情况（如流式推送了 <a、<a2、<a2u 等前缀片段），
        // 避免在标签到达完整前被渲染为 Markdown 代码块（闪烁根本原因）。
        text = text.replace(/```[^\n]*\n(\s*(?:<a2ui>|<a2ui|<a2u|<a2|<a))/g, '$1')

        const a2uiRegex = /<a2ui>([\s\S]*?)<\/a2ui>/g
        const blocks: DisplayBlock[] = []
        let lastIndex = 0
        let match

        while ((match = a2uiRegex.exec(text)) !== null) {
            // 添加 <a2ui> 前面的普通文本
            if (match.index > lastIndex) {
                const before = text.slice(lastIndex, match.index).trim()
                if (before) blocks.push({ type: 'text', text: before })
            }

            // 解析 <a2ui> 内容
            try {
                const a2uiContent = match[1].trim()
                const components: A2UIComponent[] = []
                let surfaceId: string | undefined

                const messages: any[] = []
                let parseErrorMsg = ''

                // 尝试将内容包装为数组整体解析（兼容大模型可能输出的带换行的多行格式）
                try {
                    let arrayRaw = a2uiContent.trim()
                    // 替换只用空格/回车分隔的对象 } { 为 },{ 
                    arrayRaw = arrayRaw.replace(/}\s*\{/g, '},{')
                    messages.push(...JSON.parse(`[${arrayRaw}]`))
                } catch (e: any) {
                    // 兜底：原始的 NDJSON 逐行解析
                    const lines = a2uiContent.split('\n').filter(l => l.trim())
                    for (const line of lines) {
                        try {
                            messages.push(JSON.parse(line.trim()))
                        } catch (err: any) {
                            parseErrorMsg = err.message || String(err)
                        }
                    }
                }

                let versionRejected = false
                for (const msg of messages) {
                    try {
                        // v1.0 硬切：非 v1.0 envelope 一律丢弃并标记（不再兼容 v0.9）
                        if (!isSupportedA2uiMessage(msg)) {
                            versionRejected = true
                            console.error('[A2UI] rejected non-v1.0 message:', JSON.stringify(msg).slice(0, 200))
                            continue
                        }
                        if (msg.createSurface) {
                            // v1.0 catalogId 解析：surface 默认 catalog 仅接受本渲染端私有 catalog
                            if (!isSurfaceCatalogAllowed(msg.createSurface.catalogId)) {
                                versionRejected = true
                                console.error('[A2UI] rejected surface with unknown catalogId:', msg.createSurface.catalogId)
                                continue
                            }
                            // 注册 Surface
                            surfaceId = msg.createSurface.surfaceId
                            if (surfaceId) getOrCreateSurface(surfaceId)
                            // v1.0：createSurface 可内联 components / 初始 dataModel（单消息整面 UI）
                            if (Array.isArray(msg.createSurface.components)) {
                                const inline = (msg.createSurface.components as A2UIComponent[]).filter((comp) => {
                                    if (isComponentCatalogAllowed(comp)) return true
                                    console.error('[A2UI] dropped inline component with unknown catalogId:', comp?.id)
                                    return false
                                })
                                components.push(...inline)
                            }
                            if (msg.createSurface.dataModel && typeof msg.createSurface.dataModel === 'object' && !Array.isArray(msg.createSurface.dataModel) && surfaceId) {
                                updateSurfaceDataModel(surfaceId, '/', msg.createSurface.dataModel)
                            }
                        } else if (msg.updateComponents) {
                            surfaceId = surfaceId || msg.updateComponents.surfaceId
                            const comps = msg.updateComponents.components
                            let collected: A2UIComponent[] = []
                            if (Array.isArray(comps)) {
                                collected = comps
                            } else if (typeof comps === 'object' && comps !== null) {
                                collected = Object.values(comps) as A2UIComponent[]
                            }
                            // 组件级 catalogId：非本渲染端 catalog 的组件不渲染（v1.0 无 fallback）
                            for (const comp of collected) {
                                if (isComponentCatalogAllowed(comp)) components.push(comp)
                                else console.error('[A2UI] dropped component with unknown catalogId:', comp?.id)
                            }
                        } else if (msg.updateDataModel) {
                            const targetId = msg.updateDataModel.surfaceId || surfaceId
                            if (targetId) {
                                // 通过 Surface 注册表更新数据模型（reactive，跨消息生效）
                                updateSurfaceDataModel(
                                    targetId,
                                    msg.updateDataModel.path,
                                    msg.updateDataModel.value
                                )
                            }
                        } else if (msg.deleteSurface) {
                            deleteSurface(msg.deleteSurface.surfaceId)
                        } else if (msg.callRendererFunction || msg.agentFunctionResponse) {
                            // v1.0 双向 RPC 消息：当前无 agent 侧发起方/挂起方，可见性告警后丢弃
                            console.warn('[A2UI] chat-stream RPC message without handler:', Object.keys(msg)[1] ?? 'unknown')
                        }
                    } catch (err: any) {
                        parseErrorMsg = err.message || String(err)
                    }
                }

                if (components.length > 0 && surfaceId) {
                    // 同一个 surfaceId 只生成一次面板气泡：A2UI 协议中 surface 是有状态生命周期对象，
                    // 后续带相同 surfaceId 的渲染（例如 Agent 回填 result 后重新渲染整块）只需让其
                    // updateDataModel 生效（已通过 Surface 注册表更新到原面板的 reactive 数据上），
                    // 不应再产生第二个面板气泡。组件结构相同，原面板会就地更新显示。
                    if (renderedSurfaceIds.has(surfaceId)) {
                        // 跳过重复气泡；数据更新已在上面的 updateDataModel 分支生效。
                        if (versionRejected) {
                            blocks.push({ type: 'error', error: i18n.global.t('chat.a2uiVersionMismatch') })
                        }
                    } else {
                        renderedSurfaceIds.add(surfaceId)
                        // 有组件 → 生成 a2ui block（引用 Surface 注册表中的 reactive 数据模型）
                        getOrCreateSurface(surfaceId)

                        // 计算根组件 ID
                        const childIds = new Set<string>()
                        for (const comp of components) {
                            if (comp.children && Array.isArray(comp.children)) {
                                comp.children.forEach((id: string) => childIds.add(id))
                            }
                            if (comp.child && typeof comp.child === 'string') childIds.add(comp.child)
                            if (comp.trigger && typeof comp.trigger === 'string') childIds.add(comp.trigger)
                            if (comp.content && typeof comp.content === 'string') childIds.add(comp.content)
                            if (comp.tabs && Array.isArray(comp.tabs)) {
                                comp.tabs.forEach((tab: any) => { if (tab.child) childIds.add(tab.child) })
                            }
                        }
                        const rootIds = components.filter(c => c.id && !childIds.has(c.id)).map(c => c.id!)

                        blocks.push({
                            type: 'a2ui',
                            a2uiComponents: components,
                            a2uiSurfaceId: surfaceId,
                            a2uiRootIds: rootIds,
                        })
                        // 部分拒绝（同批内既有可能 v1.0 也有非 v1.0）：渲染合法部分的同时明示丢弃
                        if (versionRejected) {
                            blocks.push({ type: 'error', error: i18n.global.t('chat.a2uiVersionMismatch') })
                        }
                    }
                } else if (versionRejected) {
                    // 全部消息被 v1.0 硬切拒绝（非 v1.0 envelope / 未知 catalog）：不再兼容渲染
                    blocks.push({
                        type: 'error',
                        error: i18n.global.t('chat.a2uiVersionMismatch'),
                    })
                    blocks.push({ type: 'text', text: match[0] })
                } else if (parseErrorMsg && !surfaceId) {
                    // 如果连 surfaceId 都没有并且发生了错误，说明整体 JSON 结构崩溃
                    blocks.push({
                        type: 'error',
                        error: `A2UI 解析故障: ${parseErrorMsg}\n数据包遭到破坏或被意外截断。`
                    })
                    blocks.push({ type: 'text', text: match[0] })
                } else if (parseErrorMsg && components.length === 0) {
                    // 有指令但是组件解析彻底失败
                    blocks.push({
                        type: 'error',
                        error: `A2UI 组件语法异常: ${parseErrorMsg}\n大模型生成了非法的 UI 结构。`
                    })
                    blocks.push({ type: 'text', text: match[0] })
                }
                // 纯 updateDataModel（无 components）且无严重 parseError 不生成 block
                // 数据已通过 Surface 注册表直接更新到已有的 reactive 对象上
            } catch {
                blocks.push({ type: 'text', text: match[0] })
            }

            lastIndex = match.index + match[0].length
        }

        // 如果没有匹配到 <a2ui>，检查是否有未闭合的 <a2ui> 标签（流式加载中）
        if (lastIndex === 0) {
            const openTagIdx = text.indexOf('<a2ui>')
            if (openTagIdx >= 0) {
                // 有 <a2ui> 但没有 </a2ui> → 正在流式接收
                const before = text.slice(0, openTagIdx).trim()
                if (before) blocks.push({ type: 'text', text: before })
                blocks.push({ type: 'a2ui_loading', text: text.slice(openTagIdx + 6).trim() })
                return blocks
            }
            return [{ type: 'text', text }]
        }

        // 检查最后一个匹配之后是否有未闭合的 <a2ui>（多个 a2ui 块，最后一个未完成）
        const remainingText = text.slice(lastIndex)
        const trailingOpenIdx = remainingText.indexOf('<a2ui>')
        if (trailingOpenIdx >= 0) {
            const before = remainingText.slice(0, trailingOpenIdx).trim()
            if (before) blocks.push({ type: 'text', text: before })
            blocks.push({ type: 'a2ui_loading', text: remainingText.slice(trailingOpenIdx + 6).trim() })
        } else if (lastIndex < text.length) {
            const remaining = remainingText.trim()
            if (remaining) blocks.push({ type: 'text', text: remaining })
        }

        return blocks
    }

    const convertToBlocks = (content: any): DisplayBlock[] => {
        const blocks: DisplayBlock[] = []

        const processTextWithA2UIEvent = (text: string) => {
            const textTrimmed = text.trim()
            if (textTrimmed.startsWith('/a2ui-event ')) {
                try {
                    const jsonStr = textTrimmed.substring(12).trim()
                    const payload = JSON.parse(jsonStr)
                    const eventName = payload.action?.name || payload.a2uiEvent || 'action'
                    blocks.push({
                        type: 'a2ui-action',
                        a2uiEventName: eventName,
                        a2uiPayload: payload
                    } as any)
                    return true
                } catch {
                    // ignore and fall through
                }
            }
            return false
        }

        // 如果 content 是数组，遍历处理
        if (Array.isArray(content)) {
            for (const item of content) {
                if (item.type === 'text') {
                    if (item.text) {
                        if (processTextWithA2UIEvent(item.text)) {
                            continue
                        }
                        // 检测是否包含 <a2ui> 标签
                        if (item.text.includes('<a2ui>')) {
                            blocks.push(...parseA2UIFromText(item.text, renderedSurfaceIds))
                        } else {
                            blocks.push({ type: 'text', text: item.text })
                        }
                    }
                } else if (item.type === 'toolCall') {
                    const block: DisplayBlock = {
                        type: 'tool',
                        toolCallId: item.id || item.toolCallId,
                        toolName: item.name,
                        toolArgs: item.arguments,
                        toolState: item.toolState || 'calling',
                        toolResult: item.toolResult,
                        toolError: item.toolError,
                        toolDetails: item.toolDetails,
                    }
                    blocks.push(block)
                } else if (item.type === 'image') {
                    // 结构化图片与 Markdown 图片共用同一套媒体 URL 解析规则。
                    // 两形状兼容：本地/SSE 消息用 url/mimeType/data 平铺字段；服务端
                    // /messages 持久化的 pi-ai 块是 {source:{type,mediaType,data}}
                    //（edcc92f 重构曾丢此形状，致历史重拉后带图气泡渲染为空）。
                    const src = item.source ?? {}
                    const itemUrl = item.url ?? (src.type === 'url' ? src.data : undefined)
                    const mediaType = item.mimeType ?? src.mediaType
                    const itemData = item.data ?? (src.type === 'base64' ? src.data : undefined)
                    const resolvedUrl = resolveMediaUrl(itemUrl, settings.apiBaseUrl)
                    blocks.push({
                        type: 'image',
                        source: {
                            type: itemUrl ? 'url' : 'base64',
                            media_type: mediaType,
                            data: itemData || resolvedUrl,
                            url: resolvedUrl
                        }
                    })
                } else if (item.type === 'thinking') {
                    // 过滤掉空的或仅包含空白的思考过程
                    if (item.thinking && item.thinking.trim().length > 0) {
                        blocks.push({
                            type: 'thinking',
                            text: item.thinking
                        })
                    }
                } else {
                    // 未知类型，转为 JSON 字符串显示
                    blocks.push({
                        type: 'unknown',
                        text: JSON.stringify(item)
                    })
                }
            }
        } else if (typeof content === 'string') {
            // 纯字符串内容 - 也检测 <a2ui> 等特殊指令
            if (!processTextWithA2UIEvent(content)) {
                if (content.includes('<a2ui>')) {
                    blocks.push(...parseA2UIFromText(content, renderedSurfaceIds))
                } else {
                    blocks.push({ type: 'text', text: content })
                }
            }
        }
        return blocks
    }
    const settings = useUiSettingsStore()

    return convertToBlocks
}

export function useChatMessages(state: ChatStateShape) {

    // 转换原始消息为显示格式，并合并工具调用结果
    const processedMessages = computed(() => {
        const rawMessages = state.chatMessages || []
        const toolMessages = state.chatToolMessages || [] // 单独存储的工具调用结果
        const allMessages = [...rawMessages, ...toolMessages]
        const displayMessages: DisplayMessage[] = []

        // 工具调用注册表: map toolCallId -> { messageIndex, blockIndex }
        // 用于快速查找并更新 Tool Call 状态
        const toolCallRegistry = new Map<string, { msgIdx: number, blockIdx: number }>()
        // 跨所有消息共享：记录已生成过面板气泡的 surfaceId，同一 surface 只出一个气泡，
        // 后续重渲染只走 updateDataModel 就地更新，不重复出面板。
        const renderedSurfaceIds = new Set<string>()
        const settings = useUiSettingsStore()
        const convertToBlocks = createContentConverter(renderedSurfaceIds)

        // 1. 处理历史消息
        for (const msg of allMessages) {
            // pi 消息通用语义：display=false 面向模型（扩展注入的隐性提醒等），
            // 不进用户聊天记录——流式路径本就不渲染（custom 白名单不命中），
            // 历史/attach/abort 快照路径在此统一过滤，两路径自洽
            if (msg.display === false) continue

            // 1.1 处理 Tool Result 消息 (后端返回的独立消息 role='toolResult')
            if (msg.role === 'toolResult') {
                const toolCallId = msg.toolCallId;
                if (toolCallId) {
                    const reg = toolCallRegistry.get(toolCallId)
                    if (reg) {
                        const targetMsg = displayMessages[reg.msgIdx]
                        if (targetMsg) {
                            const targetBlock = targetMsg.blocks[reg.blockIdx]
                            // 更新目标 Tool Block 的状态和结果
                            if (targetBlock && targetBlock.type === 'tool') {
                                targetBlock.toolResult = msg.content
                                // 刷新/重进后从历史恢复 toolDetails（subagent 进度与
                                // subagentSessionId 轨迹定位信息都在这里，丢失则「查看轨迹」入口不可用）
                                if (msg.details) targetBlock.toolDetails = msg.details

                                // 简单的错误检测逻辑
                                let isError = false
                                let errorMsg = ''

                                if (msg.isError) {
                                    isError = true
                                    errorMsg = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                                } else if (msg.details?.status === 'error') {
                                    isError = true
                                    errorMsg = msg.details.error || 'Unknown error'
                                }

                                if (isError) {
                                    targetBlock.toolState = 'error'
                                    targetBlock.toolError = errorMsg
                                } else if (!targetBlock.toolState || targetBlock.toolState === 'calling') {
                                    targetBlock.toolState = 'success'
                                }

                                // 操作锚点跟随 toolResult（组内最后一条 entry）：toolResult
                                // 恒后于其 toolCall 的 assistant entry，按序遍历下刷新即收敛到
                                // 组内最后条目——fork 锚定在 toolCall 半截会把 fork 出的会话
                                // 停在悬空调用上（引擎只能 missing_result 兑底，工具卡永久转圈）。
                                // 以 registry 定位的 owner 气泡为目标（非列表尾）：toolCall 可能
                                // 在更早气泡；后续 assistant 合并/面板并入会以自己的 entry 覆盖。
                                if (msg.entryId) targetMsg.lastEntryId = msg.entryId
                            }
                        }
                    }
                }
                continue // Tool Result 不作为独立气泡显示，而是更新对应 Tool Call
            }

            // 1.15 展示类 custom 消息（面板/图片卡）：并入前一条 assistant 气泡。
            // 它是这条 AI 回复的内嵌展示附件，不是新一轮发言——独立成气泡会渲染成
            // 「两个连续 AI 回复」。两形状统一处理：
            // - 服务端 custom_message 条目（通道归位后 /messages 投影：type==='custom_message'）
            // - 旧引擎/迁移历史的 role==='custom' 消息（含 SSE live 追加的）
            if (msg.type === 'custom_message' || msg.role === 'custom') {
                const panelBlocks = convertToBlocks(msg.content)
                if (panelBlocks.length === 0) continue
                const lastMsg = displayMessages.length > 0 ? displayMessages[displayMessages.length - 1] : null
                if (lastMsg && lastMsg.role === 'assistant') {
                    // 与工具卡同语义：无条件并入（不受 assistantMsgMerge 开关控制）
                    lastMsg.blocks.push(...panelBlocks)
                    // 操作锚点跟随组内最后一条 entry（同 1.2 合并路径语义）
                    if (msg.entryId) lastMsg.lastEntryId = msg.entryId
                } else {
                    // 前面无 assistant 气泡（面板开头/异常序）：兑底独立成 assistant 气泡
                    displayMessages.push({
                        id: msg.id || `${state.sessionKey || 'temp'}-msg-${displayMessages.length}`,
                        role: 'assistant',
                        blocks: panelBlocks,
                        timestamp: msg.timestamp,
                        entryId: msg.entryId,
                        parentEntryId: msg.parentEntryId,
                    })
                }
                continue
            }

            // 1.2 处理普通消息 (User / Assistant)
            const convertedBlocks = convertToBlocks(msg.content)
            // 中断签名（用户停止 / 扩展设计内中断如在线压缩前的 abort）：有意中断而非故障。
            // 空内容 → 完全不渲染（压缩窗口由瞬态压缩行接管展示；ensureRenderableBlocks
            // 的空 assistant 保锚点逻辑会复活它，必须在锚点复活前拦截）；
            // 半截内容 → 保留内容但不加任何错误块/中断标记（用户停止有自己的按钮态反馈）
            const msgAborted = msg.role === 'assistant' && isAbortErrorMessage(msg.errorMessage)
            if (msgAborted && convertedBlocks.length === 0) continue

            const blocks: DisplayBlock[] = ensureRenderableBlocks(
                {
                    role: msg.role,
                    entryId: msg.entryId,
                },
                convertedBlocks,
            )

            // 顶级错误信息处理（真错误保持红色错误块；abort 签名不进错误分支）
            if (msg.errorMessage) {
                if (!msgAborted) {
                    // 消息级错误时其中的 toolCall 从未执行（不会有 toolResult），
                    // 先标成 error 态，避免渲染成永远转圈的 calling 卡
                    markErroredToolBlocks(blocks, msg.errorMessage)
                    blocks.push({ type: 'error', error: msg.errorMessage })
                } else {
                    // 半截内容被中断：未执行的 toolCall 永远等不到结果，仅标终态
                    // 防永久转圈（工具卡内如实显示中断原因），不加气泡级错误块
                    markErroredToolBlocks(blocks, msg.errorMessage)
                }
            }

            if (blocks.length > 0) {
                // 判断是否合并消息 (Assistant 连续发言)
                const lastMsg = displayMessages.length > 0 ? displayMessages[displayMessages.length - 1] : null
                let shouldMerge = false;

                if (settings.assistantMsgMerge && msg.role === 'assistant') {
                    if (lastMsg && lastMsg.role === 'assistant') {
                        shouldMerge = true;
                    }
                }

                if (shouldMerge && lastMsg) {
                    // 记录合并前的起始 Block 索引
                    const baseBlockIdx = lastMsg.blocks.length
                    lastMsg.blocks.push(...blocks)

                    // 合并气泡的操作锚点跟随组内最后一条 entry：
                    // fork「从此处分叉」应分叉到最后一轮回复，而不是停留在第一条的 entryId
                    if (msg.entryId) lastMsg.lastEntryId = msg.entryId

                    // 注册合并后的 Tool Call
                    blocks.forEach((b, idx) => {
                        if (b.type === 'tool' && b.toolCallId) {
                            toolCallRegistry.set(b.toolCallId, { msgIdx: displayMessages.length - 1, blockIdx: baseBlockIdx + idx })
                        }
                    })
                } else {
                    // 创建新消息
                    const newMsg: DisplayMessage = {
                        id: msg.id || `${state.sessionKey || 'temp'}-msg-${displayMessages.length}`,
                        role: msg.role as 'user' | 'assistant',
                        blocks,
                        timestamp: msg.timestamp,
                        entryId: msg.entryId,
                        parentEntryId: msg.parentEntryId,
                    }
                    displayMessages.push(newMsg)
                    // 注册新消息中的 Tool Call
                    blocks.forEach((b, idx) => {
                        if (b.type === 'tool' && b.toolCallId) {
                            toolCallRegistry.set(b.toolCallId, { msgIdx: displayMessages.length - 1, blockIdx: idx })
                        }
                    })
                }
            }
        }

        // 2. 处理流式输出（Streaming）
        // 【条件说明】只有当 chatStream 非空且有实际内容时，才进入流式渲染分支。
        //
        // 为什么不用 "chatStream != null" 作为条件？
        //   - sendMessage 时 chatStream 被初始化为 []（空数组）
        //   - 服务器会先回显用户消息（发一对 message_start/message_end），此期间 stream 保持 []
        //   - 空数组虽然是 truthy，但没有内容可渲染，这时应该显示 loading 动画而非空 bubble
        //   - 如果条件是 "chatStream != null"，空数组会进入此分支，跳过 loading placeholder 的 else if，
        //     导致 loading 动画消失，用户无法感知系统正在工作
        const compacting = state.compacting === true

        if (state.chatStream && Array.isArray(state.chatStream) && state.chatStream.length > 0) {
            const streamBlocks: DisplayBlock[] = convertToBlocks(state.chatStream)

            if (streamBlocks.length > 0) {
                const lastMsg = displayMessages.length > 0 ? displayMessages[displayMessages.length - 1] : null

                // 根据设置决定是否合并到上一条 assistant 消息（多轮工具调用场景）
                const shouldMergeStream = settings.assistantMsgMerge && lastMsg && lastMsg.role === 'assistant'

                if (shouldMergeStream && lastMsg) {
                    // 合并模式：追加到前一条 assistant 消息的 blocks 中
                    lastMsg.blocks.push(...streamBlocks)
                } else {
                    // 独立模式：作为新的 streaming bubble 插入
                    displayMessages.push({
                        id: 'streaming-pending',
                        role: 'assistant',
                        blocks: streamBlocks,
                        timestamp: Date.now()
                    })
                }
            }
        } else if (!compacting && (state.chatSending || Boolean(state.chatRunId))) {
            // 3. 等待中状态（Loading placeholder）
            // 压缩窗口内不插入占位气泡：此刻模型不在生成（压缩指示行接管展示，
            // 避免点动画与压缩行叠加误导用户「在等待生成」）
            // 触发条件：chatStream 为 null 或空数组，但仍在发送中（chatSending 或 chatRunId 未清除）
            // 场景：
            //   a. 刚发送消息，等待服务器第一个响应
            //   b. user 消息回显的 message_end 后，等待 assistant 开始答复
            //   c. 两条 assistant 消息之间（多轮工具调用）
            const lastMsg = displayMessages.length > 0 ? displayMessages[displayMessages.length - 1] : null
            if (!lastMsg || lastMsg.role !== 'assistant') {
                // 仅当最后一条不是 assistant 时插入占位符，避免重复
                displayMessages.push({
                    id: 'streaming-pending',
                    role: 'assistant',
                    blocks: [{ type: 'text', text: '' }], // 空 block，由 MessageBubble 渲染为 loading 动画
                    timestamp: Date.now()
                })
            }
        }

        // 3.5 瞬态压缩行（compaction_start → end 窗口内存在）：伪消息形式追加在列表
        // 末尾——随 processedMessages 参与虚拟列表与滚动贴底逻辑（用户视口贴底时
        // 天然可见；早期版本挂在列表头部/最后一条气泡内容栈顶，长会话里全程在视口
        // 外，真机上「指示器不可见」的根因）。压缩结束即从列表消失，零痕迹。
        // 伪消息不设 entryId（非真实条目，不参与分支导航/操作按钮锚点）
        if (compacting) {
            displayMessages.push({
                id: 'context-compacting',
                role: 'assistant',
                blocks: [{ type: 'compacting' }],
            })
        }


        // 4. 排队中的 steer / follow-up（busy 期间发送）：追加在列表末尾；
        //    回显命中（message_start 消费）或服务端 queue_state 快照修正后无缝转正为正式气泡
        const pendingQueue = state.pendingQueue || []
        for (const entry of pendingQueue) {
            // 与历史同规则过 convertToBlocks：/a2ui-event 面板提交渲染为动作 chip
            //（a2ui-action），不再裸显整段 JSON 文本——提交后在排队/运行中与消费后
            //（历史回显）同一观感，不因排队态裸奔
            const pendingBlocks = convertToBlocks(entry.text)
            displayMessages.push({
                id: entry.id,
                role: 'user',
                blocks: pendingBlocks.length > 0 ? pendingBlocks : [{ type: 'text', text: entry.text }],
                timestamp: entry.timestamp,
                pending: entry.mode,
            })
        }

        return displayMessages
    })

    const isLoading = computed(() => state.chatLoading)
    const isBusy = computed(() => state.chatSending || Boolean(state.chatRunId))
    const streamingText = computed(() => state.chatStream)



    return {
        processedMessages,
        isLoading,
        isBusy,
        streamingText,
    }
}
