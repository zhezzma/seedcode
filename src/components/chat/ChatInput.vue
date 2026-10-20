<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

import {
    CameraIcon,
    MicrophoneIcon,
    CheckIcon,
    PaperAirplaneIcon,
    StopIcon,
    ChevronUpIcon,
    CommandLineIcon,
    CpuChipIcon,
    ShieldCheckIcon,
    LightBulbIcon,
    BoltIcon,
    InboxArrowDownIcon,
    XMarkIcon
} from '@heroicons/vue/24/outline'
import { useChatInput, COMMANDS, type CommandItem } from '../../composables/useChatInput'
import { useModelsState } from '../../composables/useModelsState'
import { useChatState, type ChatSendOverrides } from '../../composables/useChatState'
import type { CommandInfo } from '../../composables/useCommandState'
import { useUiSettingsStore, type BusySendBehavior } from '../../stores/setting'
import { useCommandState } from '../../composables/useCommandState'
import { isCommandInvocation } from '../../utils/command-invocation'
import { isClientInterceptedCommand } from '../../composables/clientCommands'
import { computed } from 'vue'
import { useMediaPreview } from '../../composables/useMediaPreview'
import { usePermissionMode, type PermissionMode } from '../../composables/usePermissionMode'
import ModelSelectMenuContent from '../models/ModelSelectMenuContent.vue'
import { isNewSession } from '../../utils/route-helpers'

const props = defineProps<{
    isBusy: boolean
    disabled: boolean
    /** 新会话页居中布局：去掉外层 padding/border，顶部预留 agent 选择插槽 */
    centered?: boolean
}>()

const route = useRoute()
const chatState = useChatState()
const settingsStore = useUiSettingsStore()
const { availableModels } = useModelsState()
const { t } = useI18n()
// busy 单源：useChatMessages.ts 的 isBusy（发送中/运行中信号）经 HomeView props 传入。
// 不在此本地重推——busy 语义变更（如纳入 compacting）只改 useChatMessages 一处
const isBusy = computed(() => props.isBusy)
const emit = defineEmits<{
    (e: 'send', mode?: BusySendBehavior): void
}>()
// busy 双通道主色高亮跟随设置：'steer' → 「插入」主色；默认 'follow' → 「排队」主色。
// 设置同时决定发送键（Ctrl+Enter）的默认通道（HomeView 无 mode 时回落 busySendBehavior），此处仅管视觉
const busySteerEmphasized = computed(() => settingsStore.busySendBehavior === 'steer')

const { allCommands, isLoaded: commandsLoaded } = useCommandState()

const {
    inputText,
    isRecording,
    commandDropdownOpen,
    modelDropdownOpen,
    attachments,
    selectCommand,
    handleMicClick,
    handleInputFocus,
    stopRecording,
    handleKeydown,
    closeDropdowns,
    addAttachment,
    removeAttachment,
    commandSuggestionsVisible,
    commandSuggestionsEnabled,
    commandSuggestions,
    commandSuggestionIndex,
    confirmCommandSuggestion,
    closeSuggestions,
    clientCommands,
} = useChatInput()

