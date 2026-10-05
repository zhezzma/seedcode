<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, watch, reactive, toRef, nextTick } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useUiSettingsStore } from '../stores/setting'
import { ChevronDoubleDownIcon, ChevronDownIcon, CheckIcon, FolderIcon, FolderOpenIcon } from '@heroicons/vue/24/outline'

import { useChatMessages, type DisplayMessage } from '../composables/useChatMessages'
import { useMediaPreview } from '../composables/useMediaPreview'
import { useScrollManager } from '../composables/useScrollManager'
import type { BranchInfo } from '../components/chat/MessageBubble.vue'
import { useTTS } from '../composables/useTTS'
import { useVoiceChat } from '../composables/useVoiceChat'
import ChatHeader from '../components/chat/ChatHeader.vue'
import MessageBubble from '../components/chat/MessageBubble.vue'
import VirtualMessageList from '../components/chat/VirtualMessageList.vue'
import ChatInput from '../components/chat/ChatInput.vue'
import ChatDockArea from '../components/chat/ChatDockArea.vue'
import SessionTreeModal from '../components/chat/SessionTreeModal.vue'
import SessionTreeRail from '../components/chat/SessionTreeRail.vue'
import SubagentTraceDrawer from '../components/chat/SubagentTraceDrawer.vue'
import VoiceChatOverlay from '../components/chat/VoiceChatOverlay.vue'
import MediaPreviewOverlay from '../components/chat/MediaPreviewOverlay.vue'
import WorkspacePanel from '../components/workspace/WorkspacePanel.vue'
import WorkspaceViewer from '../components/workspace/WorkspaceViewer.vue'
import WorkspaceContextMenu from '../components/workspace/ContextMenu.vue'
import AgentFormModal from '../components/agents/AgentFormModal.vue'

import { isNewSession, NEW_SESSION_PATH, NEW_SESSION_ROUTE_NAME } from '../utils/route-helpers'
import { writeClipboard } from '../utils/clipboard.ts'
import { useChatState, splitModelId, type ChatSendOverrides, type ChatAttachment } from '../composables/useChatState'
import { useChatInput } from '../composables/useChatInput'
import { useCommandState } from '../composables/useCommandState'
import { useTodoState } from '../composables/useTodoState'
import { SessionRow, useSessionsState } from '../composables/useSessionsState'
import { useAgentsState } from '../composables/useAgentsState'
import { useToast } from '../composables/useToast'
import { useWorkspacePanel } from '../composables/useWorkspacePanel'
import { useWorkspaceViewer } from '../composables/useWorkspaceViewer'
import { truncateText } from '../utils/format'
import { collectSessionImageSources } from '../utils/session-image-gallery'
import { buildBranchIndexes, findLeafId as findBranchLeafId, getBranchInfo as resolveBranchInfo } from '../utils/chatBranchNavigation'
import { buildSessionTreeItems } from '../utils/sessionTreeItems'
import { isCommandInvocation } from '../utils/command-invocation'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const settingsStore = useUiSettingsStore()


const chatState = useChatState()
const { setSessionKeyResolver, restoreSessionDraft } = useChatInput()
setSessionKeyResolver(() => chatState.sessionKey)
const todoState = useTodoState()
const sessionsState = useSessionsState()
const agentsState = useAgentsState()
const { loadCommands, setCurrentAgent, allCommands, isLoaded } = useCommandState()

const wsPanel = useWorkspacePanel()
const wsViewer = useWorkspaceViewer()

// busy 时仍允许走 /chat 的命令（goal 等）。/steer /follow-up /abort 走控制 API，不在此列。
const busyAllowedCommands = ['goal']
const busyAllowedCommandPattern = new RegExp(`^\\/(${busyAllowedCommands
    .map(command => command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?=\\s|$)`)
const deliveryCommandPattern = /^\/(follow-up|steer|abort)(?:\s+([\s\S]*))?$/i

// Refs
const messagesContainerRef = ref<HTMLDivElement | null>(null)
const chatHeaderRef = ref<InstanceType<typeof ChatHeader> | null>(null)
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)
const virtualMessageListRef = ref<InstanceType<typeof VirtualMessageList> | null>(null)
const welcomeAgentDropdownRef = ref<HTMLDetailsElement | null>(null)

// 欢迎页 agent 下拉选择（与原 ChatHeader 下拉行为一致：selectAgent + 命令列表跟随）
// 明确选择会持久化到 settingsStore 的激活网关条目：/new 与冷启动兜底优先复用它，
// 而不是永远第一个。按条目隔离：各服务器 agent id 命名空间互不相通
const selectWelcomeAgent = async (agentId: string) => {
    chatState.selectAgent(agentId)
    setCurrentAgent(agentId)
    settingsStore.setLastNewSessionAgentId(agentId)
    await loadCommands(agentId)
    if (welcomeAgentDropdownRef.value) {
        welcomeAgentDropdownRef.value.open = false
    }
}

// 「选择文件夹」入口直接打开智能体创建弹窗（创建弹窗内嵌路径校验与预填）
const showAgentFormModal = ref(false)

const onWorkspaceCreated = async (agentId: string) => {
    await agentsState.loadAgents()
    await selectWelcomeAgent(agentId)
}

// Chat messages composable
const {
    processedMessages,
    isLoading,
    isBusy,
    streamingText,
} = useChatMessages(chatState as any)

const { setLightboxSources } = useMediaPreview()

// 仅在可能改变画廊的输入变化时才重算，避免流式输出逐 chunk 全量解析 Markdown。
// 签名覆盖：API 基址、消息数量、末条 id/块数/文本长度（流式增长的主要信号）。
const gallerySignature = computed(() => {
    const messages = processedMessages.value
    const last = messages[messages.length - 1]
    const lastTextLen = last?.blocks?.reduce(
        (sum, b) => sum + ((b.type === 'text' || b.type === 'thinking') ? (b.text?.length ?? 0) : 0),
        0,
    ) ?? 0
    return `${settingsStore.apiBaseUrl}|${messages.length}|${last?.id ?? ''}|${last?.blocks?.length ?? 0}|${lastTextLen}`
})

