import { ref, watch, nextTick } from 'vue'
import { SpeechRecognitionService } from '../utils/asr/speechRecognition'
import { takeAudioControl, releaseAudioControl } from '../utils/audioManager'
import { useUiSettingsStore } from '../stores/setting'
import { useToast } from './useToast'
import { i18n } from '../i18n'
import { readFile } from '../utils/fileReader'
import { createRuntimeId } from '../utils/runtime-id.ts'
import { useCommandState, type CommandInfo } from './useCommandState'
import { CLIENT_COMMANDS, filterClientCommands } from './clientCommands'
import { sortByCommandMatchRank } from '../utils/command-name-match.ts'
import { useInputHistoryStore, newSessionDraftKeyFor } from '../stores/inputHistory'
import { decideArrowKeyPriority, shouldOpenCommandSuggestions } from '../utils/chat-input-key-routing.ts'
import {
    parseMentionToken,
    isAbsolutePathLike,
    splitDirPrefix,
    filterMentionEntries,
} from '../utils/path-mention.ts'
import { fetchTree, fetchAbsoluteTree, type TreeEntry } from './workspace-api.ts'
import { getMicrophoneErrorMessage } from '../utils/microphone-errors'

export interface CommandItem {
    label: string
    value: string
    autoSend?: boolean
}

export interface ModelItem {
    label: string
    value: string
}

export const COMMANDS: CommandItem[] = [
    { label: '/reset (会话重置)', value: '/reset' },
    { label: '/name (会话重命名)', value: '/name', autoSend: false },
    { label: '/compact (会话压缩)', value: '/compact' },
    { label: '/steer (干预插入消息)', value: '/steer', autoSend: false },
    { label: '/follow-up (排队后续消息)', value: '/follow-up', autoSend: false },
    { label: '/tools (工具列表)', value: '/tools' },
    { label: '/session (会话信息)', value: '/session' },
    { label: '/debug (调试信息)', value: '/debug' },
    { label: '/help (帮助)', value: '/help' }
]

// ==================== State（模块顶层，单例）====================

const inputText = ref('')
const attachments = ref<{ id: string; name: string; dataUrl: string; mimeType: string; content?: string }[]>([])

// ——— 命令补全 ———
const commandSuggestionsVisible = ref(false)
/** 是否允许 `/` 触发命令补全：新会话页 centered 输入框会关闭它（面板与 Enter/方向键路由共用同一状态，必须在源头关） */
const commandSuggestionsEnabled = ref(true)
const commandSuggestions = ref<CommandInfo[]>([])
const commandSuggestionIndex = ref(0)
const suppressCommandSuggestionsOnce = ref(false)

// ——— @ 路径补全 ———
// 语义：@相对路径 → agent 工作区（/:id/workspace/tree）；@/绝对路径或盘符 → /api/files/tree。
// agentId 由 ChatInput 每次传入（chatState 在其作用域内；直接 import useChatState 会造成
// useChatState→router→HomeView→useChatInput 的模块环，故沿用 setSessionKeyResolver 同款的
// 调用方注入模式）。mentionAgentId 暂存最近一次值：目录确认后续探下一层时在 useChatInput
// 内部重拉，拿不到 ChatInput 的作用域。
const pathMentionVisible = ref(false)
const pathMentionEntries = ref<TreeEntry[]>([])
const pathMentionIndex = ref(0)
let pathMentionStart = -1   // '@' 在全文中的下标（替换区间起点）
let pathMentionEnd = -1     // token 尾（替换区间终点，即解析时光标）
let pathMentionAgentId: string | null = null
let pathMentionSeq = 0      // 过期守卫：新输入/关闭后自增，在飞响应作废
let pathMentionTimer: number | null = null

/** 关闭 @ 补全面板并作废在飞请求（不戏 mentionAgentId——立刻重开会用新值覆盖） */
const closePathMention = () => {
    pathMentionSeq++
    if (pathMentionTimer !== null) {
        clearTimeout(pathMentionTimer)
        pathMentionTimer = null
    }
    pathMentionVisible.value = false
    pathMentionEntries.value = []
    pathMentionIndex.value = 0
    pathMentionStart = -1
    pathMentionEnd = -1
}