// busy 时输入的是命令调用 → 显示原发送按钮而非双胶囊：命令在 HomeView Case 2
// 先于 mode 分流被拦截（命令语义优先），胶囊标签会与实际行为矛盾。
// 谓词覆盖 HomeView.handleSend 的全部「mode 不消费」拦截点，与之同源：
// - HomeView 顶部对输入 trim() 后才路由，此处同样取整段修剪文本（前导空白粘贴不漂移）；
// - 服务端命令：startsWith('/') 门禁（! 前缀不算，仍走 mode）+ 命令表精确匹配
//   首 token（isCommandInvocation，表未加载时保守回退为「是命令」）；
// - 客户端命令：从 clientCommands 注册表派生（isClientInterceptedCommand，
//   按 intercept 标注匹配 exact/prefix），新增命令只改注册表，UI 自动跟随。
//   isCommandInvocation 镜像后端语义、另有调用方（自动命名守卫等），
//   客户端命令只在 UI 谓词合并，不写入 util。
// 资源命令（prompt 模板 / skill，如 /handoff）例外：busy 时与普通文本同交互——
// HomeView.handleSend Case 2 把它落到 steer/follow-up 同路径，故此处返回 false
// 显双胶囊（mode 被消费），而非原发送按钮。按命令表 source 判定，表未加载时
// 保守不判（回落到下方 isCommandInvocation，与旧行为一致）。
const busyCommandText = computed(() => {
    const text = inputText.value.trim()
    if (!text.startsWith('/')) return false
    if (commandsLoaded.value) {
        const name = (text.slice(1).split(/\s+/)[0] || '').toLowerCase()
        if (allCommands.value.some(cmd => cmd.name.toLowerCase() === name && (cmd.source === 'prompt' || cmd.source === 'skill'))) {
            return false
        }
    }
    return isCommandInvocation(text, commandsLoaded.value ? allCommands.value.map(cmd => cmd.name) : null)
        || isClientInterceptedCommand(text)
})

// 本地指令分区条目：注册表（ClientCommand）→ 下拉 CommandItem，供「命令」按钮下拉渲染；
// 新增客户端命令只改 clientCommands.ts 注册表，这里与 / 补全自动跟随
const clientCommandItems: CommandItem[] = clientCommands.map(cmd => ({
    label: cmd.dropdownLabel || `/${cmd.name}`,
    value: `/${cmd.name}`,
    autoSend: cmd.autoSend,
}))

// 新会话页(centered)：禁用 `/` 触发命令补全浮层。必须在状态源头关，
// 否则内部 Enter 仍会走“确认补全”而非发送。两种输入框互斥挂载，各自 mount 时按 props 纠正全局开关。
commandSuggestionsEnabled.value = !props.centered
// 开关只阻止“打开”，不复位已开的浮层：从会话页带着打开的面板切到 /new 时补一行保险
if (!commandSuggestionsEnabled.value) closeSuggestions()

// 命令来源徽章：类名与文案集中在这张表，模板只消费——
// 避免 class/label 两处平行三元链各自演化、分支漂移；未知来源回退扩展样式
const SOURCE_BADGES: Record<NonNullable<CommandInfo['source']>, { cls: string, label: string }> = {
    builtin: { cls: 'badge-ghost', label: '内置' },
    skill: { cls: 'badge-accent', label: '技能' },
    prompt: { cls: 'badge-secondary badge-outline', label: 'Prompt' },
    extension: { cls: 'badge-primary badge-outline', label: '扩展' },
    client: { cls: 'badge-ghost', label: '本地' },
}
const sourceBadge = (source: CommandInfo['source']) =>
    (source && SOURCE_BADGES[source]) || { cls: 'badge-primary badge-outline', label: '扩展' }

const fileInputRef = ref<HTMLInputElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const commandSuggestionsPanelRef = ref<HTMLDivElement | null>(null)

const { openLightbox } = useMediaPreview()

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type ThinkingLevel = typeof THINKING_LEVELS[number]


const thinkingDropdownOpen = ref(false)

// 会话权限模式（第四下拉）：新会话页仅本地暂存、随首条消息一并提交
// （服务端 prompt 前落账，首轮 tool call 即生效）；既有会话立即 POST 切档。
// 显隐由 permAvailable 驱动：permission-gate 未启用（全局/agent 级禁用，
// 或旧服务端无此扩展路由）时选择框整体隐藏；隐藏期间清掉创建期暂存档位，
// 避免把失效覆盖随首条消息带给新会话。
const permState = usePermissionMode()
// 挂载即重探可用性：管理面开关扩展后返回聊天页，选择框显隐立即跟上
// （watch 只在 agent/会话变化时触发，同会话往返不触发）
permState.pokeAvailability()
const permAvailable = permState.available
const pendingPermissionMode = ref<PermissionMode | null>(null)
const permissionMode = computed<PermissionMode>(() =>
    isPendingMode.value ? (pendingPermissionMode.value ?? 'autonomous') : permState.mode.value,
)
const permDropdownOpen = ref(false)
// 隐藏时清掉创建期暂存档位并收起下拉：不可用状态下不应残留失效覆盖
watch(permAvailable, (visible) => {
    if (!visible) {
        pendingPermissionMode.value = null
        permDropdownOpen.value = false
    }
})
const PERM_MODES: PermissionMode[] = ['careful', 'autonomous', 'full']
const selectPermissionMode = (m: PermissionMode) => {
    permDropdownOpen.value = false
    if (isPendingMode.value) {
        pendingPermissionMode.value = m
        return
    }
    void permState.setMode(m)
}

