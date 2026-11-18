<!-- 群回合 busy 条（MusicBar/TaskBar 同形态 dock widget）：折叠行 = 群回合标题 +
     排队数 + 停止按钮（在飞时可用，停队首回合）；点击展开排队明细（队首=进行中，
     其余=等待中，消息文本 + 应答成员名）。数据源 useChatState 的 groupTurnQueue
     投影（发送 append / ext.team_state 回合边界拉新 / 开群恢复拉取）；仅群会话
     渲染（行级身份判定 isGroupSessionRow，非桶位置）。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChatBubbleLeftRightIcon, ChevronDownIcon, StopIcon } from '@heroicons/vue/24/outline'
import { apiPost } from '../../composables/api-client'
import { useToast } from '../../composables/useToast'
import { useChatState } from '../../composables/useChatState'
import { useSessionsState, isGroupSessionRow } from '../../composables/useSessionsState'

const { t } = useI18n()
const chatState = useChatState()

// 行级群身份判定（唯一权威面 useSessionsState.isGroupSessionRow——归档群/
// 回收站回填的群行同样命中；不内联 sessionCategory/agentId 双判）
const isGroupSession = computed(() => {
    const key = chatState.sessionKey
    if (!key) return false
    const row = useSessionsState().findSessionLocal(key)
    return isGroupSessionRow(row)
})

const sessionData = computed(() => chatState.sessionsMap.get(chatState.sessionKey))
const queue = computed(() => sessionData.value?.groupTurnQueue ?? [])
const busy = computed(() => sessionData.value?.groupTurnBusy === true || queue.value.length > 0)
const visible = computed(() => isGroupSession.value && busy.value)

/** picks（成员 key）→ 显示名：groupMembers 名册投影；查不到回退 key 尾段。 */
const memberNames = (picks: string[]): string => {
    const roster = new Map((sessionData.value?.groupMembers ?? []).map(m => [m.key, m.name]))
    return picks.map(key => roster.get(key) ?? key.replace(/^(in|ag)-/, '')).join('、')
}

// 会话切换时收起展开态（TaskBar 同款：组件常驻 ChatDockArea 不随会话卸载）
const expanded = ref(false)
watch(() => chatState.sessionKey, () => {
    expanded.value = false
})

const stopping = ref(false)
const stopCurrentTurn = async () => {
    const key = chatState.sessionKey
    if (!key || stopping.value) return
    stopping.value = true
    try {
        await apiPost(`/api/extensions/team-chat/groups/${encodeURIComponent(key)}/stop`, {})
        useToast().info(t('chat.groupTurnBar.stopRequested'), 3000)
    } catch (error) {
        useToast().error((error as Error)?.message || t('chat.groupTurnBar.stopFailed'), 5000)
    } finally {
        stopping.value = false
    }
}
</script>

<template>
    <div v-if="visible" class="border-t border-base-300 bg-base-100/40 px-4 py-1 text-xs select-none">
        <div class="mx-auto w-full max-w-3xl">
            <!-- 折叠条：toggle 主体 + 独立 stop 钮（MusicBar 同构）。stop=停止队首
                 在飞回合（服务端 abort 队首任务，waiting 后继自动推进） -->
            <div class="flex items-center gap-1.5 py-0.5">
                <button type="button"
                    class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-base-content/70 hover:text-base-content transition-colors cursor-pointer"
                    :class="{ 'text-primary': busy }"
                    :aria-expanded="expanded" @click="expanded = !expanded">
                    <ChatBubbleLeftRightIcon class="h-3.5 w-3.5 shrink-0" />
                    <span class="font-medium whitespace-nowrap">{{ $t('chat.groupTurnBar.title') }}</span>
                    <span class="loading loading-dots loading-xs text-base-content/40"></span>
                    <span class="text-base-content/40 truncate">
                        · {{ queue.length }} {{ $t('chat.groupTurnBar.queued') }}
                    </span>
                    <ChevronDownIcon class="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200"
                        :class="{ 'rotate-180': expanded }" />
                </button>
                <button type="button" @click="stopCurrentTurn()"
                    class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-error"
                    :disabled="stopping"
                    :title="$t('chat.groupTurnBar.stop')" :aria-label="$t('chat.groupTurnBar.stop')">
                    <StopIcon class="h-3.5 w-3.5" />
                </button>
            </div>
            <!-- 展开排队明细（MusicBar 逐曲清单同构）：队首=进行中，其余=等待中 -->
            <div v-if="expanded" class="flex flex-col gap-1 pb-1.5 pt-1 max-h-64 overflow-y-auto">
                <div v-for="(item, index) in queue" :key="item.taskId"
                    class="flex items-center gap-2 rounded-lg border border-base-300 bg-base-200 px-2 py-1"
                    :class="{ 'border-primary/30': index === 0 }">
                    <span class="badge badge-xs shrink-0 font-normal" :class="index === 0 ? 'badge-primary' : 'badge-ghost'">
                        {{ index === 0 ? $t('chat.groupTurnBar.running') : $t('chat.groupTurnBar.waiting') }}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-base-content/70" :title="item.message">
                        {{ item.message }}
                    </span>
                    <span class="badge badge-ghost badge-xs shrink-0 font-normal max-w-40 truncate"
                        :title="memberNames(item.picks)">
                        {{ memberNames(item.picks) }}
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>