watch(
    gallerySignature,
    () => setLightboxSources(
        collectSessionImageSources(processedMessages.value, settingsStore.apiBaseUrl),
    ),
    { immediate: true },
)

// 滚动管理 composable
const {
    userScrolledUp,
    scrollToBottom,
    setupScrollWatchers,
    restoreIfSaved,
} = useScrollManager({
    containerRef: messagesContainerRef,
    messages: processedMessages,
    isLoading,
    isBusy,
    streamingText,
    state: chatState as any,
})

// TTS
const { currentReadingMsgId, readAloud: ttsReadAloud } = useTTS()

// 欢迎页 agent 下拉的显示名（顶栏下拉已移除，输入卡片内提供 agent 选择）
const selectedAgentName = computed(() => chatState.currentAgent?.name || '')

// 是否处于新会话欢迎页（模板与发送逻辑共用）
const isNewSessionPage = computed(() => isNewSession(route))

// 按当前时段生成问候语（新会话欢迎页）
const greetingKey = computed(() => {
    const hour = new Date().getHours()
    if (hour < 6) return 'home.greetingNight'
    if (hour < 12) return 'home.greetingMorning'
    if (hour < 18) return 'home.greetingAfternoon'
    return 'home.greetingEvening'
})

// 当前会话名称（优先从 sessionsState 获取最新值，因为 patchSession 会更新它）
const currentSessionName = computed(() => {
    const sessionKey = chatState.sessionKey
    if (!sessionKey) return ''

    // 从 sessionsState 三个桶中依次查找（patchSession / triggerSessionRename 会更新这里）
    const found =
        sessionsState.sessionsResult?.sessions.find((s: SessionRow) => s.id === sessionKey)
        || sessionsState.taskSessionsResult?.sessions.find((s: SessionRow) => s.id === sessionKey)
        || sessionsState.archivedSessionsResult?.sessions.find((s: SessionRow) => s.id === sessionKey)
    if (found) {
        return found.name || truncateText(found.name, 9) || '新对话'
    }

    // Fallback 到 chatState.currentSession
    const session = chatState.currentSession
    if (!session) return ''
    return session.name || '新对话'
})

const isCreatingSession = ref(false)
const showSessionTreeModal = ref(false)
const sessionTreeBusy = ref(false)

// 桌面端左侧 rail 的数据：与消息气泡 1:1（user / 合并后 AI 轮），同源 processedMessages，
// 不依赖 /entries 的返回时机
const sessionTreeItems = computed(() => buildSessionTreeItems(processedMessages.value))

// 跳转定位闪光：rail / 树跳转落点气泡短暂高亮
const flashEntryId = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | null = null
const flashEntry = (entryId: string) => {
    flashEntryId.value = entryId
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
        flashEntryId.value = null
        flashTimer = null
    }, 950)
}

const openSessionTree = async () => {
    if (!chatState.sessionKey) return
    await chatState.fetchSessionTree()
    showSessionTreeModal.value = true
}

const handleJumpToTreeEntry = async (entryId: string) => {
    if (sessionTreeBusy.value) return

    sessionTreeBusy.value = true
    try {
        const entries = chatState.sessionTree ?? []
        const entryById = new Map(entries.map(entry => [entry.id, entry]))

        // 1. 是否在当前分支：以本地消息列表为准——chatMessages 在所有路径（load /
        //    attach 快照 / navigate）都是服务端当前分支的权威全量替换，不存在失步。
        //    不能用 sessionLeafId→root 的树路径判定：树只在 load/done/abort/navigate
        //    时刷新，运行中的 attach 增量（deltaMessages）与 load→attach 间隙会把新
        //    持久化的 entryId 先补进消息列表，rail 随之渲染出这些短横；点击时树里
        //    还没有它们，会被误判成「别的分支」→ isBusy 拦截，弹出与点击意图无关的
        //    「请等待当前消息发送完成」。
        //    也不用 processedMessages：被合并 / 空内容 / 工具结果的 entry 不会出现在
        //    可见气泡里，会漏判成「别的分支」而错误触发 navigate；raw 列表含全部条目。
        const currentBranchIds = new Set(
            chatState.chatMessages
                .map(message => message.entryId)
                .filter((id): id is string => Boolean(id)),
        )

        // 2. 不在当前分支 → 先切到目标所在分支的叶子，让虚拟列表真正渲染出这条消息。
        if (!currentBranchIds.has(entryId)) {
            if (isBusy.value) {
                useToast().warning(t('chat.waitMessage'))
                return
            }
            const leafId = findBranchLeafId(entryId, branchIndexes.value)
            const navigated = await chatState.navigateBranch(leafId)
            // 切分支失败（网络错误 / 后端未返回 messages）时早退：保留弹窗与提示，避免「弹窗关了但没切也没滚」的静默失败。
            if (!navigated) {
                useToast().error(t('chat.treeJumpFailed'))
                return
            }
            await nextTick()
        }

        showSessionTreeModal.value = false
        await nextTick()

        // 3. 找目标 entry 对应的可见气泡：若目标本身没有气泡（被合并 / 空内容 / 工具结果），
        //    沿 parent 链向上找最近一个有气泡的祖先（与 TUI findNearestVisible 一致）。
        const visibleIds = new Set(
            processedMessages.value
                .map(message => message.entryId)
                .filter((id): id is string => Boolean(id))
        )
        let target: string | null = entryId
        while (target && !visibleIds.has(target)) {
            target = entryById.get(target)?.parentId ?? null
        }
        if (target) {
            await virtualMessageListRef.value?.scrollToEntry(target)
            flashEntry(target)
        }
    } finally {
        sessionTreeBusy.value = false
    }
}

/**
 * 解析并执行控制命令：/follow-up | /steer | /abort。
 * 一律走专用 API，不经 POST /chat。
 * @returns true 表示已处理（含参数错误），调用方应直接 return
 */