/** 输入事件驱动：按当前光标解析 @ token 并拉取目录条目（120ms 防抖 + seq 过期守卫）。
 *  无 token / 无匹配 / 目录不存在 / 网络失败 → 静默收起。 */
const updatePathMention = (caret: number, agentId: string | null) => {
    const token = parseMentionToken(inputText.value, caret)
    if (!token) {
        closePathMention()
        return
    }
    const absolute = isAbsolutePathLike(token.query)
    if (!absolute && !agentId) {
        // 工作区补全没有 agent 无从列目录（新会话页未选 agent 等）
        closePathMention()
        return
    }
    const split = splitDirPrefix(token.query)
    let dirPath = split.dirPath
    if (absolute && dirPath === '') {
        // `@/`、`@/ro` 的目录部分在 split 后为空串：绝对分支空段指文件系统根 '/'
        dirPath = '/'
    }
    if (absolute && /^[a-zA-Z]:$/.test(dirPath)) {
        // 盘符根的 split 产物是裸盘符（'C:/x'、'C:/' → dirPath 'C:'，尾分隔符被吃掉），
        // 而服务端校验与服务端同口径要求盘符后带分隔符，补回 '/'
        dirPath += '/'
    }
    pathMentionStart = token.start
    pathMentionEnd = token.end
    pathMentionAgentId = agentId
    const seq = ++pathMentionSeq
    const prefix = split.prefix
    if (pathMentionTimer !== null) clearTimeout(pathMentionTimer)
    pathMentionTimer = window.setTimeout(() => {
        pathMentionTimer = null
        if (seq !== pathMentionSeq) return
        const req: Promise<{ entries: TreeEntry[] }> = absolute
            ? fetchAbsoluteTree(dirPath)
            : fetchTree(agentId as string, dirPath)
        req.then(result => {
            if (seq !== pathMentionSeq) return
            const entries = filterMentionEntries(result.entries, prefix)
            if (entries.length === 0) {
                closePathMention()
                return
            }
            pathMentionEntries.value = entries
            pathMentionIndex.value = 0
            pathMentionVisible.value = true
        }).catch(() => {
            // 目录不存在（404）/ 越界 / 网络错误：收起不打扰
            if (seq !== pathMentionSeq) return
            closePathMention()
        })
    }, 120)
}

// 回焦依赖调用方注入的 textarea 定位器（ChatInput setup 里用 textareaRef 注册）。
// 不能用 document.querySelector('textarea')：消息区 a2ui longText 字段等更靠前的
// textarea 常驻 DOM，会抢走焦点。selectCommand/confirmCommandSuggestion 的同款全局
// 查找是既有行为，未在本次一并改动。
let textareaResolver: (() => HTMLTextAreaElement | null) | null = null
const setTextareaResolver = (resolver: () => HTMLTextAreaElement | null) => {
    textareaResolver = resolver
}

/** 聚焦输入框并把光标落到指定位置（确认补全后使用） */
const focusTextareaAt = (caret: number) => {
    const el = textareaResolver?.() ?? null
    if (!el) return
    el.focus()
    el.setSelectionRange(caret, caret)
}

/** 确认一条 @ 补全：替换 [start, end) 为 '@'+entry.path；目录补 '/' 续探下一层，
 *  文件补空格并收起。替换区间是解析时的光标段，光标后的木选文本保留。 */
const confirmPathMention = (entry: TreeEntry) => {
    if (pathMentionStart < 0 || pathMentionEnd < 0) return
    const isDir = entry.type === 'dir'
    const insert = '@' + entry.path + (isDir ? '/' : ' ')
    const before = inputText.value.slice(0, pathMentionStart)
    const after = inputText.value.slice(pathMentionEnd)
    inputText.value = before + insert + after
    const newCaret = pathMentionStart + insert.length
    const agentId = pathMentionAgentId
    if (isDir) {
        // 续探：收起旧列表（作废在飞请求），光标就位后按新文本重新解析（拉取该目录内容）
        closePathMention()
        nextTick(() => {
            focusTextareaAt(newCaret)
            updatePathMention(newCaret, agentId)
        })
    } else {
        closePathMention()
        nextTick(() => focusTextareaAt(newCaret))
    }
}

