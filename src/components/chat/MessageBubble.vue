<script setup lang="ts">
import {
    ClipboardIcon,
    SpeakerWaveIcon,
    StopIcon,
    ArrowPathIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    PencilSquareIcon,
    EyeIcon,
    ChevronDownIcon,
    CheckCircleIcon,
    ExclamationCircleIcon,
    MusicalNoteIcon,
    VideoCameraIcon,
    PlayIcon,
    PauseIcon
} from '@heroicons/vue/24/outline'
import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import { useUiSettingsStore } from '../../stores/setting'
import { useMediaPreview } from '../../composables/useMediaPreview'
import { useI18n } from 'vue-i18n'
import MarkdownRenderer from './MarkdownRenderer.vue'
import ToolInvocation from './ToolInvocation.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import DeliverablesPanel from './DeliverablesPanel.vue'
import { A2UIRenderer } from '../a2ui'
import { handleA2UIAction } from '../../composables/useA2UIActions'
import { reservedImageStyle, recordImageElementDimensions } from '../../utils/imageDimensions'
import { pauseOtherChatMedia } from '../../utils/chat-media'
import { getSurface } from '../../composables/useA2UISurfaces'
import { useChatState } from '../../composables/useChatState'
import { useTTS } from '../../composables/useTTS'
import { useBackgroundAgents } from '../../composables/useBackgroundAgents'
import { useSubagentTrace } from '../../composables/useSubagentTrace'
import { computeBlockKeys } from '../../utils/blockKeys'
import type { DisplayMessage } from '../../composables/useChatMessages'
import { useMediaQuery } from '@vueuse/core'

export interface BranchInfo {
    siblings: string[]
    currentIndex: number
}

const props = defineProps<{
    message: DisplayMessage
    isLoading?: boolean
    isBusy?: boolean
    branchInfo?: BranchInfo | null
    /** 是否是最后一条消息，只有最后一条消息的 A2UI Surface 才允许交互 */
    isLastMessage?: boolean
    /** 分支尾锚：紧随其后的显示项不是本回合 assistant 回复（VirtualMessageList 计算）。
     *  user 气泡的分支导航门控：仅分支尾部的 user 消息需要承担导航锚点（尾部无已渲染
     *  回复或分支被续写后分叉点不再是末项），避免与 assistant 气泡的导航重复渲染 n/n */
    isBranchTail?: boolean
    /** 跳转定位闪光：rail/树跳转落到本气泡时短暂高亮（HomeView 定时清除） */
    flash?: boolean
    /** 覆盖助手显示名（子代理轨迹抽屉传子代理名）；不传用当前 agent 名 */
    agentName?: string
}>()

const emit = defineEmits<{
    (e: 'copy', msg: DisplayMessage): void
    (e: 'read-aloud', msg: DisplayMessage): void
    (e: 'retry', msg: DisplayMessage): void
    (e: 'fork', msg: DisplayMessage): void
    (e: 'edit', msg: DisplayMessage, newText: string): void
    (e: 'navigate-branch', msg: DisplayMessage, direction: 'prev' | 'next'): void
}>()
const { t } = useI18n()

// 后台子代理报告气泡 → 轨迹抽屉（与前台 ToolInvocation 卡同一 SubagentTraceDrawer）：
// 按报告署名从注册表现查 conversationId（当前分支 doc；查不到则不显示按钮——
// 历史分支的报告无当前分支寻址键，隐藏比错开更诚实）
const bgAgents = useBackgroundAgents()
const traceViewer = useSubagentTrace()
const openReportTrace = (name: string): void => {
    const chatState = useChatState()
    const key = chatState.sessionKey
    const agent = bgAgents.agents.value.find((a) => a.name === name)
    if (!key || !agent) return
    traceViewer.open(key, [{
        subagentSessionId: agent.conversationId,
        agent: agent.subagentId,
        ...(agent.task !== undefined ? { task: agent.task } : {}),
        status: agent.status,
    }], agent.conversationId)
}
const reportTraceTarget = (name: string): string | undefined =>
    bgAgents.agents.value.find((a) => a.name === name)?.conversationId