const trySendDeliveryCommand = async (inputText: string, rawAttachments: ChatAttachment[] = []): Promise<boolean> => {
    const match = inputText.match(deliveryCommandPattern)
    if (!match) return false

    const cmd = match[1].toLowerCase()
    const deliveryText = (match[2] || '').trim()

    if (cmd === 'abort') {
        // /abort 不接受正文；有多余参数也直接中止
        await chatState.abortChat()
        return true
    }

    if (!deliveryText) {
        useToast().warning(cmd === 'steer' ? '用法: /steer <text>' : '用法: /follow-up <text>')
        if (chatInputRef.value) {
            chatInputRef.value.inputText = inputText
        }
        return true
    }

    const sent = cmd === 'steer'
        ? await chatState.steerMessage(deliveryText)
        : await chatState.followMessage(deliveryText)
    if (!sent) {
        // API 失败（toast 已由错误处理弹出）：恢复输入框文本与附件，方便修改后重发
        if (chatInputRef.value) {
            chatInputRef.value.inputText = inputText
            chatInputRef.value.attachments = rawAttachments
        }
        return true
    }
    scrollToBottom(true)
    return true
}

// Send message handler
// Send message handler
const handleSend = async () => {
    let inputText = chatInputRef.value?.inputText?.trim() || ''
    // 用户原始输入快照（不含后续追加的附件文本），用于自动命名判断与生成
    const originalUserText = inputText
    // Check if there are any attachments
    const rawAttachments = chatInputRef.value?.attachments ?? []
    const hasAttachments = rawAttachments.length > 0

    if (!inputText && !hasAttachments && !isBusy.value) return

    const isTreeCommand = inputText.trim() === '/tree'
    if (isTreeCommand && !hasAttachments) {
        if (isBusy.value) {
            useToast().warning(t('home.commandNotAvailableWhileBusy'))
            return
        }
        if (chatInputRef.value) {
            chatInputRef.value.inputText = ''
        }
        await openSessionTree()
        return
    }

    // /todos：客户端命令——重现并展开任务清单面板，不经服务端。
    // 服务端的 /todos 扩展命令在 rpc 宿主下是静默 no-op（todo.ts 的 tui 守卫），
    // 纯 UI 操作在 busy 时也放行（恰恰是模型跑着、面板被关后最需要看的时刻）。
    // 注意：下方正则字面量与 "Case 1: Busy + no text" 注释均为
    // tests/todo-restore-command.test.ts 的次序锚点，改名/移动须同步测试。
    const todosCommand = /^\/todos(?:\s|$)/i.test(inputText)
    if (todosCommand && !hasAttachments) {
        if (chatInputRef.value) {
            chatInputRef.value.inputText = ''
        }
        if (!todoState.restore()) {
            useToast().info(t('home.noTodos'))
        }
        return
    }

    // /compact 不在此拦截：与其它命令统一走 /chat 命令路径（服务端 streamCommandDeferred
    // 先开流发 compaction_start 驱动瞬态压缩行，完成后回执「会话已压缩」并持久化，
    // 展示与其它命令回执一致）。此前拦截到专用端点 + toast 反馈，交互不统一。

    // 命令表命令名（builtin+extension+prompt）：null 表示未加载，isCommandInvocation 会保守回退为 startsWith 判断
    const knownCommandNames = isLoaded.value ? allCommands.value.map(cmd => cmd.name) : null

    const { pushInputHistory } = useChatInput()

    // Optimistic UI update: Clear input immediately
    if (chatInputRef.value) {
        chatInputRef.value.inputText = ''
        chatInputRef.value.attachments = []
    }

    // Case 1: Busy + no text → abort
    if (isBusy.value && !inputText && !hasAttachments) {
        await chatState.abortChat()
        return
    }

    // Case 2: Busy + has text
    if (isBusy.value && inputText) {
        // /follow-up /steer /abort：走控制 API，不经 /chat
        if (await trySendDeliveryCommand(inputText, rawAttachments)) return

        // 检查是否为真正的命令：与后端一致按命令表精确匹配首 token，
        // 未知的 /xxx（如路径开头的消息）作为普通文本走 steer/follow-up。
        // ! 开头不在此拦截，保持走 steer/follow-up（与旧行为一致）。
        // 命令表未加载时保守回退为 startsWith 判断
        if (inputText.startsWith('/') && isCommandInvocation(inputText, knownCommandNames)) {
            // Allow a small set of commands to pass through as normal messages while busy.
            if (busyAllowedCommandPattern.test(inputText)) {
                await chatState.sendMessage(inputText)
                scrollToBottom(true)
                return
            }
            // 其他命令在 busy 状态下不可用
            useToast().warning(t('home.commandNotAvailableWhileBusy'))
            // 恢复输入框内容
            if (chatInputRef.value) {
                chatInputRef.value.inputText = inputText
            }
            return
        }
        // 非命令文本：根据设置决定 busy 时是 steer 还是 follow-up
        const sent = settingsStore.busySendBehavior === 'follow'
            ? await chatState.followMessage(inputText)
            : await chatState.steerMessage(inputText)
        if (!sent) {
            // API 失败：恢复输入框文本与附件，方便修改后重发（消息未入队，不会静默丢失）
            if (chatInputRef.value) {
                chatInputRef.value.inputText = inputText
                chatInputRef.value.attachments = rawAttachments
            }
            return
        }
        scrollToBottom(true)
        return
    }

    // Case 3: Not busy → normal send
    // /follow-up /steer /abort 在 idle 也走控制 API，避免 POST /chat 返回 JSON 而非 SSE
    if (await trySendDeliveryCommand(inputText, rawAttachments)) return

    // Determine session key
    let targetSessionKey = chatState.sessionKey
    const isNew = isNewSession(route)
    // 欢迎页暂存的模型/思考选择（仅新会话首条消息携带）
    let chatOverrides: ChatSendOverrides | undefined

    if (isNew) {
        // 新会话：使用 chatState 中的 agentsSelectedId
        const agentId = chatState.agentsSelectedId
        if (!agentId) {
            useToast().warning('请先创建一个智能体')
            return
        }

        isCreatingSession.value = true
        try {
            targetSessionKey = await sessionsState.commitNewSession(agentId, inputText)
        } catch (e) {
            isCreatingSession.value = false
            console.error('Failed to create session', e)
            // 恢复输入框文本与附件（乐观清空发生在 commitNewSession 之前），
            // 并提示失败——否则网络错误会静默吞掉用户输入
            if (chatInputRef.value) {
                chatInputRef.value.inputText = inputText
                chatInputRef.value.attachments = rawAttachments
            }
            useToast().error(t('home.createSessionFailed'))
            return
        }

        // 取走欢迎页暂存的模型/思考选择，随首条消息一并提交；
        // 同时补到本地会话缓存，避免聊天页显示回退到 agent 默认值。
        // updateSessionLocal 是 Object.assign 合并，patch 只放有值的键，
        // 避免 undefined 覆盖服务端返回的默认值，也保证只选思考级别时同样回填
        chatOverrides = chatInputRef.value?.consumePendingOverrides()
        const overridePatch: Partial<SessionRow> = {}
        const overrideSplit = chatOverrides?.model ? splitModelId(chatOverrides.model) : null
        if (overrideSplit) {
            overridePatch.modelProvider = overrideSplit.provider
            overridePatch.model = overrideSplit.model
        }
        if (chatOverrides?.thinkingLevel) {
            overridePatch.thinkingLevel = chatOverrides.thinkingLevel
        }
        if (Object.keys(overridePatch).length > 0) {
            // currentSession 是 findSessionLocal(sessionKey) 的派生 computed：
            // 此刻 sessionKey 还是空（/new 页），但 patch 落在 commitNewSession upsert
            // 进桶的行实例上；稍后路由 watcher 的 setSessionKey 让 computed 读到同一行，
            // 首屏标签即为用户选择的模型/思考级别
            chatState.patchSessionRowEverywhere(targetSessionKey, overridePatch)
        }
    }

    // 记录输入历史：必须绑定最终 sessionKey。
    // 新会话首条消息如果在 commitNewSession 之前写入，会因为 sessionKey 为空而丢失。
    pushInputHistory(inputText, targetSessionKey)

    // Process attachments:
    // - Images: Keep as attachments
    // - Files: Append content to inputText
    const imageAttachments: any[] = []

    // Process file content appending
    let appendedText = ''
    for (const att of rawAttachments) {
        if (att.mimeType.startsWith('image/')) {
            imageAttachments.push(att)
        } else if (att.content) {
            appendedText += `\n=== File Content: ${att.name || "attachment"} ===\n${att.content}\n==============================\n`
        }
    }

    if (appendedText) {
        if (inputText) inputText += '\n'
        inputText += appendedText
    }

    // Send message with explicit sessionKey (+ 新会话页暂存的模型/思考覆盖)
    await chatState.sendMessage(inputText, [...imageAttachments], targetSessionKey, chatOverrides)

    // 自动命名策略：仅当消息非空、不会被后端当作命令、且 session 还没有 name 时触发。
    // 后端只拦截已知命令，未知的 /xxx（如路径开头）会作为普通消息发给模型，
    // 故按命令表精确匹配首 token；命令表未加载时保守回退为 startsWith 判断
    const trimmedUserText = originalUserText.trimStart()
    const isCommand = isCommandInvocation(trimmedUserText, knownCommandNames)
    const currentSession = targetSessionKey ? sessionsState.findSessionLocal(targetSessionKey) : undefined
    if (targetSessionKey && originalUserText && !isCommand && !currentSession?.titleSet) {
        sessionsState
            .triggerSessionRename(targetSessionKey, originalUserText)
            .catch(err => {
                console.error('Auto-rename failed', err)
            })
    }

    // Navigate to the chat session immediately
    if (isNew) {
        await router.push({ name: 'chat', params: { sessionkey: targetSessionKey } })
        isCreatingSession.value = false
    }

    scrollToBottom(true)
}