// ——— 其他 UI 状态 ———
const isRecording = ref(false)
const commandDropdownOpen = ref(false)
const modelDropdownOpen = ref(false)

// ——— 输入历史（每个 session 独立，本地持久化）———
const historyIndex = ref(-1)   // -1 = 不在历史浏览模式
const savedDraft = ref('')     // 进入历史浏览前暂存当前输入

// ——— 命令补全 watch（模块级，只注册一次）———
const { filterCommands } = useCommandState()
watch(inputText, (val) => {
    // 发送后 HomeView 乐观清空输入框等外部置空：补全面板随之收起（历史浏览/命令
    // 选择等同文件内的程序化修改各自显式关闭，这里兑底一切非 DOM 输入路径）
    if (!val) closePathMention()
    // 按当前 session 记录输入框内容（草稿）：切换会话时恢复，发送时输入被清空、草稿随之清除。
    // /new 新会话页没有 sessionKey，落到按网关模式区分的哨兵 key 上（两侧服务器互不窜台）
    useInputHistoryStore().setDraft(_sessionKeyResolver?.() || newSessionDraftKeyFor(useUiSettingsStore().activeGatewayId), val)

    const fromHistoryNavigation = suppressCommandSuggestionsOnce.value
    suppressCommandSuggestionsOnce.value = false

    if (commandSuggestionsEnabled.value
        && shouldOpenCommandSuggestions(val, fromHistoryNavigation)) {
        const query = val.slice(1)
        const serverMatches = filterCommands.value(query)
        // 去重键同匹配口径：大小写不敏感（服务端 Taskbar 与客户端 taskbar 视为同名）
        const serverNames = new Set(serverMatches.map(cmd => cmd.name.toLowerCase()))
        // 客户端命令（clientCommands 注册表）不在服务端命令表里，按统一匹配规则合并、按 name 去重
        // （匹配语义见 utils/command-name-match：名字段子串，/what 也能命中 wait-what）
        const merged = [
            ...serverMatches,
            ...filterClientCommands(query).filter(cmd => !serverNames.has(cmd.name.toLowerCase())),
        ]
        // 命中强度分级排序（稳定）：精确 > 全名前缀 > 名字段精确 > 名字段子串。
        // 否则手打全名 + Enter 默认确认的 index 0 可能被弱命中抢占
        // （如 skill:x-taskbar 抢占 /taskbar，或 skill:wait-what 抢占 /wait 对应的 skill:wait）
        commandSuggestions.value = sortByCommandMatchRank(merged, query)
        commandSuggestionsVisible.value = commandSuggestions.value.length > 0
        commandSuggestionIndex.value = 0
    } else {
        commandSuggestions.value = []
        commandSuggestionsVisible.value = false
    }
})

// 附件草稿 watch（模块级，只注册一次）：与 inputText 同款按 session 持久化（图片 dataUrl / 文件内容）。
// 发送后清空 attachments（HomeView 乐观清空）、移除单个附件都会触发，存储随之同步。
watch(attachments, (list) => {
    useInputHistoryStore().setDraftAttachments(_sessionKeyResolver?.() || newSessionDraftKeyFor(useUiSettingsStore().activeGatewayId), list)
}, { deep: true })

// ==================== Actions ====================

const selectCommand = (cmd: string) => {
    inputText.value = cmd + ' '
    commandDropdownOpen.value = false
    commandSuggestionsVisible.value = false
    closePathMention()
    const el = document.querySelector('textarea') as HTMLTextAreaElement
    if (el) el.focus()
}

