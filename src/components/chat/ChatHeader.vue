<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { SessionUsage } from '../../composables/useChatState'
import {
    Bars3Icon,
    SunIcon,
    MoonIcon,
    PlusIcon,
    PhoneIcon,
    BellIcon,
    BellSlashIcon,
    ArrowPathIcon,
    RectangleGroupIcon,
    QueueListIcon
} from '@heroicons/vue/24/outline'
import { isConnected } from '../../composables/notify-server-connection'
import { useWorkspacePanel } from '../../composables/useWorkspacePanel'

import ViewHeader from '../ViewHeader.vue'
import { NEW_SESSION_ROUTE_NAME } from '../../utils/route-helpers'
import { useChatState } from '../../composables/useChatState'
import { apiPost } from '../../composables/api-client'
import { onExtensionEvent } from '../../composables/extension-events'

defineProps<{
    sessionName?: string
    /** Workspace 面板可见时（占据窗口右侧全高），悬浮窗口键压在面板上而非顶栏，无需预留 */
    panelVisible?: boolean
}>()


const emit = defineEmits<{
    (e: 'start-voice-chat'): void
    (e: 'open-session-tree'): void
}>()

const router = useRouter()
const chatState = useChatState()
const { t } = useI18n()
const panel = useWorkspacePanel()


const showUsageTip = ref(false)
const notifyEnabled = ref(false)
const notifyLoading = ref(false)

const isSession = computed(() => Boolean(chatState.sessionKey))

const buildNotifyAgentQuery = (agentId: string) => {
    return agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
}

// 会话切换/agent 切换：重置铃铛——现态由 attach 快照线（ext.notify_state）随帧恢复，
// 不再逐次轮询 GET；重置防上一会话的状态在快照到达前闪现
watch(
    () => [chatState.sessionKey, chatState.agentsSelectedId],
    () => {
        notifyEnabled.value = false
    },
    { immediate: true }
)

// 推送线 + 快照线：ext.notify_state（两仓契约，与服务端 NOTIFY_STATE_EVENT 同值）
// → 铃铛状态。POST toggle 的响应仍是最直接的按钮线（toggleNotify 内已有），本订阅
// 覆盖快照恢复与多窗口同步。
const unsubscribeNotifyState = onExtensionEvent('ext.notify_state', (data, key) => {
    if (!key || key !== chatState.sessionKey) return
    if (!data || typeof data !== 'object') return
    const d = data as { enabled?: unknown }
    if (typeof d.enabled !== 'boolean') return
    notifyEnabled.value = d.enabled
})

// ChatHeader 随 HomeView 反复装卸：组件级订阅必须退订（模块级总线不随组件清理）
onUnmounted(() => unsubscribeNotifyState())

const toggleNotify = async () => {
    const sessionId = chatState.sessionKey
    const agentId = chatState.agentsSelectedId
    if (!sessionId || notifyLoading.value) return

    const nextEnabled = !notifyEnabled.value
    notifyLoading.value = true
    try {
        const result = await apiPost<{ enabled: boolean }>(
            `/api/extensions/notify/settings/sessions/${encodeURIComponent(sessionId)}${buildNotifyAgentQuery(agentId)}`,
            { enabled: nextEnabled }
        )
        if (chatState.sessionKey === sessionId && chatState.agentsSelectedId === agentId) {
            notifyEnabled.value = Boolean(result?.enabled)
        }
    } catch {
        // POST 失败：点击未做乐观更新，notifyEnabled 仍是点击前的服务端真值；
        // 不做本地改写（旧 fallback 是重拉 GET，该轮询端点已删）
    } finally {
        notifyLoading.value = false
    }
}

const createNewSession = () => {
    router.push({ name: NEW_SESSION_ROUTE_NAME })
}

const startVoiceChat = () => {
    emit('start-voice-chat')
}

const refreshPage = () => {
    window.location.reload()
}

// Close tooltip when clicking outside
const handleClickOutside = (event: MouseEvent) => {
    showUsageTip.value = false
}

// ---- Token usage formatting (mirrors TUI footer logic) ----
function formatTokens(count: number): string {
    if (count < 1000) return count.toString()
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`
    if (count < 1000000) return `${Math.round(count / 1000)}k`
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
    return `${Math.round(count / 1000000)}M`
}

function buildUsageTip(usage: SessionUsage): string {
    const parts: string[] = []
    if (usage.input) parts.push(`↑${formatTokens(usage.input)}`)
    if (usage.output) parts.push(`↓${formatTokens(usage.output)}`)
    // reasoning 是 output 的子集；非 0 时单独展示，对齐服务端 usage 扩展推送载荷与 TUI footer。
    if (usage.reasoning) parts.push(`T${formatTokens(usage.reasoning)}`)
    if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
    if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
    if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`)

    // Context window usage
    const auto = usage.autoCompactEnabled ? ` (${t('common.autoCompact')})` : ''
    if (usage.percent !== null) {
        parts.push(`${usage.percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}${auto}`)
    } else if (usage.contextWindow > 0) {
        parts.push(`?/${formatTokens(usage.contextWindow)}${auto}`)
    }
    return parts.join(' ')
}