// Message actions
const copyMessage = (msg: DisplayMessage) => {
    const text = msg.blocks
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n')
    writeClipboard(text)
}

const readAloud = (msg: DisplayMessage) => {
    const text = msg.blocks
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n')
    ttsReadAloud(msg.id, text)
}

// ==================== Retry / Branch ====================

// 分支锚点记忆（会话隔离）：siblingId -> 离开该分支时停靠的 entryId，
// 切回时优先恢复离开时的视图状态（见 navigateBranch）
const branchAnchors = new Map<string, string>()

// Session tree data for branch navigation
const sessionTreeEntries = computed(() => chatState.sessionTree)
const branchIndexes = computed(() => buildBranchIndexes(sessionTreeEntries.value))

const getBranchInfo = (msg: DisplayMessage): BranchInfo | null => {
    return resolveBranchInfo(msg, branchIndexes.value)
}

const retryMessage = async (msg: DisplayMessage) => {
    if (!msg.entryId) return
    await chatState.retryMessage(msg.entryId)
    // retry 逻辑同上，chatState 会接管
}

const forkMessage = async (msg: DisplayMessage) => {
    // 合并气泡（assistantMsgMerge）显示为一整条，fork 应锚定组内最后一条 entry；
    // 未合并气泡无 lastEntryId，回落 entryId
    const entryId = msg.lastEntryId ?? msg.entryId
    if (!entryId) return
    // 从该条消息处分叉新会话（含该消息），成功后 chatState 会切换过去
    await chatState.forkFromEntry(entryId)
}

const editMessage = async (msg: DisplayMessage, newText: string) => {
    if (!msg.entryId) return
    await chatState.editMessage(msg.entryId, newText)
}