/** 从命令补全列表中选择某条命令 */
const confirmCommandSuggestion = (cmd: CommandInfo) => {
    inputText.value = `/${cmd.name} `
    commandSuggestionsVisible.value = false
    commandSuggestions.value = []
    closePathMention()
    const el = document.querySelector('textarea') as HTMLTextAreaElement
    if (el) el.focus()
}

/** 关闭命令补全浮层 */
const closeSuggestions = () => {
    commandSuggestionsVisible.value = false
}

// ——— 语音识别（模块级单例）———
let speechService: SpeechRecognitionService | null = null
let silenceTimer: number | null = null

const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = window.setTimeout(() => {
        if (isRecording.value) {
            console.log('Silence timeout, stopping recording')
            handleMicClick()
        }
    }, 10000)
}

const stopRecording = async () => {
    if (isRecording.value) {
        await handleMicClick()
    }
}

const handleMicClick = async () => {
    const settingsStore = useUiSettingsStore()
    if (!settingsStore.isCurrentAsrConfigured) {
        const toast = useToast()
        toast.error('请先在设置中完整配置语音识别')
        return
    }

    if (!speechService) {
        speechService = new SpeechRecognitionService()
    }

    if (isRecording.value) {
        isRecording.value = false
        if (silenceTimer) {
            clearTimeout(silenceTimer)
            silenceTimer = null
        }
        if (speechService) {
            await speechService.stop()
        }
        releaseAudioControl(stopRecording)
        return
    }

    // START RECORDING
    takeAudioControl('ChatInput', stopRecording)
    isRecording.value = true
    resetSilenceTimer()

    try {
        const currentBaseText = inputText.value
        await speechService.start((text: string, isFinal: boolean) => {
            resetSilenceTimer()
            const separator = (currentBaseText && !currentBaseText.endsWith('\n') && !currentBaseText.endsWith(' ')) ? ' ' : ''
            inputText.value = currentBaseText + separator + text
        })
    } catch (error: any) {
        console.error('Failed to start recording:', error)
        isRecording.value = false
        if (silenceTimer) clearTimeout(silenceTimer)

        releaseAudioControl(stopRecording)

        const toast = useToast()
        toast.error(getMicrophoneErrorMessage(error))
    }
}

const handleInputFocus = () => {
    if (isRecording.value) {
        handleMicClick()
    }
}

/** session key 解析回调（由外部设置，避免循环依赖） */
let _sessionKeyResolver: (() => string) | null = null
const setSessionKeyResolver = (resolver: () => string) => {
    _sessionKeyResolver = resolver
}

/** 获取当前 session 的输入历史 */
const _getSessionHistory = (): string[] => {
    const key = _sessionKeyResolver?.() || ''
    if (!key) return []
    const historyStore = useInputHistoryStore()
    return historyStore.getHistory(key)
}

/** 将输入文本追加到指定 session 的历史记录；未传时回退到当前 session */
const pushInputHistory = (text: string, sessionKey?: string) => {
    const key = sessionKey?.trim() || _sessionKeyResolver?.() || ''
    if (!key) return
    const historyStore = useInputHistoryStore()
    historyStore.pushHistory(key, text)
    // 重置浏览指针
    historyIndex.value = -1
}

/** 会话切换时调用：把该 session 的草稿恢复到输入框（无草稿则清空），附件草稿同步恢复 */
const restoreSessionDraft = () => {
    const key = _sessionKeyResolver?.() || newSessionDraftKeyFor(useUiSettingsStore().activeGatewayId)
    const historyStore = useInputHistoryStore()
    inputText.value = historyStore.getDraft(key)
    // 附件草稿恢复：id 是运行时标识，重新生成
    attachments.value = historyStore.getDraftAttachments(key).map(a => ({ ...a, id: createRuntimeId('attachment') }))
    // 切换会话退出历史浏览态
    historyIndex.value = -1
    savedDraft.value = ''
    closePathMention()
}