// 报告答案折叠态（对位 ToolInvocation 卡：头部点击开合，收起时答案零挂载）。
// 回执气泡唯一块（useChatMessages 单块成泡，continue 分支不并块），每气泡一份状态即可；
// 若未来报告并入多块消息，此 ref 需按块索引拆分
const reportOpen = ref(false)
const toggleReportOpen = (): void => { reportOpen.value = !reportOpen.value }
const uiSettings = useUiSettingsStore()
// chat-bubble 是 daisyUI 的亮色风格气泡，深色模式下不加，避免灰阶大卡片观感
const hiddenAssistantBubbleBg = computed(() => uiSettings.isDark || useMediaQuery('(max-width: 1023px)').value || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
const chatState = useChatState()
const { currentReadingMsgId } = useTTS()

// ── 音乐回执卡：原地播放/暂停（audio 长在卡内，不跳浏览器）──
// 虚拟滚动保活：VirtualMessageList 对含 !paused 媒体的行保持挂载（离屏不卸载，
// 滚动回来同一元素，进度/播放态原样保留）——通用 audio/video 检测自动覆盖。
// 全局单播：play 时经 chat-media 单点暂停其他聊天媒体（markdown 内嵌 + 其他音乐卡）。
const musicAudioEl = ref<HTMLAudioElement | null>(null)
// ref 必须用函数形式：块在 v-for 内，字符串 ref 会被 Vue 收集成数组
// （ref_for: true → setupState[ref] = [el]），el.paused undefined / el.pause()
// TypeError——点击无声。函数 ref 直接拿到元素本身（卸载时 null）
const assignMusicAudioEl = (el: Element | ComponentPublicInstance | null) => {
    musicAudioEl.value = el instanceof HTMLAudioElement ? el : null
}
const musicPlaying = ref(false)
const toggleMusicAudio = () => {
    const el = musicAudioEl.value
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
}
const onMusicPlay = () => {
    if (musicAudioEl.value) pauseOtherChatMedia(musicAudioEl.value)
    musicPlaying.value = true
}
// 音乐回执折叠态（对位工具卡/subagent-report 卡：头部点击开合，收起时正文零挂载）。
// audio 留在头部不进正文——折叠卸载不打断播放，虚拟滚动保活照常生效
const musicOpen = ref(false)
const toggleMusicOpen = (): void => { musicOpen.value = !musicOpen.value }

// ── 视频回执卡：卡内常驻 <video>（原生 controls）——折叠只卸载下方正文，播放不中断 ──
// 虚拟滚动保活：VirtualMessageList 对含 !paused 媒体的行保持挂载（通用 audio/video
// 检测自动覆盖）。全局单播：play 时经 chat-media 单点暂停其他聊天媒体（markdown
// 内嵌 + 其他音乐/视频卡）。
const onVideoReportPlay = (event: Event) => {
    const el = event.target
    if (el instanceof HTMLVideoElement) pauseOtherChatMedia(el)
}
// 视频回执折叠态（对位音乐卡：头部点击开合，收起时正文零挂载；<video> 在卡内
// 常驻不受折叠影响）
const videoOpen = ref(false)
const toggleVideoOpen = (): void => { videoOpen.value = !videoOpen.value }

// A2UI action handling
function onA2UIAction(action: any, dataModel: Record<string, any>, surfaceId: string, sourceComponentId: string) {
    handleA2UIAction(action, dataModel, surfaceId, sourceComponentId)
}

// A2UI Action Block 友好展示：把原始 action.name + payload 提炼为人类可读的标签与作答摘要。
// 选项作答取 context.label/value；自定义作答兜底 payload 顶层或 surface 数据模型内的 customAnswer。
function formatA2UIAction(block: any): { label: string; summary: string } {
    const name = block.a2uiEventName || ''
    const payload = block.a2uiPayload || {}
    const context = payload.action?.context || {}
    const surfaceId = payload.action?.surfaceId
    const dataModel = surfaceId ? payload.a2uiClientDataModel?.surfaces?.[surfaceId] : undefined

    const labels: Record<string, string> = {
        'question.submit': t('chat.a2uiActionQuestion'),
        'questionnaire.submit': t('chat.a2uiActionQuestionnaire'),
    }
    const label = labels[name] || t('chat.a2uiAction')

    // 选项作答
    if (typeof context.label === 'string' && context.label.trim()) {
        return { label, summary: `${t('chat.a2uiActionAnswerChoice')}：${context.label.trim()}` }
    }
    if (typeof context.value === 'string' && context.value.trim()) {
        return { label, summary: `${t('chat.a2uiActionAnswerChoice')}：${context.value.trim()}` }
    }
    // 自定义作答：v1.0 事件在 context.customAnswer；旧快照形态在 payload 顶层或 surface 数据模型
    const custom = typeof context.customAnswer === 'string' ? context.customAnswer
        : typeof payload.customAnswer === 'string' ? payload.customAnswer
        : typeof dataModel?.customAnswer === 'string' ? dataModel.customAnswer : ''
    if (custom.trim()) {
        return { label, summary: `${t('chat.a2uiActionAnswerCustom')}：${custom.trim()}` }
    }
    return { label, summary: '' }
}

// Edit state
const isEditing = ref(false)
const editText = ref('')
const editTextareaRef = ref<HTMLTextAreaElement | null>(null)

/**
 * 编辑框自适应高度（对齐 ChatInput.adjustHeight 模式）：按内容撑高，超 60vh
 * 内部滚动。长消息进入编辑后行高≈原内容高度，避免行高从几千像素塌缩到
 * 4 行输入框——下方内容整体上移涌入视口、scrollHeight 骤降触发浏览器钳制，
 * 虚拟列表高度缓存也随之骤变（图片加载场景的同类问题见 utils/imageDimensions.ts）。
 * 「≈」是量级近似：纯文本成立；原内容 h-0 折叠使图片/文件卡/markdown 排版
 * 差成为残余 delta（编辑态接受，有界），仅衰减而非根除塌缩链。
 */
const adjustEditTextareaHeight = () => {
    const el = editTextareaRef.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
}

const startEdit = async () => {
    // Extract text from user message blocks
    const text = (props.message.blocks || [])
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n')
    editText.value = text
    isEditing.value = true
    // 编辑框可见性：长消息只露下半截时点行底的编辑按钮，塌缩后行顶（textarea
    // 所在处）可能已在视口上方之外——用户触发了编辑却看不到编辑框。撑高后把
    // 编辑框滚回视口；focus 的 preventScroll 关掉默认滚动行为，滚动交给显式
    // 的 nearest（尽量少动视口）
    await nextTick()
    adjustEditTextareaHeight()
    editTextareaRef.value?.focus({ preventScroll: true })
    editTextareaRef.value?.scrollIntoView({ block: 'nearest' })
}

const cancelEdit = () => {
    isEditing.value = false
    editText.value = ''
}

const submitEdit = () => {
    const newText = editText.value.trim()
    if (!newText) return
    isEditing.value = false
    emit('edit', props.message, newText)
}

// Helper functions
const formatTime = (timestamp?: number): string => {
    if (!timestamp) return ''
    const date = new Date(timestamp)
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

const isAvatarUrl = (avatar: string | null | undefined): boolean => {
    if (!avatar) return false
    return avatar.startsWith('http') || avatar.startsWith('data:') || avatar.startsWith('/')
}

const getImageSrc = (source: any): string => {
    if (!source) return ''
    if (source.url) return source.url
    if (source.type === 'url' && source.data) return source.data
    const data = source.data || ''
    if (data.startsWith('data:') || data.startsWith('http')) return data
    if (data) return `data:${source.media_type || 'image/png'};base64,${data}`
    return ''
}

// 当前 Agent 信息直接从 chatState 获取，无需额外 watch 和查询
/** 图片首次加载完成时记录自然尺寸（尺寸缓存），供后续渲染 aspect-ratio 预留空间
 *  （虚拟列表行重挂载时 <img> 全新 DOM，不预留会从 0 高度重新长高，行高跳变） */
const onBubbleImageLoad = (e: Event) => {
    const img = e.target as HTMLImageElement
    if (!img?.naturalWidth) return
    recordImageElementDimensions(img)
    // 同 src 被复用但内容重生成（自然尺寸变化）：用新比率即时修正 inline 预留
    //（:style 绑定无渲染不会重求值，变形会一直持续到下次重渲染）
    const fresh = reservedImageStyle(img.currentSrc || img.src)
    img.style.aspectRatio = fresh ? fresh.aspectRatio : ''
}

const currentAgent = computed(() => chatState.currentAgent)
const assistantName = computed(() => props.agentName || currentAgent.value?.name || 'Assistant')
const assistantAvatar = computed(() => {
    const avatar = currentAgent.value?.avatar
    return isAvatarUrl(avatar) ? avatar : null
})

// Parse user message blocks to extract file content and fix image data paths
const userParsedBlocks = computed(() => {
    if (props.message.role !== 'user') return props.message.blocks || []
    if (!props.message.blocks) return []

    const result = [] as any[]

    for (const block of props.message.blocks) {
        // Handle text blocks - extract file content markers
        if (block.type === 'text' && block.text) {

            // Pattern: === File Content: filename === content ==============================
            const fileRegex = /=== File Content: (.*?) ===([\s\S]*?)==============================/g
            let lastIndex = 0
            let match
            let hasMatch = false

            while ((match = fileRegex.exec(block.text)) !== null) {
                hasMatch = true
                // Add text before the match
                if (match.index > lastIndex) {
                    const text = block.text.slice(lastIndex, match.index).trim()
                    if (text) {
                        result.push({ type: 'text', text })
                    }
                }

                // Add the file block
                result.push({
                    type: 'file',
                    fileName: match[1].trim() || 'File',
                    fileContent: match[2].trim()
                })

                lastIndex = match.index + match[0].length
            }

            if (hasMatch) {
                // Add remaining text after last match
                if (lastIndex < block.text.length) {
                    const text = block.text.slice(lastIndex).trim()
                    if (text) {
                        result.push({ type: 'text', text })
                    }
                }
            } else {
                // No file content found, keep original block
                result.push(block)
            }
        }
        // Handle image blocks - build full URL or data URI
        else if (block.type === 'image') {
            result.push({
                type: 'image',
                src: getImageSrc(block.source)
            })
        }
        else {
            result.push(block)
        }
    }

    return result
})

const userImages = computed(() => {
    return userParsedBlocks.value.filter(b => b.type === 'image')
})

const userFiles = computed(() => {
    return userParsedBlocks.value.filter(b => b.type === 'file')
})

// 助手侧显示块：DisplayBlock + gallery 分组产物（连续 image 合并，不在 DisplayBlock 联合内）
type AssistantDisplayBlock = DisplayMessage['blocks'][number] | { type: 'image_gallery', images: DisplayMessage['blocks'][number][] }

// Parse assistant message blocks to group consecutive images
const assistantParsedBlocks = computed<AssistantDisplayBlock[]>(() => {
    if (props.message.role === 'user') return []
    const blocks = props.message.blocks || []
    const result: AssistantDisplayBlock[] = []
    let currentGallery: { type: 'image_gallery', images: DisplayMessage['blocks'][number][] } | null = null

    for (const block of blocks) {
        if (block.type === 'image') {
            if (!currentGallery) {
                currentGallery = { type: 'image_gallery', images: [] }
                result.push(currentGallery)
            }
            currentGallery.images.push(block)
        } else {
            currentGallery = null
            result.push(block)
        }
    }
    return result
})

const { openLightbox, openFileViewer, downloadImage } = useMediaPreview()

// 助手侧块稳定键：流式期间 blocks 每帧重建（新对象引用），索引键在中段插入块时
// 会平移导致状态子组件（ThinkingBlock 展开/ToolInvocation 开合）丢失状态，
// 故用纯数据推导的稳定键（详见 utils/blockKeys.ts）。computed 缓存，仅 blocks 变化时重算。
const assistantBlockKeys = computed(() => computeBlockKeys(assistantParsedBlocks.value))
</script>

<template>
    <div class="chat group" :class="[message.role === 'user' ? 'chat-end' : 'chat-start', { 'bubble-flash': flash }]">
        <!-- Avatar -->
        <div class="chat-image avatar hidden md:block">
            <div class="w-10 rounded-full bg-base-300 flex items-center justify-center overflow-hidden">
                <template v-if="message.role === 'user'">
                    <span class="text-lg">👤</span>
                </template>
                <template v-else>
                    <img v-if="isAvatarUrl(assistantAvatar)" :src="assistantAvatar || undefined"
                        class="w-full h-full object-cover" />
                    <span v-else-if="assistantAvatar" class="text-lg">{{ assistantAvatar }}</span>
                    <span v-else class="text-lg">🤖</span>
                </template>
            </div>
        </div>
        <!-- Header -->
        <div class="chat-header opacity-70 text-xs mb-1">
            {{ message.role === 'user' ? $t('chat.you') : assistantName }}
            <!-- steer / follow-up 排队中徽标：回显命中后随气泡转正一起消失 -->
            <span v-if="message.pending"
                class="badge badge-ghost badge-xs ml-1 py-2 font-normal text-base-content/60 border-dashed border-base-content/20">
                {{ message.pending === 'follow' ? $t('chat.pendingQueue.followBadge') : $t('chat.pendingQueue.steerBadge') }}
            </span>
            <time v-if="message.timestamp" class="ml-1">{{ formatTime(message.timestamp) }}</time>
        </div>

        <!-- User Message Bubble -->
        <!-- pending（排队中）气泡：半透明标识未落盘状态，转正后恢复 -->
        <div v-if="message.role === 'user'"
            class="max-w-full md:max-w-[90%] chat-bubble bg-primary/10 text-base-content relative transition-opacity duration-200 px-2"
            :class="message.pending ? 'opacity-70' : ''">
            <div class="whitespace-normal flex flex-col gap-2  ">
                <!-- Edit mode: textarea shown above invisible original content。
                     data-editing 是虚拟列表编辑态保活的检测标记（见 VirtualMessageList
                     保活循环）：行离屏时保持挂载，滚回来编辑中的文本原样保留；
                     提交/取消后随 v-if 卸载，标记消失，下次滚动更新自然回收 -->
                <textarea v-if="isEditing" ref="editTextareaRef" v-model="editText" rows="1" data-editing
                    class="textarea textarea-bordered w-full bg-base-200 text-base-content text-sm resize-none min-h-[80px] max-h-[60vh] overflow-y-auto"
                    @input="adjustEditTextareaHeight" @keydown.ctrl.enter="submitEdit" />
                <!-- Original content: visible normally, invisible (but still in layout) when editing to preserve width -->
                <div :class="{ 'invisible h-0 overflow-hidden': isEditing }">
                    <!-- Text blocks first -->
                    <template v-for="(block, bIndex) in userParsedBlocks" :key="'text-' + bIndex">
                        <MarkdownRenderer v-if="block.type === 'text'" :content="block.text || ''" />

                        <!-- A2UI Action Block（用户对交互面板的操作记录） -->
                        <div v-else-if="block.type === 'a2ui-action'" class="my-1 min-w-[240px] max-w-sm">
                            <div
                                class="collapse collapse-arrow border border-base-content/10 bg-base-200/50 backdrop-blur-sm shadow-sm rounded-lg">
                                <input type="checkbox" />
                                <div class="collapse-title p-2 min-h-0 flex items-center gap-2">
                                    <span class="text-lg opacity-80">⚡</span>
                                    <div class="flex flex-col flex-1 min-w-0 pr-2 gap-0.5">
                                        <span class="text-sm font-medium text-base-content/90 truncate">{{
                                            formatA2UIAction(block).label }}</span>
                                        <span v-if="formatA2UIAction(block).summary"
                                            class="text-xs text-base-content/60 truncate">{{
                                            formatA2UIAction(block).summary }}</span>
                                    </div>
                                </div>
                                <div class="collapse-content p-0 pb-2 px-3 cursor-text">
                                    <div
                                        class="text-[10px] font-semibold text-base-content/40 uppercase tracking-wider mb-1 mt-1">
                                        {{ $t('chat.a2uiActionRaw') }}</div>
                                    <pre
                                        class="text-[11px] leading-tight bg-base-300/50 p-2 rounded overflow-x-auto text-base-content/60 whitespace-pre-wrap max-h-60 overflow-y-auto">{{ JSON.stringify(block.a2uiPayload, null, 2) }}</pre>
                                </div>
                            </div>
                        </div>
                    </template>

                    <!-- File attachments section -->
                    <div v-if="userFiles.length > 0" class="flex flex-wrap gap-2 mt-1">
                        <template v-for="(block, bIndex) in userFiles" :key="'file-' + bIndex">
                            <div @click="openFileViewer(block.fileName, block.fileContent)"
                                class="attachment-card group/att flex items-center gap-2 px-3 py-2 rounded-lg border border-base-content/30 bg-white/10 cursor-pointer hover:border-base-content/50 hover:bg-white/20 transition-all duration-200">
                                <div class="w-8 h-8 rounded bg-white/20 flex items-center justify-center flex-shrink-0">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
                                        stroke-width="1.5" stroke="currentColor" class="w-5 h-5 opacity-80">
                                        <path stroke-linecap="round" stroke-linejoin="round"
                                            d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                                    </svg>
                                </div>
                                <div class="flex-1 min-w-0 max-w-[120px]">
                                    <div class="text-xs font-medium truncate" :title="block.fileName">{{ block.fileName
                                        }}
                                    </div>
                                    <div class="text-xs opacity-60">{{ $t('common.clickToView') }}</div>
                                </div>
                            </div>
                        </template>
                    </div>

                    <!-- Image attachments section -->
                    <div v-if="userImages.length > 0" class="grid gap-2 mt-1 w-fit" :class="{
                        'grid-cols-1': userImages.length === 1,
                        'grid-cols-2 max-w-[240px] sm:max-w-[320px]': userImages.length === 2 || userImages.length === 4,
                        'grid-cols-3 max-w-[360px] sm:max-w-[480px]': userImages.length === 3 || userImages.length > 4
                    }">
                        <div v-for="(imgBlock, bIndex) in userImages" :key="'img-' + bIndex"
                            @click="openLightbox(imgBlock.src)"
                            class="attachment-card group/att relative rounded-lg overflow-hidden border border-white/20 bg-black/20 cursor-pointer hover:border-white/40 transition-all duration-200"
                            :class="userImages.length > 1 ? 'aspect-square' : ''">
                            <img :src="imgBlock.src" class="w-full h-full"
                                :class="userImages.length === 1 ? 'max-w-full max-h-[300px] object-contain bg-white/10 flex-none' : 'object-cover'"
                                :style="reservedImageStyle(imgBlock.src)" @load="onBubbleImageLoad" />
                            <!-- Hover overlay -->
                            <div
                                class="absolute inset-0 bg-black/0 group-hover/att:bg-black/20 transition-all duration-200 flex items-center justify-center pointer-events-none">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2"
                                    stroke="currentColor"
                                    class="w-6 h-6 text-white opacity-0 group-hover/att:opacity-100 transition-opacity duration-200">
                                    <path stroke-linecap="round" stroke-linejoin="round"
                                        d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6" />
                                </svg>
                            </div>
                            <!-- Download Button -->
                            <button @click.stop="downloadImage(imgBlock.src)"
                                class="absolute top-2 right-2 p-1.5 rounded-full bg-black/40 text-white backdrop-blur-sm border border-white/20 hover:bg-black/60 md:opacity-0 group-hover/att:opacity-100 transition-opacity z-10"
                                :title="$t('chat.downloadImage')">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2"
                                    stroke="currentColor" class="w-4 h-4">
                                    <path stroke-linecap="round" stroke-linejoin="round"
                                        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <!-- User Actions (Hover) -->
        <div v-if="message.role === 'user'"
            class="chat-footer  transition-all duration-200 mt-1 flex items-center gap-1">
            <!-- Edit mode: show cancel & update -->
            <template v-if="isEditing">
                <button @click="cancelEdit" class="btn btn-ghost btn-sm text-base-content/60">
                    {{ $t('common.cancel') }}
                </button>
                <button @click="submitEdit" :disabled="!editText.trim()" class="btn btn-sm btn-primary">
                    {{ $t('chat.editUpdate') }}
                </button>
            </template>
            <!-- Normal mode: show action buttons -->
            <template v-else>
                <button @click="emit('copy', message)"
                    class="btn btn-ghost btn-sm btn-circle text-base-content/60 hover:text-primary hover:bg-base-300"
                    :title="$t('common.copy')">
                    <ClipboardIcon class="h-4 w-4" />
                </button>
                <button v-if="!isBusy && message.entryId" @click="startEdit"
                    class="btn btn-ghost btn-sm btn-circle text-base-content/60 hover:text-info hover:bg-info/10"
                    :title="$t('common.edit')">
                    <PencilSquareIcon class="h-4 w-4" />
                </button>
                <button v-if="!isLoading && message.entryId" @click="emit('fork', message)"
                    :disabled="chatState.isForkingEntry(message.lastEntryId ?? message.entryId)"
                    class="btn btn-ghost btn-sm btn-circle text-base-content/60 hover:text-secondary hover:bg-secondary/10 disabled:opacity-40 disabled:cursor-not-allowed"
                    :title="$t('chat.fork')">
                    <span v-if="chatState.isForkingEntry(message.lastEntryId ?? message.entryId)" class="loading loading-spinner h-4 w-4"></span>
                    <!-- git-fork 图标（heroicons 无对应图标，用 lucide git-fork 路径内联） -->
                    <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
                        <circle cx="12" cy="18" r="3" />
                        <circle cx="6" cy="6" r="3" />
                        <circle cx="18" cy="6" r="3" />
                        <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                        <path d="M12 12v3" />
                    </svg>
                </button>
                <button v-if="!isBusy && message.entryId" @click="emit('retry', message)"
                    class="btn btn-ghost btn-sm btn-circle text-base-content/60 hover:text-warning hover:bg-warning/10"
                    :title="$t('chat.retry')">
                    <ArrowPathIcon class="h-4 w-4" />
                </button>

                <!-- Branch Navigation（user 气泡锚点）：分支尾部没有已渲染 assistant 回复时
                     （停止产生的空 aborted 回复按设计零渲染、回复被删光），及分支被续写后
                     分叉点 user 消息不再是最末项时，user 消息是该分支唯一必现的导航锚点；
                     缺了这里，切到该分支（第一页）后无任何导航/操作，成为死胡同。
                     isBranchTail 门控避免与同回合 assistant 气泡的导航重复渲染同一个 n/n；
                     !isBusy 与 assistant 侧一致：run 期间两侧导航整体不渲染 -->
                <div v-if="!isBusy && isBranchTail && branchInfo && branchInfo.siblings.length > 1" class="flex items-center gap-0.5 ml-1">
                    <button @click="emit('navigate-branch', message, 'prev')"
                        class="btn btn-ghost btn-xs btn-circle text-base-content/60 hover:text-primary hover:bg-base-300">
                        <ChevronLeftIcon class="h-3.5 w-3.5" />
                    </button>
                    <span class="text-xs text-base-content/50 min-w-[2rem] text-center select-none">
                        {{ branchInfo.currentIndex + 1 }}/{{ branchInfo.siblings.length }}
                    </span>
                    <button @click="emit('navigate-branch', message, 'next')"
                        class="btn btn-ghost btn-xs btn-circle text-base-content/60 hover:text-primary hover:bg-base-300">
                        <ChevronRightIcon class="h-3.5 w-3.5" />
                    </button>
                </div>
            </template>
        </div>

        <!-- Assistant Message Bubble -->
        <!-- 极简风：AI 气泡用 primary(白)5% tint——比页面背景微亮一档的软气泡，
             避免用 chat-bubble 默认的 base-300 底色(亮灰大卡片，与内部思考块/工具行叠灰阶补丁)。
             用户消息 10% tint、AI 5%，主次分明；尾巴(::before)随 background-color:inherit 同色 -->
        <div v-else class="max-w-full md:max-w-[90%] w-full relative chat-bubble" :class="hiddenAssistantBubbleBg ? 'pt-2 px-0 bg-transparent':' px-2'">
            <div class="whitespace-normal flex flex-col gap-2 ">
                <!-- Loading indicator if empty or just waiting -->
                <div v-if="isLoading && (!message.blocks.length || (message.blocks.length === 1 && message.blocks[0].type === 'text' && !message.blocks[0].text))"
                    class="loading loading-dots loading-sm opacity-50 "></div>
                <template v-else v-for="(block, bIndex) in assistantParsedBlocks" :key="assistantBlockKeys[bIndex]">
                    <MarkdownRenderer v-if="block.type === 'text'" :content="block.text || ``" />
                    <ToolInvocation v-else-if="block.type === 'tool'" :toolName="block.toolName || 'Unknown Tool'"
                        :args="block.toolArgs || {}" :result="block.toolResult" :state="block.toolState"
                        :errorMessage="block.toolError" :details="block.toolDetails" />
                    <!-- A2UI 组件渲染 -->
                    <!-- a2uiSurfaceId 非空由 v-else-if 守卫保证，但守卫收窄无法穿透进事件闭包，需非空断言 -->
                    <A2UIRenderer v-else-if="block.type === 'a2ui' && block.a2uiComponents && block.a2uiSurfaceId"
                        :components="block.a2uiComponents"
                        :data-model="getSurface(block.a2uiSurfaceId)?.dataModel || {}" :root-ids="block.a2uiRootIds"
                        :disabled="!isLastMessage" class="my-2"
                        @action="(action: any, dm: any, sourceId: string) => onA2UIAction(action, dm, block.a2uiSurfaceId!, sourceId)" />
                    <!-- A2UI 加载中（流式接收，标签未闭合） -->
                    <div v-else-if="block.type === 'a2ui_loading'" class="my-2">
                        <div class="collapse collapse-arrow border border-base-300 bg-base-100 rounded-box">
                            <input type="checkbox" />
                            <div class="collapse-title text-sm font-medium opacity-70 flex items-center gap-2">
                                <span class="loading loading-spinner loading-xs"></span>
                                {{ $t('chat.a2ui_loading') }}
                            </div>
                            <div class="collapse-content">
                                <div
                                    class="opacity-50 text-xs font-mono border-t border-base-300 pt-2 mt-2 whitespace-pre-wrap break-all max-h-40 overflow-auto">
                                    {{ block.text }}</div>
                            </div>
                        </div>
                    </div>
                    <template v-else-if="block.type === 'image_gallery'">
                    <!-- 内层 v-if 是 vue-tsc 类型收窄需要的显式守卫（可选链表达 images 可能不存在，
                         但进入此分支时必为 gallery 形状）；直接用 block.images 会报 TS2339 -->
                    <div v-if="'images' in block" class="grid gap-2 my-1 w-fit" :class="{
                        'grid-cols-1': block.images.length === 1,
                        'grid-cols-2 max-w-[240px] sm:max-w-[320px]': block.images.length === 2 || block.images.length === 4,
                        'grid-cols-3 max-w-[360px] sm:max-w-[480px]': block.images.length === 3 || block.images.length > 4
                    }">
                        <div v-for="(imgBlock, i) in block.images" :key="i"
                            class="rounded-lg overflow-hidden border border-base-300 cursor-pointer relative group/att"
                            :class="block.images.length > 1 ? 'aspect-square' : ''"
                            @click="openLightbox(getImageSrc(imgBlock.source))">
                            <img :src="getImageSrc(imgBlock.source)" class="w-full h-full"
                                :class="block.images.length === 1 ? 'max-w-full max-h-[300px] object-contain flex-none' : 'object-cover'"
                                :style="reservedImageStyle(getImageSrc(imgBlock.source))" @load="onBubbleImageLoad" />
                            <div
                                class="absolute inset-0 bg-base-content/0 group-hover/att:bg-base-content/10 transition-all duration-200 flex items-center justify-center pointer-events-none">
                            </div>
                            <!-- Download Button -->
                            <button @click.stop="downloadImage(getImageSrc(imgBlock.source))"
                                class="absolute top-2 right-2 p-1.5 rounded-full bg-black/40 text-white backdrop-blur-sm border border-white/20 hover:bg-black/60 md:opacity-0 group-hover/att:opacity-100 transition-opacity z-10"
                                :title="$t('chat.downloadImage')">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2"
                                    stroke="currentColor" class="w-4 h-4">
                                    <path stroke-linecap="round" stroke-linejoin="round"
                                        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                                </svg>
                            </button>
                        </div>
                    </div>
                    </template>
                    <!-- 思考块：默认折叠且内容零挂载；streaming（delta 正落在该块上）展开走纯文本直播。
                         数据驱动判定（流内活跃块标记），不依赖「是否最后一个块」位置启发——
                         交错推理/合并气泡 + 排队消息场景下位置启发会误判，增长中的思考被
                         错误送进 markdown 全量重渲热路径 -->
                    <ThinkingBlock v-else-if="block.type === 'thinking'"
                        :text="block.text || ''"
                        :streaming="block.streaming === true"
                        :active="block.active === true" />
                    <!-- 瞬态压缩行（伪消息唯一块）：compaction_start → end 窗口内存在，
                         随窗口消失零痕迹 -->
                    <div v-else-if="block.type === 'compacting'" class="flex items-center gap-2 text-sm opacity-70 select-none py-1">
                        <span class="loading loading-dots loading-sm opacity-60"></span>
                        <span>{{ $t('chat.contextCompacting') }}</span>
                    </div>
                    <!-- 本轮产出物清单（deliverables 回执气泡唯一块）：分组文件列表，
                         点击开 diff（repo/mode/ref 服务端已解析）/ 直接看文件 -->
                    <DeliverablesPanel v-else-if="block.type === 'deliverables' && block.deliverableFiles"
                        :files="block.deliverableFiles" :summary="block.deliverableSummary!" />
                    <!-- 后台子代理回传报告（[bg-subagent-report] user 输入的回执气泡唯一块）：
                         agent 徽标 + 状态 + 可折叠答案（默认收起）。卡片结构/头高/内边距
                         对位 ToolInvocation 卡（card bg-base-200 + px-3 py-2 头部 +
                         px-3 py-2 pt-0 正文），不再用独立 subagent-report-card 样式 -->
                    <div v-else-if="block.type === 'subagent-report'" class="card bg-base-200 overflow-hidden">
                        <div class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-sm"
                            @click="block.text && toggleReportOpen()">
                            <!-- 状态图标：对位工具卡（error 叉圆 / success 勾圆，w-5 直出无底圈） -->
                            <div class="flex-none">
                                <ExclamationCircleIcon v-if="block.subagentStatus === 'error'" class="w-5 h-5 text-error" />
                                <CheckCircleIcon v-else class="w-5 h-5 text-success" />
                            </div>
                            <div class="flex-1 min-w-0 break-words font-medium text-base-content/80 flex items-center gap-2 flex-wrap">
                                <span>{{ $t('chat.subagentReport.title') }}</span>
                                <span class="badge badge-sm badge-ghost font-mono">{{ block.subagentName }}</span>
                                <span v-if="block.subagentStatus === 'error'" class="badge badge-sm badge-error badge-outline">{{ $t('chat.subagentReport.error') }}</span>
                                <span v-else class="badge badge-sm badge-success badge-outline">{{ $t('chat.subagentReport.completed') }}</span>
                            </div>
                            <!-- 轨迹入口：按名查到当前分支注册表条目才显示（与前台子代理卡同一抽屉）；
                                 .stop 防止触发头部开合 -->
                            <button v-if="reportTraceTarget(block.subagentName!)" @click.stop="openReportTrace(block.subagentName!)"
                                class="btn btn-ghost btn-xs btn-circle shrink-0" :title="$t('subagentTrace.viewAgentTrace', { agent: block.subagentName })">
                                <EyeIcon class="h-3.5 w-3.5" />
                            </button>
                            <!-- 开合指示（对位工具卡 chevron）：标题区 flex-1 占满后自然贴右 -->
                            <div class="flex-none text-base-content/50">
                                <ChevronDownIcon v-if="reportOpen" class="w-4 h-4" />
                                <ChevronRightIcon v-else class="w-4 h-4" />
                            </div>
                        </div>
                        <!-- 答案正文：收起时零挂载（与工具卡/思考块同策略，虚拟滚动省渲染）；
                             正文为空（报告 body 可为空串）时头部点击不触发无效果开合；
                             内边距对位工具卡 body（px-3 py-2 pt-0） -->
                        <div v-if="reportOpen && block.text" class="px-3 py-2 pt-0 text-sm opacity-90">
                            <MarkdownRenderer :content="block.text" />
                        </div>
                    </div>
                    <!-- 音乐生成回执（[音乐生成完成/失败] user 输入的回执气泡唯一块）：
                         音符徽标 + 状态 + 可折叠描述/原因，完成带原地播放键（播放/暂停切换，
                         不跳浏览器）。卡片结构/头高/内边距对位 ToolInvocation 与
                         subagent-report 卡；无轨迹入口（音乐生成无轨迹数据） -->
                    <div v-else-if="block.type === 'music-report'" class="card bg-base-200 overflow-hidden">
                        <div class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-sm"
                            @click="(block.text || block.musicTaskId) && toggleMusicOpen()">
                            <!-- 音符图标：对位工具卡 w-5 直出无底圈 -->
                            <div class="flex-none">
                                <MusicalNoteIcon class="w-5 h-5"
                                    :class="block.musicStatus === 'error' ? 'text-error' : 'text-success'" />
                            </div>
                            <div class="flex-1 min-w-0 break-words font-medium text-base-content/80 flex items-center gap-2 flex-wrap">
                                <span>{{ $t('chat.musicReport.title') }}</span>
                                <span v-if="block.musicStatus === 'error'" class="badge badge-sm badge-error badge-outline">{{ $t('chat.musicReport.error') }}</span>
                                <span v-else class="badge badge-sm badge-success badge-outline">{{ $t('chat.musicReport.completed') }}</span>
                            </div>
                            <!-- 原地播放：卡内 <audio>（无 controls，纯按钮驱动）留在头部——
                                 折叠只卸载正文，播放不中断；虚拟滚动保活由 VirtualMessageList
                                 通用检测接管（!paused 的行保持挂载，离屏不掐断，滚动回来
                                 进度/播放态原样保留）；全局单播经 chat-media 单点暂停
                                 其他聊天媒体。.stop 防止触发头部开合 -->
                            <audio v-if="block.musicUrl" :ref="assignMusicAudioEl" :src="block.musicUrl" preload="metadata"
                                data-music-audio @play="onMusicPlay" @pause="musicPlaying = false" @ended="musicPlaying = false" />
                            <button v-if="block.musicUrl" type="button" @click.stop="toggleMusicAudio"
                                class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-base-content"
                                :title="musicPlaying ? $t('chat.musicReport.pause') : $t('chat.musicReport.play')">
                                <PauseIcon v-if="musicPlaying" class="h-3.5 w-3.5" />
                                <PlayIcon v-else class="h-3.5 w-3.5" />
                            </button>
                            <!-- 开合指示（对位工具卡 chevron）：标题区 flex-1 占满后自然贴右 -->
                            <div class="flex-none text-base-content/50">
                                <ChevronDownIcon v-if="musicOpen" class="w-4 h-4" />
                                <ChevronRightIcon v-else class="w-4 h-4" />
                            </div>
                        </div>
                        <!-- 正文（描述/原因 + taskId）：收起时零挂载；内边距对位工具卡 body；
                             文本与 taskId 皆空时头部点击不触发无效果开合 -->
                        <div v-if="musicOpen" class="px-3 py-2 pt-0">
                            <div v-if="block.text" class="text-sm opacity-90">
                                <MarkdownRenderer :content="block.text" />
                            </div>
                            <div v-if="block.musicTaskId" class="mt-1 font-mono text-xs opacity-50">
                                taskId: {{ block.musicTaskId }}
                            </div>
                        </div>
                    </div>
                    <!-- 视频生成回执（[视频生成完成/失败] user 输入的回执气泡唯一块）：
                         相机徽标 + 状态 + 卡内常驻 <video>（原生 controls + preload=metadata
                         + playsinline；折叠只卸载下方正文，播放不中断，虚拟滚动保活由
                         VirtualMessageList 通用 video 检测接管）+ 可折叠正文（描述/原因
                         + taskId）。卡片结构/头高/内边距对位 music-report 卡 -->
                    <div v-else-if="block.type === 'video-report'" class="card bg-base-200 overflow-hidden">
                        <div class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-sm"
                            @click="(block.text || block.videoTaskId) && toggleVideoOpen()">
                            <!-- 相机图标：对位工具卡 w-5 直出无底圈 -->
                            <div class="flex-none">
                                <VideoCameraIcon class="w-5 h-5"
                                    :class="block.videoStatus === 'error' ? 'text-error' : 'text-success'" />
                            </div>
                            <div class="flex-1 min-w-0 break-words font-medium text-base-content/80 flex items-center gap-2 flex-wrap">
                                <span>{{ $t('chat.videoReport.title') }}</span>
                                <span v-if="block.videoStatus === 'error'" class="badge badge-sm badge-error badge-outline">{{ $t('chat.videoReport.error') }}</span>
                                <span v-else class="badge badge-sm badge-success badge-outline">{{ $t('chat.videoReport.completed') }}</span>
                            </div>
                            <!-- 开合指示（对位工具卡 chevron）：标题区 flex-1 占满后自然贴右 -->
                            <div class="flex-none text-base-content/50">
                                <ChevronDownIcon v-if="videoOpen" class="w-4 h-4" />
                                <ChevronRightIcon v-else class="w-4 h-4" />
                            </div>
                        </div>
                        <!-- 成片预览：卡内常驻（不受折叠影响）；@play 全局单播经
                             chat-media 暂停其他聊天媒体 -->
                        <video v-if="block.videoUrl" :src="block.videoUrl" controls preload="metadata" playsinline
                            data-video-report class="w-full max-h-96 rounded"
                            @play="onVideoReportPlay" />
                        <!-- 正文（描述/原因 + taskId）：收起时零挂载；内边距对位工具卡 body -->
                        <div v-if="videoOpen" class="px-3 py-2 pt-0">
                            <div v-if="block.text" class="text-sm opacity-90">
                                <MarkdownRenderer :content="block.text" />
                            </div>
                            <div v-if="block.videoTaskId" class="mt-1 font-mono text-xs opacity-50">
                                taskId: {{ block.videoTaskId }}
                            </div>
                        </div>
                    </div>
                    <div v-else-if="block.type === 'unknown'" class="alert alert-warning text-xs p-2 my-1">
                        <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-4 w-4" fill="none"
                            viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <span>Unknown block type: {{ block.text }}</span>
                    </div>
                    <div v-else-if="block.type === 'error'"
                        class="alert alert-error text-xs px-3 py-1 flex items-start gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-5 w-5 mt-0.5"
                            fill="none" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <div class="flex-1">
                            <div class="font-bold">{{ $t('common.error') }}</div>
                            <div class="break-all">{{ block.error }}</div>
                        </div>
                    </div>
                </template>
            </div>
        </div>
        <!-- Assistant Actions (Fixed) -->
        <div v-if="message.role !== 'user'" class="chat-footer mt-1 flex items-center gap-1">
            <button @click="emit('copy', message)"
                class="btn btn-ghost btn-sm btn-circle text-base-content/60 hover:text-primary hover:bg-base-300"
                :title="$t('common.copy')">
                <ClipboardIcon class="h-4 w-4" />
            </button>
            <button @click="emit('read-aloud', message)"
                class="btn btn-ghost btn-sm btn-circle text-base-content/60 hover:text-primary hover:bg-base-300"
                :class="{ 'bg-green-100 text-green-600 hover:bg-green-200 hover:text-green-700': currentReadingMsgId === message.id }"
                :title="$t('chat.readAloud')">
                <template v-if="currentReadingMsgId === message.id">
                    <StopIcon class="h-4 w-4" />
                </template>
                <template v-else>
                    <SpeakerWaveIcon class="h-4 w-4" />
                </template>
            </button>
            <button v-if="!isLoading && message.entryId" @click="emit('fork', message)"
                :disabled="chatState.isForkingEntry(message.lastEntryId ?? message.entryId)"
                class="btn btn-ghost btn-sm btn-circle text-base-content/60 hover:text-secondary hover:bg-secondary/10 disabled:opacity-40 disabled:cursor-not-allowed"
                :title="$t('chat.fork')">
                <span v-if="chatState.isForkingEntry(message.lastEntryId ?? message.entryId)" class="loading loading-spinner h-4 w-4"></span>
                <!-- git-fork 图标（heroicons 无对应图标，用 lucide git-fork 路径内联） -->
                <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
                    <circle cx="12" cy="18" r="3" />
                    <circle cx="6" cy="6" r="3" />
                    <circle cx="18" cy="6" r="3" />
                    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                    <path d="M12 12v3" />
                </svg>
            </button>
            <button v-if="!isBusy && message.entryId" @click="emit('retry', message)"
                class="btn btn-ghost btn-sm btn-circle text-base-content/60 hover:text-warning hover:bg-warning/10"
                :title="$t('chat.retry')">
                <ArrowPathIcon class="h-4 w-4" />
            </button>

            <!-- Branch Navigation -->
            <!-- busy 期间整块不渲染：运行中切分支会把会话级流状态泄漏到目标分支视图，
                 且服务端会替换在途 agent 的内存上下文导致 run 失踪；隐藏比禁用更简单一致
                 （服务端 409 兑底非 UI 路径） -->
            <div v-if="!isBusy && branchInfo && branchInfo.siblings.length > 1" class="flex items-center gap-0.5 ml-1">
                <button @click="emit('navigate-branch', message, 'prev')"
                    class="btn btn-ghost btn-xs btn-circle text-base-content/60 hover:text-primary hover:bg-base-300">
                    <ChevronLeftIcon class="h-3.5 w-3.5" />
                </button>
                <span class="text-xs text-base-content/50 min-w-[2rem] text-center select-none">
                    {{ branchInfo.currentIndex + 1 }}/{{ branchInfo.siblings.length }}
                </span>
                <button @click="emit('navigate-branch', message, 'next')"
                    class="btn btn-ghost btn-xs btn-circle text-base-content/60 hover:text-primary hover:bg-base-300">
                    <ChevronRightIcon class="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    </div>


</template>

<style scoped>

/* 跳转定位闪光：外圈光晕淡出，one-shot 动画（class 移除后重加可重放） */
.bubble-flash {
    animation: bubble-flash 900ms ease-out;
}

@keyframes bubble-flash {
    0% {
        /* daisyUI 5 主题变量是 --color-primary（旧版 --p 已不存在） */
        filter: drop-shadow(0 0 6px color-mix(in oklab, var(--color-primary) 55%, transparent));
    }
    100% {
        filter: drop-shadow(0 0 0 transparent);
    }
}

@media (max-width: 768px) {
    .chat {
        column-gap: 0 !important;
    }

    .chat-bubble::before {
        display: none !important;
    }
}
</style>