const navigateBranch = async (msg: DisplayMessage, direction: 'prev' | 'next') => {
    const info = getBranchInfo(msg)
    if (!info) return

    const newIndex = direction === 'prev' ? info.currentIndex - 1 : info.currentIndex + 1
    if (newIndex < 0 || newIndex >= info.siblings.length) return

    // 分支锚点记忆：离开某分支时记录停靠条目，切回时优先回到离开时的样子
    // （否则一律下钻到分支最新叶子——fork 停靠在裸 user 消息时会被替换成
    //  原始回复，用户困惑）。会话隔离键；锚点已不在树里则回退默认下钻。
    const anchorKey = (siblingId: string) => `${chatState.sessionKey ?? ''}:${siblingId}`
    const currentSibling = info.siblings[info.currentIndex]
    const leavingEntryId = [...chatState.chatMessages].reverse().find(m => m.entryId)?.entryId
    if (currentSibling && leavingEntryId) {
        branchAnchors.set(anchorKey(currentSibling), leavingEntryId)
    }

    const targetSibling = info.siblings[newIndex]
    const anchor = branchAnchors.get(anchorKey(targetSibling))
    const anchorValid = anchor !== undefined && (chatState.sessionTree ?? []).some(entry => entry.id === anchor)

    // 目标分支停靠点：有锚点回到离开时位置，否则下钻到该分支最新叶子
    const leafId = anchorValid
        ? anchor
        : findBranchLeafId(targetSibling, branchIndexes.value)
    const navigated = await chatState.navigateBranch(leafId)
    if (!navigated) {
        // 运行中导航按钮已隐藏，走到这里只剩渲染竞态/网络失败（服务端 streaming 409 等）
        useToast().error(t('chat.treeJumpFailed'))
        return
    }
    // 切换后强制滚动到底部（延迟确保 DOM 渲染完成）
    scrollToBottom(true)
    setTimeout(() => scrollToBottom(true), 200)
}

// 原有的复杂 Session Tree 监听逻辑全部移除
// chatState 内部现在负责在合适时机更新 sessionTree
// HomeView 只需要响应式消费 chatState.sessionTree 即可


// Voice Chat
const handleRecognizedText = async (text: string) => {
    // Need to send this text to the chat
    // Just simulating input and send
    if (chatInputRef.value) {
        chatInputRef.value.inputText = text
        await handleSend()
    } else {
        // Fallback if ref is missing
        await chatState.sendMessage(text)
        scrollToBottom()
    }
}

const {
    isVoiceChatActive,
    voiceStatus,
    transcript,
    currentlySpeakingText,
    isWaitingForAudio,
    start: startVoiceChat,
    stop: stopVoiceChat,
    speakStream,
    startStream,
    finishStream
} = useVoiceChat(handleRecognizedText)

// Watch streaming text to speak
watch(() => streamingText.value, (newStream) => {
    if (isVoiceChatActive.value && newStream) {
        let text = ''
        if (Array.isArray(newStream)) {
            for (const block of newStream) {
                if (block.type === 'text' && block.text) {
                    text += block.text
                }
            }
        } else if (typeof newStream === 'string') {
            text = newStream
        }

        if (text) speakStream(text)
    }
})

// Watch busy state to manage stream life cycle
watch(isBusy, (busy, prevBusy) => {
    if (!isVoiceChatActive.value) return

    if (!prevBusy && busy) {
        // Started generating
        startStream()
    } else if (prevBusy && !busy) {
        // Finished generating - get the final complete text from last message
        const lastMessages = processedMessages.value
        if (lastMessages.length > 0) {
            const lastMsg = lastMessages[lastMessages.length - 1]
            if (lastMsg.role === 'assistant') {
                const fullText = lastMsg.blocks
                    .filter(b => b.type === 'text')
                    .map(b => b.text || '')
                    .join('\n')
                // Ensure the complete text is processed
                if (fullText) {
                    speakStream(fullText)
                }
            }
        }
        finishStream()
    }
})

// Close dropdown when clicking outside
const handleClickOutside = (event: MouseEvent) => {
    chatHeaderRef.value?.handleClickOutside(event)
    chatInputRef.value?.handleToolbarClickOutside(event)
    if (welcomeAgentDropdownRef.value && !welcomeAgentDropdownRef.value.contains(event.target as Node)) {
        welcomeAgentDropdownRef.value.open = false
    }
}

// Workspace panel 快捷键：
// - Ctrl/Cmd+B 切换面板
// - Ctrl/Cmd+Shift+G 打开面板并切到 Git tab
// - Ctrl/Cmd+Shift+E 打开面板并切到 Files tab
// 在输入框 / contentEditable / IME 输入中不拦截，避免冲突用户编辑。
function handleWorkspaceShortcut(e: KeyboardEvent) {
    if (e.isComposing) return
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return
    if (!(e.ctrlKey || e.metaKey)) return
    if (!e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        wsPanel.toggle()
        return
    }
    if (e.shiftKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        wsPanel.open()
        wsPanel.setTab('git')
        return
    }
    if (e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        wsPanel.open()
        wsPanel.setTab('files')
    }
}

// Workspace Panel 可见性：
// - 需要已选中 agent（面板内容依赖 agent workspace）
// - canShow 不含 isOpen：供移动端 drawer DOM 始终挂载，让 daisyUI drawer-toggle
//   动画能走；isOpen 仅影响 PC 内联 panel 是否 mount。
const canShowWorkspacePanel = computed(() => !!chatState.agentsSelectedId)
const showWorkspacePanel = computed(() =>
    wsPanel.isOpen.value && canShowWorkspacePanel.value,
)

// 移动端判断与 tailwind lg 断点一致（1024px）
const isMobile = useMediaQuery('(max-width: 1023px)')
const showWorkspaceViewer = computed(() => wsViewer.isActive.value)

// 移动端：viewer 打开 / 切换 target 时自动关 drawer。
// drawer 是从右侧滑出占满屏的，viewer 也是全屏替代主区，不关会被 drawer 盖不可见。
// 这里 watch viewer.current（而非 isActive）以便同样在从一个文件切到另一个时也生效。
watch(() => wsViewer.current.value, (curr) => {
    if (curr && isMobile.value) {
        wsPanel.close()
    }
})