// 新会话（/new）：模型/思考选择不即时下发，只记录到本地，随首条消息一并提交
const isPendingMode = computed(() => isNewSession(route))
const pendingModel = ref('')
const pendingThinkingLevel = ref<ThinkingLevel | null>(null)

// 当前模型：优先从 session 获取，否则从 agent 默认值获取
// 使用 computed 而非 ref + watch，确保 session 属性变更时能正确响应
const currentModel = computed(() => {
    if (isPendingMode.value && pendingModel.value) {
        return pendingModel.value
    }
    const session = chatState.currentSession
    if (session && session.modelProvider && session.model) {
        return `${session.modelProvider}/${session.model}`
    }
    const agent = chatState.currentAgent
    if (agent) {
        return `${agent.defaultProvider}/${agent.defaultModel}`
    }
    return ''
})

const currentModelLabel = computed(() => {
    const value = currentModel.value
    if (!value) return ''

    for (const group of availableModels.value) {
        const matched = group.models.find((model) => `${group.provider}/${model.id}` === value)
        if (matched) {
            return `${group.name}/${matched.name}`
        }
    }

    return value
})

// 当前模型的完整配置（reasoning / thinkingLevelMap），用于按能力过滤思考等级
const currentModelInfo = computed(() => {
    const value = currentModel.value
    if (!value) return undefined
    for (const group of availableModels.value) {
        const matched = group.models.find((model) => `${group.provider}/${model.id}` === value)
        if (matched) return matched
    }
    return undefined
})

// 复刻上游 pi-ai getSupportedThinkingLevels：
// - 非 reasoning 模型只有 off；
// - thinkingLevelMap 中 null 表示该级别禁用；
// - xhigh/max 需显式映射才视为支持（否则 pi 会 clamp 到 high）。
// 找不到模型配置时回退为全部级别，避免误屏蔽。
const supportedThinkingLevels = computed<readonly ThinkingLevel[]>(() => {
    const model = currentModelInfo.value
    if (!model) return THINKING_LEVELS
    if (!model.reasoning) return ['off']
    return THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level]
        if (mapped === null) return false
        if (level === 'xhigh' || level === 'max') return mapped !== undefined
        return true
    })
})

// 思考级别：优先从 session 获取，否则从 agent 默认值获取
// 使用 computed 确保 /thinking 命令修改 session.thinkingLevel 后能正确响应
const thinkingLevel = computed<ThinkingLevel>(() => {
    if (isPendingMode.value && pendingThinkingLevel.value) {
        return pendingThinkingLevel.value
    }
    const session = chatState.currentSession
    const sessionLevel = session?.thinkingLevel
    if (sessionLevel && (THINKING_LEVELS as readonly string[]).includes(sessionLevel)) {
        return sessionLevel as ThinkingLevel
    }

    const agent = chatState.currentAgent
    const agentLevel = agent?.defaultThinkingLevel || 'off'
    return (THINKING_LEVELS as readonly string[]).includes(agentLevel) ? (agentLevel as ThinkingLevel) : 'off'
})



const selectThinkingLevel = (level: ThinkingLevel) => {
    thinkingDropdownOpen.value = false
    // 新会话：仅本地记录，等首条消息一起提交（服务端在 /chat 时应用）
    if (isPendingMode.value) {
        pendingThinkingLevel.value = level
        return
    }
    // 既有会话：直接请求服务端切换（不产生命令消息、不开 SSE），失败由 setter 回滚乐观更新
    chatState.setSessionThinkingLevel(level)
}