const handleKeydown = (e: KeyboardEvent, onSend: () => void) => {
    // ——— @ 路径补全键盘路由 ———
    // 与命令补全互斥（命令要求全文 ^/ 开头，@ token 以 @ 起头），两块各自判可见即可；
    // 历史浏览态优先（历史恢复时已显式收起面板，historyIndex!==-1 分支是双保险）。
    // Tab 仅在面板可见时拦截（否则保持原生焦点移动/ghost 建议等既有路由）；
    // Shift+Enter 保持换行不确认。
    if (pathMentionVisible.value && historyIndex.value === -1) {
        // IME 组合期不接管（组合期 Enter 是确认候选词、方向键属于 IME）；
        // 带修饰键的方向键（Shift+↑↓ 跨行选文本）/ Shift+Tab（反向焦点移动）不劫持
        if (e.isComposing || e.keyCode === 229) return
        const count = pathMentionEntries.value.length
        if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.metaKey) {
            e.preventDefault()
            if (count > 0) pathMentionIndex.value = (pathMentionIndex.value + 1) % count
            return
        }
        if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.metaKey) {
            e.preventDefault()
            if (count > 0) pathMentionIndex.value = (pathMentionIndex.value - 1 + count) % count
            return
        }
        if ((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) || (e.key === 'Tab' && !e.ctrlKey && !e.shiftKey)) {
            e.preventDefault()
            const selected = pathMentionEntries.value[pathMentionIndex.value]
            if (selected) confirmPathMention(selected)
            return
        }
        if (e.key === 'Escape') {
            e.preventDefault()
            closePathMention()
            return
        }
    }

    const arrowKeyPriority = decideArrowKeyPriority({
        key: e.key,
        commandSuggestionsVisible: commandSuggestionsVisible.value,
        historyIndex: historyIndex.value,
    })

    if (commandSuggestionsVisible.value) {
        if (arrowKeyPriority === 'suggestions' && e.key === 'ArrowDown') {
            e.preventDefault()
            commandSuggestionIndex.value = (commandSuggestionIndex.value + 1) % commandSuggestions.value.length
            return
        }
        if (arrowKeyPriority === 'suggestions' && e.key === 'ArrowUp') {
            e.preventDefault()
            commandSuggestionIndex.value =
                (commandSuggestionIndex.value - 1 + commandSuggestions.value.length) % commandSuggestions.value.length
            return
        }
        if (e.key === 'Enter' && !e.ctrlKey) {
            e.preventDefault()
            const selected = commandSuggestions.value[commandSuggestionIndex.value]
            if (selected) confirmCommandSuggestion(selected)
            return
        }
        if (e.key === 'Escape') {
            e.preventDefault()
            closeSuggestions()
            return
        }
    }

    // ——— 输入历史上下翻阅 ———
    const textarea = e.target as HTMLTextAreaElement
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.metaKey) {
        // 仅当光标在第一行时触发（多行文本中不拦截正常的光标移动）
        const cursorPos = textarea.selectionStart
        const textBeforeCursor = textarea.value.substring(0, cursorPos)
        if (!textBeforeCursor.includes('\n')) {
            const history = _getSessionHistory()
            if (history.length === 0) return

            e.preventDefault()
            if (historyIndex.value === -1) {
                // 首次进入历史浏览，保存当前草稿
                savedDraft.value = inputText.value
                historyIndex.value = history.length - 1
            } else if (historyIndex.value > 0) {
                historyIndex.value--
            }
            suppressCommandSuggestionsOnce.value = true
            closePathMention()
            inputText.value = history[historyIndex.value]
            return
        }
    }

    if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.metaKey) {
        // 仅当光标在最后一行时触发
        const cursorPos = textarea.selectionStart
        const textAfterCursor = textarea.value.substring(cursorPos)
        if (!textAfterCursor.includes('\n')) {
            if (historyIndex.value !== -1) {
                e.preventDefault()
                const history = _getSessionHistory()
                if (historyIndex.value < history.length - 1) {
                    historyIndex.value++
                    suppressCommandSuggestionsOnce.value = true
                    closePathMention()
                    inputText.value = history[historyIndex.value]
                } else {
                    // 回到最新：恢复草稿
                    historyIndex.value = -1
                    suppressCommandSuggestionsOnce.value = true
                    closePathMention()
                    inputText.value = savedDraft.value
                }
                return
            }
        }
    }

    // 非上下键操作时，退出历史浏览模式（用户开始新输入）
    if (historyIndex.value !== -1 && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
        historyIndex.value = -1
    }

    // Ctrl+Enter 发送消息
    if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault()
        stopRecording()
        onSend()
    }
}