// 移动端 drawer 内容懒加载：只有用户第一次打开过（isOpen 变 true）才挂载 WorkspacePanel，
// 之后保持挂载利用缓存。这样未访问过 drawer 的用户不会付出任何 tree/repos 请求代价。
// daisyUI 的动画作用于 drawer-side > *:first-child，包一层 v-if 不影响滑入动画。
// 注意：声明必须在下面的 isMobile watch 之前——watch 带 immediate: true，回调在
// 注册点同步执行，前向引用会触发 TDZ ReferenceError（桌面端 isMobile 初值 false
// 必走赋值分支）。
const mobilePanelMounted = ref(false)
// 移动端进入时强制收起 drawer：
// store.workspacePanel.open 是跨会话持久化的，适合 PC 记忆侧栏布局，
// 但移动端不应该在加载 / 视口变窄时默认展开盖住全屏。
// 规则：只要 isMobile 由 false→true（含初始）且 drawer 是开的 → close 一次。
// 回桌面时卸载 drawer 实例：否则 PC panel（lg 以上可见）与 drawer 内的 panel
// 双实例同时挂载，各自 onMounted / 响应式订阅常驻后台重复拉数据。store 是
// 模块级单例，卸载不丢缓存，重挂载近零成本。
watch(isMobile, (mobile) => {
    if (mobile && wsPanel.isOpen.value) {
        wsPanel.close()
    }
    if (!mobile) mobilePanelMounted.value = false
}, { immediate: true })
// 懒加载置位仅限移动端：桌面端打开的是 PC 实例（!isMobile），这里置 true 会把
// drawer 里被 lg:hidden CSS 隐藏的第二个实例也挂出来——双份 onMounted / 订阅 /
// 请求，且这个隐藏实例要等到下一次 isMobile 翻转才会被卸载。
watch(() => wsPanel.isOpen.value, (open) => {
    if (open && isMobile.value) mobilePanelMounted.value = true
}, { immediate: true })

// Session / Agent 切换时关闭 viewer：
// - 设计决定（与用户确认）：切 session 一律关 viewer，不区分是否同 agent。
//   理由是 viewer 全屏占据主区，切换 session 通常意味着想看另一个会话上下文。
// - 同时监听 agentId：覆盖 /new 路由上用 ChatHeader dropdown 切 agent（sessionKey 不变但
//   workspace 换了）的场景，避免遗留一个针对旧 workspace 的 viewer 路径。
// - dirty 提示：有未保存改动 toast 告知，但不阻塞切换（已经发生）。
// - watch 默认非 immediate，mount 时不会误触发，无需 prev 守卫。
watch(
    [() => chatState.sessionKey, () => chatState.agentsSelectedId],
    ([nextSession, nextAgent], [prevSession, prevAgent]) => {
        if (nextSession === prevSession && nextAgent === prevAgent) return
        if (!wsViewer.isActive.value) return
        const dirty = wsViewer.dirty.value
        if (dirty) {
            useToast().warning(t('workspace.discardedDirty', { path: dirty.path }))
        }
        wsViewer.close()
    },
)

onMounted(async () => {
    document.addEventListener('click', handleClickOutside)
    window.addEventListener('keydown', handleWorkspaceShortcut)
    setupScrollWatchers()
    // 重新挂载时恢复滚动位置（从智能体等非 HomeView 路由返回时需要）
    // 路由 watcher (immediate) 在 setup 阶段触发时 session 切换 watcher 尚未注册，
    // 需要在 onMounted 时兜底恢复。
    restoreIfSaved()
})

onUnmounted(() => {
    document.removeEventListener('click', handleClickOutside)
    window.removeEventListener('keydown', handleWorkspaceShortcut)
    setLightboxSources([])
})



// 路由变化 → 切换会话（核心路由处理逻辑）；query.agent 入 watch 源：
// 已在 /new 页时点击其他 agent 的分组「+」按钮也能重新选中目标 agent
watch(() => [route.params.sessionkey, route.path, route.query.agent], async ([sessionkey]) => {

    // /new 路由 → 创建新会话
    if (isNewSession(route)) {
        // ?agent=<id>（侧栏分组组头「+」按钮入口）最优先，仅当其存在于列表时生效。
        // 其二：复用用户上次在欢迎页下拉里明确选过的 agent（settingsStore 按网关模式
        // 分字段持久化，已删除则跳过）。两者都没有时才回落第一个 agent。
        // 注意不沿用「上一个会话的 agent」：只有下拉里的显式选择才被记住
        // （+ 入口的 ?agent= 仅当次生效，不写回存储，避免改变默认选择）。
        const requestedAgent = typeof route.query.agent === 'string' ? route.query.agent : ''
        const knownRequested = requestedAgent && agentsState.agentsList.some(a => a.id === requestedAgent)
        const rememberedAgent = settingsStore.activeGateway?.lastNewSessionAgentId ?? ''
        const knownRemembered = rememberedAgent && agentsState.agentsList.some(a => a.id === rememberedAgent)
        const defaultAgentId = agentsState.agentsList[0]?.id ?? ''
        const targetAgentId = knownRequested ? requestedAgent : (knownRemembered ? rememberedAgent : defaultAgentId)
        if (targetAgentId) {
            chatState.selectAgent(targetAgentId)
            setCurrentAgent(targetAgentId)
            await loadCommands(targetAgentId)
        }
        await chatState.createNewSession()
        // 恢复 /new 页遗留的输入草稿
        restoreSessionDraft()
        return
    }

    // 路由中有 sessionKey → 切换到该会话（setSessionKey 内部会处理 currentSession / currentAgent）
    if (sessionkey && typeof sessionkey === 'string') {
        // 优化：如果 sessionKey 未变则跳过加载，但恢复滚动位置
        // （从首页/消息等路由返回时，HomeView 不会卸载，scrollTop 可能已重置）
        if (chatState.sessionKey === sessionkey) {
            restoreIfSaved()
            return
        }
        await chatState.setSessionKey(sessionkey)
        // 恢复该会话的输入草稿
        restoreSessionDraft()
        setCurrentAgent(chatState.agentsSelectedId || undefined)
        await loadCommands(chatState.agentsSelectedId || undefined)
        return
    }

    // 没有指定 sessionKey，执行默认行为
    await applyDefaultSessionBehavior()

}, { immediate: true })