/** Tooltip 各行内容（空数组 = 只显示连接状态） */
const usageTipLines = computed<string[]>(() => {
    const usage = chatState.sessionUsage
    if (!usage) return []

    const lines: string[] = []

    // 第一行：token 统计
    const usageLine = buildUsageTip(usage)
    if (usageLine) lines.push(usageLine)

    // 第二行：提供商/模型 + 思考级别
    const session = chatState.currentSession
    const provider = session?.modelProvider || ''
    const model = session?.model || ''
    const thinking = session?.thinkingLevel
    const modelLabel = provider && model ? `${provider}/${model}` : model || provider
    if (modelLabel) {
        if (thinking && thinking !== 'off') {
            lines.push(`${modelLabel} · ${thinking}`)
        } else if (thinking === 'off') {
            lines.push(`${modelLabel} · ${t('common.thinkingOff')}`)
        } else {
            lines.push(modelLabel)
        }
    }

    return lines
})

defineExpose({
    handleClickOutside
})
</script>

<template>
    <ViewHeader :show-border="isSession" :wc-pad="!panelVisible">
        <!-- Back Button or Hamburger -->
        <template #left>
            <div class="flex-none lg:hidden">
                <label for="sidebar-drawer" :aria-label="$t('common.openSidebar')" class="btn btn-ghost btn-xs btn-circle drawer-button">
                    <Bars3Icon class="h-5 w-5" />
                </label>
            </div>
        </template>

        <!-- Title（顶栏 agent 下拉已移除；新会话页不显示，会话页显示会话名 + agent 徽章） -->
        <template #title>
            <div class="flex-1 flex items-center min-w-0">
                <div v-if="isSession" class="lg:pl-5 font-semibold flex items-center gap-2 min-w-0 flex-1">
                    <span class="truncate max-w-[150px] lg:max-w-none text-lg">{{ sessionName }}</span>
                    <span v-if="chatState.agentsSelectedId"
                        class="badge badge-sm badge-ghost shrink-0 max-w-[10ch] overflow-hidden align-middle"
                        :title="chatState.agentsSelectedId">
                        <span class="block truncate whitespace-nowrap">{{ chatState.agentsSelectedId }}</span>
                    </span>
                </div>
            </div>
        </template>

        <!-- Actions -->
        <template #actions>
            <div class="flex items-center lg:gap-5">
                <!-- Connection Status Indicator -->
                <div class="relative group flex items-center" @click.stop="showUsageTip = !showUsageTip" role="button"
                    tabindex="0" :aria-expanded="showUsageTip"
                    :aria-label="isConnected ? $t('common.connected') : $t('common.disconnected')"
                    @keydown.enter.prevent.stop="showUsageTip = !showUsageTip"
                    @keydown.space.prevent.stop="showUsageTip = !showUsageTip" @keydown.escape="showUsageTip = false">
                    <div class="w-3 h-3 rounded-full transition-colors duration-300 cursor-pointer" aria-hidden="true"
                        :class="isConnected ? 'bg-success' : 'bg-error/50'"></div>
                    <!-- Multi-line tooltip: hover (PC) + click (mobile) -->
                    <div role="tooltip" class="absolute top-full mt-2 right-0
                                transition-opacity duration-200
                                bg-neutral text-neutral-content text-xs rounded-lg px-3 py-2
                                shadow-lg whitespace-nowrap z-50"
                        :class="showUsageTip ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 pointer-events-none'">
                        <div>{{ isConnected ? $t('common.connected') : $t('common.disconnected') }}</div>
                        <div v-for="(line, i) in usageTipLines" :key="i" class="text-neutral-content/70">{{ line }}
                        </div>
                    </div>
                </div>



                <!-- 移动端  -->
                <button @click="refreshPage" class="btn btn-ghost btn-circle btn-xs lg:hidden"
                    :title="$t('common.refresh')">
                    <ArrowPathIcon class="h-5 w-5" />
                </button>

                <!-- <button @click="createNewSession" class="btn btn-ghost btn-circle btn-xs lg:hidden"
                    :title="$t('chat.newChat')">
                    <PlusIcon class="h-5 w-5" />
                </button> -->



                <!-- PC -->


                <!-- PC 与移动端共用 -->

                <!-- Voice button -->
                <!-- <button v-if="settingsStore.isCurrentAsrConfigured && settingsStore.isCurrentTtsConfigured" @click="startVoiceChat"
                        class="btn btn-ghost btn-circle btn-xs" :title="$t('chat.voiceChat')">
                        <PhoneIcon class="h-5 w-5" />
                </button> -->

                <!-- Session tree（仅移动端：桌面端用左侧 SessionTreeRail） -->
                <button v-if="isSession" @click="emit('open-session-tree')"
                    class="btn btn-ghost btn-circle btn-xs lg:hidden" :title="$t('chat.openSessionTree')">
                    <QueueListIcon class="h-5 w-5" />
                </button>

                <!-- Session notify toggle -->
                <button v-if="isSession" @click="toggleNotify" class="btn btn-ghost btn-circle btn-xs"
                    :class="{ 'text-primary': notifyEnabled }" :disabled="notifyLoading"
                    :title="`${$t('settings.notifications')}: ${notifyEnabled ? $t('common.enabled') : $t('common.disabled')}`">
                    <BellIcon v-if="notifyEnabled" class="h-5 w-5" />
                    <BellSlashIcon v-else class="h-5 w-5" />
                </button>

                <!-- Workspace panel toggle: PC 与移动端共用（移动端在 ChatHeader
                     按钮区开 right-drawer，与左侧 sidebar drawer 对称）。
                     无 agent 选中时隐藏，避免点开个空 drawer。 -->
                <button v-if="chatState.agentsSelectedId" @click="panel.toggle()"
                    class="btn btn-ghost btn-circle btn-xs" :class="{ 'text-primary': panel.isOpen.value }"
                    :title="$t('workspace.toggle')">
                    <RectangleGroupIcon class="h-5 w-5" />
                </button>
            </div>
        </template>
    </ViewHeader>
</template>
