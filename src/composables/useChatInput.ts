import { ref, watch } from 'vue'
import { SpeechRecognitionService } from '../utils/asr/speechRecognition'
import { takeAudioControl, releaseAudioControl } from '../utils/audioManager'
import { useUiSettingsStore } from '../stores/setting'
import { useToast } from './useToast'
import { readFile } from '../utils/fileReader'
import { createRuntimeId } from '../utils/runtime-id.ts'
import { useCommandState, type CommandInfo } from './useCommandState'
import { CLIENT_COMMANDS, filterClientCommands } from './clientCommands'
import { useInputHistoryStore, newSessionDraftKeyFor } from '../stores/inputHistory'
import { decideArrowKeyPriority, shouldOpenCommandSuggestions } from '../utils/chat-input-key-routing.ts'
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
    // 按当前 session 记录输入框内容（草稿）：切换会话时恢复，发送时输入被清空、草稿随之清除。
    // /new 新会话页没有 sessionKey，落到按网关模式区分的哨兵 key 上（两侧服务器互不窜台）
    useInputHistoryStore().setDraft(_sessionKeyResolver?.() || newSessionDraftKeyFor(useUiSettingsStore().activeGatewayId), val)

    const fromHistoryNavigation = suppressCommandSuggestionsOnce.value
    suppressCommandSuggestionsOnce.value = false

    if (commandSuggestionsEnabled.value
        && shouldOpenCommandSuggestions(val, fromHistoryNavigation)) {
        const prefix = val.slice(1)
        const serverMatches = filterCommands.value(prefix)
        const serverNames = new Set(serverMatches.map(cmd => cmd.name))
        // 客户端命令（clientCommands 注册表）不在服务端命令表里，按前缀合并、按 name 去重
        commandSuggestions.value = [
            ...serverMatches,
            ...filterClientCommands(prefix).filter(cmd => !serverNames.has(cmd.name)),
        ]
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
    const el = document.querySelector('textarea') as HTMLTextAreaElement
    if (el) el.focus()
}

/** 从命令补全列表中选择某条命令 */
const confirmCommandSuggestion = (cmd: CommandInfo) => {
    inputText.value = `/${cmd.name} `
    commandSuggestionsVisible.value = false
    commandSuggestions.value = []
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
}

const handleKeydown = (e: KeyboardEvent, onSend: () => void) => {
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
                    inputText.value = history[historyIndex.value]
                } else {
                    // 回到最新：恢复草稿
                    historyIndex.value = -1
                    suppressCommandSuggestionsOnce.value = true
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

const addAttachment = async (file: File) => {
    try {
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
    pushInputHistory,
    restoreSessionDraft,
    setSessionKeyResolver,
}

export function useChatInput() {
    return _chatInputState
}