const closeDropdowns = () => {
    commandDropdownOpen.value = false
    modelDropdownOpen.value = false
}

/** 视频文件判定：MIME 优先；部分平台（.mkv/.avi 拖放、WebView）MIME 为空时按扩展名兜底，
 *  否则会走 readFileTextAsync 把多 GB 二进制整读成文本 */
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|mkv|avi|webm|wmv|flv|3gp)$/i
const isVideoFile = (file: File): boolean =>
    file.type.startsWith('video/') || (!file.type && VIDEO_EXT_RE.test(file.name))

const addAttachment = async (file: File) => {
    try {
        // 视频文件不再按文本读取（二进制当文本读只会污染上下文，模型也无法用）:
        // 提示放进工作区用路径引用——generate_video 的素材地址（@相对路径/绝对
        // 路径）语义，服务端会解析并上传
        if (isVideoFile(file)) {
            useToast().warning(i18n.global.t('chat.videoAttachmentRejected'))
            return
        }
        const isImage = file.type.startsWith('image/')
        const result = await readFile(file)
        attachments.value.push({
            id: createRuntimeId('attachment'),
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataUrl: isImage ? result : '',
            content: isImage ? undefined : result
        })
    } catch (e) {
        console.error('Failed to read file', e)
        const toast = useToast()
        toast.error(`读取文件失败: ${file.name}`)
    }
}

const removeAttachment = (id: string) => {
    attachments.value = attachments.value.filter(a => a.id !== id)
}

/**
 * 外部追加文本到输入区（如文件树右键菜单的“发送 @引用 / 发送内容”）。
 *
 * 必须同步退出 history 浏览态：否则用户这一刻正在 ArrowUp 翻历史，
 * 追加后一旦再 ArrowDown 会被 handleKeydown “恢复到 savedDraft” 吃掉刚推送进来的内容。
 * 这个重置语义是 useChatInput 内部不变量的一部分，不应由调用方去戍 historyIndex 私有状态。
 *
 * 分隔策略：仅在当前文本不以空格/换行结尾 且 追加文本不以空格/换行起头时
 * 才补一个空格。fenceContent 返回的文本 \n 起头，这里就不会多出 trailing space。
 */
const appendText = (text: string) => {
    if (!text) return
    historyIndex.value = -1
    savedDraft.value = ''
    closePathMention()
    const current = inputText.value
    if (!current) {
        inputText.value = text
        return
    }
    const needsSep = !current.endsWith(' ') && !current.endsWith('\n')
        && !text.startsWith(' ') && !text.startsWith('\n')
    inputText.value = current + (needsSep ? ' ' : '') + text
}

// ==================== Export ====================

const _chatInputState = {
    inputText,
    isRecording,
    commandDropdownOpen,
    modelDropdownOpen,
    attachments,
    selectCommand,
    handleMicClick,
    handleInputFocus,
    handleKeydown,
    closeDropdowns,
    stopRecording,
    addAttachment,
    removeAttachment,
    appendText,
    commands: COMMANDS,
    clientCommands: CLIENT_COMMANDS,
    commandSuggestionsVisible,
    commandSuggestionsEnabled,
    commandSuggestions,
    commandSuggestionIndex,
    confirmCommandSuggestion,
    closeSuggestions,
    pathMentionVisible,
    pathMentionEntries,
    pathMentionIndex,
    updatePathMention,
    confirmPathMention,
    closePathMention,
    setTextareaResolver,
    pushInputHistory,
    restoreSessionDraft,
    setSessionKeyResolver,
}

export function useChatInput() {
    return _chatInputState
}