const getThinkingLabel = () => t(`chat.thinkingLevels.${thinkingLevel.value}`)

const adjustHeight = () => {
    if (textareaRef.value) {
        textareaRef.value.style.height = 'auto'
        textareaRef.value.style.height = textareaRef.value.scrollHeight + 'px'
    }
}

// Watch input text changes to adjust height (handles clearing)
watch(inputText, () => {
    nextTick(() => {
        adjustHeight()
    })
})

// 键盘切换命令建议高亮时，确保对应条目滚动到可视区。
// 否则高亮索引已经变化，但面板滚动位置不动，用户会误以为没有切换到底部/顶部。
watch(commandSuggestionIndex, () => {
    nextTick(() => {
        const panel = commandSuggestionsPanelRef.value
        if (!panel || !commandSuggestionsVisible.value) return

        const activeItem = panel.querySelector<HTMLElement>('[data-command-suggestion-active="true"]')
        activeItem?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
})

const triggerFileInput = () => {
    fileInputRef.value?.click()
}

const handleFileChange = (e: Event) => {
    const target = e.target as HTMLInputElement
    if (target.files && target.files.length > 0) {
        addAttachment(target.files[0])
        // Reset input so same file can be selected again if needed
        target.value = ''
    }
}

const onSend = (mode?: BusySendBehavior) => {
    stopRecording();
    emit('send', mode)
}

const handleCommandSelect = (cmd: CommandItem) => {
    selectCommand(cmd.value)
    if (settingsStore.autoSendCommands && cmd.autoSend !== false) {
        nextTick(() => {
            onSend()
        })
    }
}

/** 取走新会话页暂存的模型/思考选择并清空（仅在发送首条消息时调用） */
const consumePendingOverrides = (): ChatSendOverrides => {
    const overrides: ChatSendOverrides = {
        model: pendingModel.value || undefined,
        thinkingLevel: pendingThinkingLevel.value || undefined,
        permissionMode: pendingPermissionMode.value ?? undefined,
    }
    pendingModel.value = ''
    pendingThinkingLevel.value = null
    pendingPermissionMode.value = null
    return overrides
}

const handleModelSelect = (modelId: string) => {
    modelDropdownOpen.value = false
    // 新会话：仅本地记录，等首条消息一起提交（服务端在 /chat 时应用）
    if (isPendingMode.value) {
        pendingModel.value = modelId
        return
    }
    // 既有会话：直接请求服务端切换（不产生命令消息、不开 SSE），失败由 setter 回滚乐观更新
    chatState.setSessionModel(modelId)
}

// Persist setting when toggled
watch(() => settingsStore.autoSendCommands, () => {
    settingsStore.persist()
})

const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault()
            const blob = item.getAsFile()
            if (blob) {
                // Generate a friendly filename with timestamp
                const ext = item.type.split('/')[1] || 'png'
                const name = `clipboard-${Date.now()}.${ext}`
                const file = new File([blob], name, { type: item.type })
                addAttachment(file)
            }
        }
    }
}

const handleInputKeydown = (e: KeyboardEvent) => {
    handleKeydown(e, onSend)
}

// Close dropdowns when clicking outside toolbar
const handleToolbarClickOutside = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    if (!target.closest('.dropdown-top')) {
        closeDropdowns()
        thinkingDropdownOpen.value = false
        permDropdownOpen.value = false
    }
    // 点击外部时关闭命令补全浮层
    if (!target.closest('.command-suggestions-panel') && !target.closest('textarea')) {
        closeSuggestions()
    }
}

defineExpose({
    inputText,
    attachments,
    consumePendingOverrides,
    handleToolbarClickOutside
})
</script>

