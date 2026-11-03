<!-- 输入框上方 dock 区的后台子代理状态条（原 ChatHeader 顶栏按钮的迁移版，PC/移动端统一入口）。
     与 PendingQueueBar/TaskBar/GoalBar 同一形态：一行 chip（运行中数量），点击 inline 展开
     逐工人清单（不是浮出弹层）——状态徽标 + 名字·任务 + 眼睛（轨迹抽屉，与前台工具卡同一
     抽屉）+ 停止按钮（busy 期可用）。数据源 useBackgroundAgents 模块级单例（ext.subagent_state
     三到达线，零轮询），无后台子代理时不渲染（dock 约定：widget 自决定显隐）。 -->
<script setup lang="ts">
import { ref } from 'vue'
import { UserGroupIcon, StopIcon, EyeIcon, ChevronDownIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { useBackgroundAgents, type BackgroundAgentEntry } from '../../composables/useBackgroundAgents'
import { useChatState } from '../../composables/useChatState'
import { useSubagentTrace } from '../../composables/useSubagentTrace'

const bg = useBackgroundAgents()
const chatState = useChatState()
const traceViewer = useSubagentTrace()

const stopping = ref<string | null>(null)

const statusClass = (status: string): string => {
    switch (status) {
        case 'working': return 'badge-primary'
        case 'idle': return 'badge-ghost'
        case 'completed': return 'badge-success badge-outline'
        case 'error': return 'badge-error badge-outline'
        case 'aborted': return 'badge-warning badge-outline'
        default: return 'badge-ghost'
    }
}

const stopAgent = async (name: string) => {
    if (stopping.value) return
    stopping.value = name
    try {
        await bg.stopAgent(name)
    } finally {
        stopping.value = null
    }
}

// 打开后台子代理的轨迹抽屉：与前台 ToolInvocation 卡片同一抽屉（SubagentTraceDrawer）。
// 服务端后台路径与前台共用轨迹线（ext.subagent_trace 推送 subId=子会话id +
// <ts>_<childId>.jsonl 侧车同目录落盘）。合成 result 满足抽屉 tab 形状
// （subagentSessionId/agent/task/status）
const openTrace = (agent: BackgroundAgentEntry) => {
    const key = chatState.sessionKey
    if (!key) return
    traceViewer.open(key, [{
        subagentSessionId: agent.conversationId,
        agent: agent.subagentId,
        ...(agent.task !== undefined ? { task: agent.task } : {}),
        status: agent.status,
    }], agent.conversationId)
}
</script>

<template>
    <div v-if="bg.barVisible.value" class="border-t border-base-300 bg-base-100/40 px-4 py-1 text-xs select-none">
        <div class="mx-auto w-full max-w-3xl">
            <!-- 折叠条：同 TaskBar 模式——toggle 主体（flex-1 + 箭头）+ 独立 X 关闭钮。
                 X 只隐藏通知条：新工人 spawn / 会话切换 / /bgagents 自动恢复 -->
            <div class="flex items-center gap-1.5 py-0.5">
                <button type="button"
                    class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-base-content/70 hover:text-base-content transition-colors cursor-pointer"
                    :class="{ 'text-primary': bg.workingCount.value > 0 }"
                    :aria-expanded="bg.panelOpen.value" @click="bg.togglePanel()">
                    <UserGroupIcon class="h-3.5 w-3.5 shrink-0" />
                    <span class="font-medium whitespace-nowrap">{{ $t('chat.backgroundAgents.title') }}</span>
                    <span v-if="bg.workingCount.value > 0" class="text-base-content/40 truncate">
                        · {{ bg.workingCount.value }} {{ $t('chat.backgroundAgents.status.working') }}
                    </span>
                    <ChevronDownIcon class="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200"
                        :class="{ 'rotate-180': bg.panelOpen.value }" />
                </button>
                <button type="button"
                    class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-base-content"
                    :title="$t('chat.backgroundAgents.dismissHint')" :aria-label="$t('chat.backgroundAgents.dismissHint')"
                    @click="bg.dismissBar()">
                    <XMarkIcon class="h-3.5 w-3.5" />
                </button>
            </div>
            <!-- 展开逐工人清单：inline 与其他 dock widget 同构（非浮出弹层）。
                 眼睛 = 轨迹抽屉；停止 = 后台 stop 路由（busy 期可用） -->
            <div v-if="bg.panelOpen.value" class="flex flex-col gap-1 pb-1.5 pt-1">
                <div v-for="agent in bg.sortedAgents.value" :key="agent.name"
                    class="flex items-center gap-2 rounded-lg border border-base-300 bg-base-200 px-2 py-1">
                    <span class="badge badge-xs shrink-0 font-normal" :class="statusClass(agent.status)">
                        {{ $t('chat.backgroundAgents.status.' + agent.status) }}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-base-content/70"
                        :title="agent.task ? `${agent.name} · ${$t('chat.backgroundAgents.task')}: ${agent.task}` : agent.name">
                        {{ agent.name }}<template v-if="agent.task"> · {{ agent.task }}</template>
                    </span>
                    <button type="button" @click="openTrace(agent)"
                        class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-base-content"
                        :title="$t('subagentTrace.title')">
                        <EyeIcon class="h-3.5 w-3.5" />
                    </button>
                    <button v-if="agent.status === 'working'" type="button" @click="stopAgent(agent.name)"
                        class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-error"
                        :disabled="stopping !== null"
                        :title="$t('chat.backgroundAgents.stop')">
                        <StopIcon class="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