// 首页默认行为：始终打开新会话页
async function applyDefaultSessionBehavior() {
    router.replace({ path: NEW_SESSION_PATH })
}
</script>

<template>
    <div class="h-full w-full flex">
        <!-- 移动端侧栏抽屉已上提到 MobileLayout（全视图共享），HomeView 不再挂自己的副本 -->

        <!-- Chat Area：viewer 打开时以全屏覆盖层盖住整列（header/主区/输入框），
             聊天区 DOM 始终保持挂载 -->
        <div class="relative flex-1 flex flex-col h-full min-w-0">

            <!-- Header：panel toggle / 主题 / 会话树 / 通知都依赖它；viewer 打开时被覆盖 -->
            <ChatHeader ref="chatHeaderRef" @start-voice-chat="startVoiceChat" @open-session-tree="openSessionTree"
                :session-name="currentSessionName" :panel-visible="showWorkspacePanel" />

            <!-- Main content area: chat messages -->
            <div class="relative flex-1 flex flex-col min-h-0">
                <!-- 桌面端 session tree rail（minimap）：仅消息列表分支显示，
                     绝对定位在非滚动祖先上，不随消息区滚动 -->
                <SessionTreeRail
                    v-if="settingsStore.isSessionTreeRailVisible && !showWorkspaceViewer && !isLoading && !isNewSessionPage && !isCreatingSession && sessionTreeItems.length > 0"
                    :items="sessionTreeItems"
                    :active-entry-id="virtualMessageListRef?.activeEntryId ?? null"
                    @jump-to-entry="handleJumpToTreeEntry" />
                <!-- Loading state -->
                <div v-if="isLoading" class="flex-1 flex items-center justify-center">
                    <span class="loading loading-spinner loading-lg"></span>
                </div>

                <!-- 新会话欢迎页：居中问候语 + agent 下拉 + 输入框 -->
                <div v-else-if="isNewSessionPage || isCreatingSession"
                    class="relative flex-1 flex flex-col items-center  px-4 py-6 overflow-y-auto">
                    <!-- 背景氛围光晕（纯装饰，不响应交互） -->
                    <div class="welcome-aurora" aria-hidden="true">
                        <div class="welcome-blob welcome-blob-a"></div>
                        <div class="welcome-blob welcome-blob-b"></div>
                        <div class="welcome-blob welcome-blob-c"></div>
                    </div>
                    <!-- 内层撑满高度（flex-1）：让下面的空隙按“高度”参与布局，
                         输入框才能像会话页那样锚定底边、向上扩展（见两处空隙注释） -->
                    <div class="relative w-full max-w-2xl sm:max-w-3xl lg:max-w-4xl flex-1 flex flex-col">
                        <!-- 上方弹性空隙：与下方空隙一起把「图标+问候语」居中在输入框上方空间 -->
                        <div class="flex-1" aria-hidden="true"></div>
                        <img src="/welcome-s.png" alt="" aria-hidden="true" class="welcome-s-icon mx-auto w-24 h-24 sm:w-40 sm:h-40" />
                        <h1 class="welcome-title text-xl sm:text-3xl font-bold text-center mt-8">{{ $t(greetingKey) }}</h1>

                        <!-- 弹性空隙：输入框长高时收缩这里，使输入框底边不动、向上扩展，
                             与会话页底栏输入框行为一致；移动端键盘(resizes-content)弹出时
                             整个 flex 链变矮，输入框随之上浮，不会被键盘盖住 -->
                        <div class="flex-1 min-h-4" aria-hidden="true"></div>

                        <ChatInput ref="chatInputRef" centered class="welcome-fade welcome-delay" :is-busy="isBusy"
                            :disabled="false" @send="handleSend">
                            <template #top>
                                <details ref="welcomeAgentDropdownRef" class="dropdown px-2 pt-1.5">
                                    <summary class="btn btn-ghost btn-sm gap-1.5 list-none px-2 h-auto min-h-0 font-normal">
                                        <FolderIcon class="h-4 w-4 opacity-70" />
                                        <span class="font-medium">{{ agentsState.agentsList.length ? (selectedAgentName || $t('agent.assistant')) : $t('agent.noAgents') }}</span>
                                        <ChevronDownIcon class="h-3.5 w-3.5 shrink-0 opacity-60" />
                                    </summary>
                                    <ul
                                        class="dropdown-content menu bg-base-100 rounded-box z-50 w-52 p-2 shadow-lg border border-base-300">
                                        <li v-for="agent in agentsState.agentsList" :key="agent.id">
                                            <a @click="selectWelcomeAgent(agent.id)"
                                                class="flex justify-between items-center"
                                                :class="{ 'active': chatState.agentsSelectedId === agent.id }">
                                                <span>{{ agent.name }}</span>
                                                <CheckIcon v-if="chatState.agentsSelectedId === agent.id"
                                                    class="h-4 w-4" />
                                            </a>
                                        </li>
                                        <li class="mt-1 border-t border-base-300 pt-1">
                                            <a @click="showAgentFormModal = true"
                                                class="flex items-center gap-2 text-base-content/80">
                                                <FolderOpenIcon class="h-4 w-4 opacity-70" />
                                                <span>{{ $t('agent.addTitle') }}</span>
                                            </a>
                                        </li>
                                    </ul>
                                </details>
                            </template>
                        </ChatInput>

                        <!-- 底部固定空隙（约屏高 1/3）：锚定输入框底边的视觉位置。
                             必须是固定值而非 flex：只有它不随输入框长高而变化，
                             增高才会全部向上释放；百分比基于高度，键盘弹出视口变矮时随之收缩 -->
                        <div class="h-[40%] sm:h-[45%]" aria-hidden="true"></div>
                    </div>
                </div>

                <!-- Chat messages - only this area scrolls（viewer 打开时保持挂载，仅被覆盖层遮盖） -->
                <div v-else ref="messagesContainerRef" class="flex-1 overflow-y-auto p-2 md:p-4 relative">
                    <!-- lg:pl-4：给左侧 SessionTreeRail 预留列空间，避免与消息内容重叠；rail 关闭时同步取消 -->
                    <div class="mx-auto w-full" :class="{ 'lg:pl-4': settingsStore.isSessionTreeRailVisible }">
                        <VirtualMessageList ref="virtualMessageListRef" :messages="processedMessages" :is-busy="isBusy"
                            :scroll-container="messagesContainerRef" :flash-entry-id="flashEntryId"
                            :get-branch-info="getBranchInfo" @copy="copyMessage" @read-aloud="readAloud"
                            @retry="retryMessage" @edit="editMessage"
                            @fork="forkMessage" @navigate-branch="navigateBranch" />
                    </div>

                    <!-- Scroll to bottom FAB -->
                    <Transition name="fade-up">
                        <button v-if="userScrolledUp" @click="scrollToBottom(true)"
                            class="sticky bottom-4 left-1/2 -translate-x-1/2 btn btn-circle btn-sm bg-base-200 hover:bg-base-300 text-base-content border border-base-300 shadow-lg opacity-90 hover:opacity-100 transition-all duration-200 z-10"
                            :title="$t('common.scrollToBottom')">
                            <ChevronDoubleDownIcon class="h-4 w-4" />
                        </button>
                    </Transition>
                </div>
            </div>

            <!-- 输入框上方扩展 dock 区（各 widget 自决定显隐，新会话页不挂载） -->
            <ChatDockArea v-if="!isNewSessionPage && !isCreatingSession" />

            <!-- ChatInput：非新会话页固定在底部（新会话页的输入框居中展示在欢迎区）。viewer 打开时被覆盖 -->
            <ChatInput v-if="!isNewSessionPage && !isCreatingSession" ref="chatInputRef" :is-busy="isBusy"
                :disabled="false" @send="handleSend" />

            <!-- Workspace Viewer：全屏覆盖层（盖住 header/主区/输入框）。挂在 Chat Area 列上，
                 聊天区保持挂载、scrollTop 天然保留——从文件/diff 返回时不会卸载重建导致滚动跳动。
                 z-30：低于 MediaPreviewOverlay / VoiceChatOverlay（fixed z-50），图片/语音预览不被挡 -->
            <WorkspaceViewer v-if="showWorkspaceViewer" :agent-id="chatState.agentsSelectedId || ''"
                :panel-visible="showWorkspacePanel" class="absolute inset-0 z-30" />

            <!-- Voice Chat Overlay -->
            <VoiceChatOverlay :is-open="isVoiceChatActive" :status="voiceStatus" :transcript="transcript"
                :speaking-text="currentlySpeakingText" :is-waiting="isWaitingForAudio" @close="stopVoiceChat" />

            <!-- Media Preview Overlay (shared image lightbox & file viewer) -->
            <MediaPreviewOverlay />

            <SessionTreeModal :open="showSessionTreeModal" :entries="chatState.sessionTree"
                :leaf-id="chatState.sessionLeafId" :busy="sessionTreeBusy"
                @close="showSessionTreeModal = false" @jump-to-entry="handleJumpToTreeEntry" />

            <!-- 子代理轨迹抽屉（全局状态驱动，ToolInvocation 卡片按钮打开） -->
            <SubagentTraceDrawer />
        </div>

        <!-- Workspace Panel (PC 右侧侧栏，可拖宽)。!isMobile：移动端由 drawer 实例负责，
             避免 CSS 隐藏的 PC 实例与 drawer 实例同时挂载、双份拉数据。 -->
        <WorkspacePanel v-if="showWorkspacePanel && !isMobile" :agent-id="chatState.agentsSelectedId || ''"
            class="hidden lg:contents" />

        <!-- Workspace Panel (移动端右侧 drawer，与 AppSidebar 左侧 drawer 的模式一致)
             drawer-end 让它从右侧滑出。canShow 不含 isOpen： DOM 常驻才能走 daisyUI 动画。
             :checked 反映 store 状态、@change 接住点击 overlay 隐含的 toggle。
             内层 v-if="mobilePanelMounted" 实现懒加载：未访问过 drawer 的用户不走任何 fetch。 -->
        <div v-if="canShowWorkspacePanel" class="drawer drawer-end lg:hidden absolute inset-0 pointer-events-none z-[100]">
            <input id="workspace-drawer" type="checkbox" class="drawer-toggle pointer-events-auto"
                :checked="wsPanel.isOpen.value"
                @change="(e: Event) => (e.target as HTMLInputElement).checked ? wsPanel.open() : wsPanel.close()" />
            <div class="drawer-side pointer-events-auto h-full">
                <label for="workspace-drawer" :aria-label="$t('common.close')" class="drawer-overlay app-backdrop"></label>
                <div class="h-full bg-base-100" style="width: min(85vw, 400px)">
                    <WorkspacePanel v-if="mobilePanelMounted" :agent-id="chatState.agentsSelectedId || ''" :mobile="true" />
                </div>
            </div>
        </div>
        <!-- Workspace context menu (PC 右键 + 移动端 kebab 共用同一实例，
             Teleport 到 body 上避免被 panel / drawer 的 overflow-hidden 裁切) -->
        <WorkspaceContextMenu />

        <!-- 「选择文件夹」入口直接打开智能体创建弹窗（创建弹窗内嵌路径校验与预填） -->
        <AgentFormModal :show="showAgentFormModal" mode="add" @close="showAgentFormModal = false"
            @saved="onWorkspaceCreated" />
    </div>
</template>