<template>
    <div :class="centered ? 'p-0 bg-transparent' : 'p-4 border-t border-base-300 bg-base-100/40'">
        <div
            class="bg-base-200/50 rounded-[2rem] p-2 pr-2 shadow-sm border border-base-300 flex flex-col gap-1 relative focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/50 transition-all duration-300">
            <!-- Preview Area -->
            <div v-if="attachments.length > 0"
                class="flex gap-2 px-3 pt-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-base-300 scrollbar-track-transparent">
                <div v-for="att in attachments" :key="att.id" class="relative group flex-shrink-0">
                    <!-- Image Preview -->
                    <div v-if="att.mimeType.startsWith('image/')" class="relative cursor-pointer"
                        @click="openLightbox(att.dataUrl)">
                        <img :src="att.dataUrl" class="h-16 w-16 object-cover rounded-lg border border-base-300"
                            :title="att.name" />
                    </div>
                    <!-- File Preview -->
                    <div v-else
                        class="h-16 w-16 bg-base-300 rounded-lg flex flex-col items-center justify-center p-1 border border-base-content/10"
                        :title="att.name">
                        <!-- Simple Document Icon using Heroicons path (or generic placeholder) -->
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"
                            stroke="currentColor" class="w-8 h-8 opacity-50">
                            <path stroke-linecap="round" stroke-linejoin="round"
                                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                        <span class="text-[9px] w-full truncate text-center opacity-70 leading-tight mt-0.5">{{ att.name
                        }}</span>
                    </div>

                    <!-- Delete Button: Always visible on mobile (using forced opacity or just remove opacity class). 
                         Changed color to bg-base-100 (white/dark) with shadow and border for better visibility without being 'red'. -->
                    <button @click="removeAttachment(att.id)"
                        class="absolute -top-1.5 -right-1.5 btn btn-circle btn-xs bg-base-100 hover:bg-base-200 border-base-300 shadow-sm text-base-content/70 z-10 transition-transform hover:scale-110">
                        <XMarkIcon class="h-3 w-3" />
                    </button>
                </div>
            </div>

            <!-- Top slot: 新会话页放 agent 选择下拉，与输入框同一张卡片 -->
            <slot name="top"></slot>

            <!-- 命令补全浮层 -->
            <div v-if="commandSuggestionsVisible"
                class="absolute left-3 right-3 bottom-full mb-2 w-auto max-w-[calc(100vw-1.5rem)] sm:right-auto sm:w-96 sm:max-w-none max-h-64 bg-base-100 border border-base-300 rounded-xl shadow-xl z-[200] overflow-hidden flex flex-col">
                <div
                    class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-base-content/40 border-b border-base-300 shrink-0">
                    命令建议
                </div>
                <div ref="commandSuggestionsPanelRef"
                    class="command-suggestions-panel p-1 flex flex-col overflow-y-auto hover:scrollbar-thin scrollbar-thumb-base-300 scrollbar-track-transparent">
                    <button v-for="(cmd, idx) in commandSuggestions" :key="cmd.name"
                        @mousedown.prevent="confirmCommandSuggestion(cmd)" @mouseenter="commandSuggestionIndex = idx"
                        :title="cmd.description" :data-command-suggestion-active="idx === commandSuggestionIndex"
                        class="flex items-center gap-2 w-full overflow-hidden rounded-lg py-2 px-3 text-left transition-colors shrink-0"
                        :class="idx === commandSuggestionIndex ? 'bg-primary/10 text-primary' : 'hover:bg-base-content/10'">
                        <span
                            class="font-mono font-semibold text-sm whitespace-nowrap shrink-0 max-w-[9rem] overflow-hidden text-ellipsis">/{{
                                cmd.name }}</span>
                        <span v-if="cmd.description"
                            class="text-xs opacity-60 whitespace-nowrap overflow-hidden text-ellipsis flex-1 min-w-0">{{
                                cmd.description }}</span>
                        <span v-if="cmd.source" class="ml-auto badge badge-xs shrink-0"
                            :class="sourceBadge(cmd.source).cls">
                            {{ sourceBadge(cmd.source).label }}
                        </span>
                    </button>
                </div>
            </div>


            <textarea ref="textareaRef" v-model="inputText" rows="1"
                :placeholder="centered ? $t('chat.inputPlaceholderHome') : $t('chat.inputPlaceholder')"
                class="textarea textarea-ghost w-full resize-none focus:outline-none focus:bg-transparent text-base min-h-[44px] max-h-[200px] px-3 py-3 leading-6 placeholder:text-base-content/40 hide-scrollbar"
                @keydown="handleInputKeydown" @focus="handleInputFocus" @input="adjustHeight" @paste="handlePaste"
                :disabled="disabled"></textarea>

            <!-- Toolbar Bottom -->
            <div class="flex items-center justify-between pb-1">
                <!-- Left Actions -->
                <div class="flex items-center gap-1 text-base-content/70">
                    <!-- Attach -->
                    <input type="file" ref="fileInputRef" class="hidden" @change="handleFileChange" />
                    <button @click="triggerFileInput"
                        class="btn btn-ghost btn-circle btn-sm hover:bg-base-300 hover:text-primary transition-colors"
                        :title="$t('chat.uploadAttachment')">
                        <CameraIcon class="h-5 w-5" />
                    </button>

                    <!-- Command（新会话页居中卡片不显示；会话页保持原样） -->
                    <div v-if="!centered" class="dropdown dropdown-top hidden sm:block"
                        :class="{ 'dropdown-open': commandDropdownOpen }">
                        <button
                            @click.stop="commandDropdownOpen = !commandDropdownOpen; modelDropdownOpen = false; thinkingDropdownOpen = false; permDropdownOpen = false"
                            class="btn btn-ghost btn-sm  gap-1 font-normal rounded-full border border-base-content/20 hover:border-base-content/40 hover:bg-base-300  transition-all"
                            :title="$t('chat.commands')">
                            <CommandLineIcon class="h-4 w-4 hidden sm:inline" />
                            <span class="sm:inline">{{ $t('chat.commands') }}</span>
                            <ChevronUpIcon class="h-3 w-3 ml-0.5 opacity-50" />
                        </button>
                        <ul v-if="commandDropdownOpen"
                            class="dropdown-content menu p-2 shadow-xl bg-base-100 rounded-box w-56 border border-base-300 mb-2 z-[100]">
                            <li class="menu-title"><span>{{ $t('chat.commonCommands') }}</span></li>
                            <li v-for="cmd in COMMANDS" :key="cmd.value">
                                <a @click="handleCommandSelect(cmd)" class="rounded-lg">{{ cmd.label }}</a>
                            </li>
                            <!-- 本地指令：客户端命令注册表派生（/taskbar /tree），不经服务端 -->
                            <li v-if="clientCommandItems.length" class="menu-title">
                                <span>{{ $t('chat.clientCommands') }}</span>
                            </li>
                            <li v-for="cmd in clientCommandItems" :key="cmd.value">
                                <a @click="handleCommandSelect(cmd)" class="rounded-lg">{{ cmd.label }}</a>
                            </li>
                            <!-- Divider -->
                            <li class="my-1 border-t border-base-300"></li>
                            <!-- Auto Send Toggle -->
                            <li class="p-0">
                                <label
                                    class="label cursor-pointer justify-between py-2 px-4 hover:bg-base-content/10 rounded-lg active:bg-base-content/15 transition-colors">
                                    <span class="text-xs opacity-70 label-text">{{ $t('chat.autoSend') }}</span>
                                    <input type="checkbox" class="toggle toggle-xs toggle-primary"
                                        v-model="settingsStore.autoSendCommands" />
                                </label>
                            </li>
                        </ul>
                    </div>

                    <!-- Permission Mode（第四下拉：新会话页选创建期档位，既有会话即时切档；
                         permission-gate 未启用时整体隐藏） -->
                    <div v-if="permAvailable" class="dropdown dropdown-top"
                        :class="{ 'dropdown-open': permDropdownOpen }">
                        <button
                            @click.stop="permDropdownOpen = !permDropdownOpen; commandDropdownOpen = false; modelDropdownOpen = false; thinkingDropdownOpen = false"
                            class="btn btn-ghost btn-sm gap-1 font-normal rounded-full border border-base-content/20 hover:border-base-content/40 hover:bg-base-300 transition-all"
                            :title="$t('chat.permissionMode')">
                            <ShieldCheckIcon class="h-4 w-4 hidden sm:inline" />
                            <span class="sm:inline">{{ $t('chat.permissionMode') }}<span class="hidden sm:inline">({{ $t(`chat.permMode.${permissionMode}`) }})</span></span>
                            <ChevronUpIcon class="h-3 w-3 ml-0.5 opacity-50" />
                        </button>
                        <ul v-if="permDropdownOpen"
                            class="dropdown-content menu p-2 shadow-xl bg-base-100 rounded-box w-64 border border-base-300 mb-2 z-[100]">
                            <li class="menu-title"><span>{{ $t('chat.permissionMode') }}</span></li>
                            <li v-for="m in PERM_MODES" :key="m">
                                <a @click="selectPermissionMode(m)" class="flex flex-col items-start gap-0.5 rounded-lg py-1.5"
                                    :class="{ 'bg-primary/10 text-primary': permissionMode === m }">
                                    <span class="flex w-full items-center gap-2">
                                        <span class="flex-1 text-sm">{{ $t(`chat.permMode.${m}`) }}</span>
                                        <CheckIcon v-if="permissionMode === m" class="h-4 w-4 shrink-0" />
                                        <span v-else class="w-4 h-4 shrink-0"></span>
                                    </span>
                                    <span class="text-xs opacity-60">{{ $t(`chat.permMode.${m}Caption`) }}</span>
                                </a>
                            </li>
                        </ul>
                    </div>


                    <!-- Model -->
                    <div class="dropdown dropdown-top" :class="{ 'dropdown-open': modelDropdownOpen }">
                        <button
                            @click.stop="() => { modelDropdownOpen = !modelDropdownOpen; commandDropdownOpen = false; thinkingDropdownOpen = false; permDropdownOpen = false }"
                            class="btn btn-ghost btn-sm gap-1 font-normal rounded-full border border-base-content/20 hover:border-base-content/40 hover:bg-base-300 transition-all"
                            :title="$t('chat.models')">
                            <CpuChipIcon class="h-4 w-4 hidden sm:inline" />
                            <span class="sm:inline">{{ $t('chat.models') }}<span
                                    v-if="currentModelLabel" class="hidden sm:inline">({{ currentModelLabel }})</span></span>
                            <ChevronUpIcon class="h-3 w-3 ml-0.5 opacity-50" />
                        </button>
                        <div v-if="modelDropdownOpen"
                            class="dropdown-content shadow-xl bg-base-100 rounded-box border border-base-300 z-[100] max-h-96 overflow-hidden flex flex-col flex-nowrap fixed left-4 right-4 bottom-24 sm:absolute sm:left-0 sm:right-auto sm:bottom-[100%] sm:mb-2 sm:w-80">
                            <ModelSelectMenuContent :available-models="availableModels" :current-model="currentModel"
                                @select="handleModelSelect" />
                        </div>
                    </div>



                    <!-- Thinking Level -->
                    <div class="dropdown dropdown-top" :class="{ 'dropdown-open': thinkingDropdownOpen }">
                        <button
                            @click.stop="thinkingDropdownOpen = !thinkingDropdownOpen; commandDropdownOpen = false; modelDropdownOpen = false; permDropdownOpen = false"
                            class="btn btn-sm gap-1 font-normal rounded-full transition-all duration-300 border-primary/20 btn-ghost hover:bg-base-300"
                            :title="$t('chat.thinkingLevel')">
                            <LightBulbIcon class="h-4 w-4 hidden sm:inline" />
                            <span class="sm:inline">{{ $t('chat.thinking') }}<span class="hidden sm:inline">({{
                                getThinkingLabel()
                                    }})</span></span>
                            <ChevronUpIcon class="h-3 w-3 ml-0.5 opacity-50" />
                        </button>
                        <ul v-if="thinkingDropdownOpen"
                            class="dropdown-content menu p-2 shadow-xl bg-base-100 rounded-box w-36 border border-base-300 mb-2 z-[100]">
                            <li class="menu-title"><span>{{ $t('chat.thinkingLevel') }}</span></li>
                            <li v-for="level in supportedThinkingLevels" :key="level">
                                <a @click="selectThinkingLevel(level)" class="flex items-center gap-2 rounded-lg"
                                    :class="{ 'bg-primary/10 text-primary': thinkingLevel === level }">
                                    <span class="flex-1">{{ $t(`chat.thinkingLevels.${level}`) }}</span>
                                    <CheckIcon v-if="thinkingLevel === level" class="h-4 w-4 shrink-0" />
                                    <span v-else class="w-4 h-4 shrink-0"></span>
                                </a>
                            </li>
                        </ul>
                    </div>


                </div>

                <!-- Right Actions -->
                <div class="flex items-center gap-2">
                    <!-- Mic -->
                    <button v-if="settingsStore.isCurrentAsrConfigured" @click="handleMicClick"
                        class="btn btn-circle btn-sm transition-all duration-300 relative overflow-hidden"
                        :class="isRecording ? 'btn-success text-success-content scale-110 shadow-[0_0_15px_rgba(var(--sc),0.5)] border-success' : 'btn-ghost bg-base-300/50 hover:bg-base-300'"
                        :title="$t('chat.voiceInput')">
                        <MicrophoneIcon class="h-5 w-5 relative z-10" />
                        <span v-if="isRecording" class="absolute inset-0 bg-white/20 animate-ping rounded-full"></span>
                    </button>
                    <!-- Send / Stop / busy 双通道 -->
                    <!-- busy + 输入框有文字 + 非命令文本：显式双选——「插入」立即注入当前回复(steer) /
                         「排队」作为后续追问(follow-up)。主色跟随 busySendBehavior 设置；
                         小屏（<sm）退化为纯图标。发送键（Ctrl+Enter）不携带 mode，默认通道由设置决定。
                         命令文本（/xxx）走既有命令分支，mode 不被消费 → 回退下方原发送按钮 -->
                    <template v-if="isBusy && inputText.trim() && !busyCommandText">
                        <button @click="onSend('steer')"
                            class="btn btn-sm rounded-full gap-1 font-normal transition-all hover:scale-105 active:scale-95 w-8 p-0 sm:w-auto sm:px-3"
                            :class="busySteerEmphasized ? 'btn-warning shadow-md hover:shadow-lg' : 'btn-ghost border border-base-content/20 hover:border-base-content/40 hover:bg-base-300'"
                            :disabled="disabled" :title="$t('chat.busySend.steerTitle')" :aria-label="$t('chat.busySend.steerTitle')">
                            <BoltIcon class="h-4 w-4" />
                            <span class="hidden sm:inline">{{ $t('chat.busySend.steer') }}</span>
                        </button>
                        <button @click="onSend('follow')"
                            class="btn btn-sm rounded-full gap-1 font-normal transition-all hover:scale-105 active:scale-95 w-8 p-0 sm:w-auto sm:px-3"
                            :class="!busySteerEmphasized ? 'btn-primary shadow-md hover:shadow-lg' : 'btn-ghost border border-base-content/20 hover:border-base-content/40 hover:bg-base-300'"
                            :disabled="disabled" :title="$t('chat.busySend.followTitle')" :aria-label="$t('chat.busySend.followTitle')">
                            <InboxArrowDownIcon class="h-4 w-4" />
                            <span class="hidden sm:inline">{{ $t('chat.busySend.follow') }}</span>
                        </button>
                    </template>
                    <!-- idle 发送 / busy+空输入停止：保持原单按钮（v-else 分支） -->
                    <button v-else @click="onSend()"
                        class="btn btn-circle btn-sm btn-primary shadow-md hover:shadow-lg transition-all hover:scale-105 active:scale-95"
                        :disabled="disabled || ((!inputText.trim() && attachments.length === 0) && !isBusy)">
                        <StopIcon v-if="isBusy && !inputText.trim()" class="h-5 w-5" />
                        <PaperAirplaneIcon v-else class="h-5 w-5 -rotate-45 translate-x-0.5 translate-y-px" />
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.hide-scrollbar::-webkit-scrollbar {
    display: none;
}

.hide-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
}

textarea:focus,
input:focus {
    box-shadow: none;
}
</style>
