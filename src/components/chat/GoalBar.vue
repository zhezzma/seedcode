<!-- src/components/chat/GoalBar.vue -->
<!-- goal 自动续跑状态条：运行中显示续跑进度 + 停止按钮；停止后显示结果 + 恢复按钮。
     ✕ 任何状态可关闭，关闭记忆按会话持久化；新 goal 启动 / resume（新 startedAt）后面板自动重现。
     /goalbar 客户端命令重现已关闭的面板（展开详情 + 脉冲，任何状态都有可见反馈）。
     状态三条到达线（零轮询）：推送线（run 进行中服务端 emitExtensionEvent 实时扇出，经 useChatState
     default 分支转发 extension-events 总线）；快照线（attach/刷新/切会话，attach 流携带 seed.goal 现态）；
     按钮线（停止/恢复 POST 响应直接带回状态）。
     停止/恢复按钮走扩展路由 POST /api/extensions/goal/:sessionId/stop|resume，
     绕过 /chat 命令路径的 busy 门禁（busy 时 /goal 全系含 off 一律 409）。 -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDownIcon, XMarkIcon, StopIcon, PlayIcon } from '@heroicons/vue/24/outline'
import { useGoalState } from '../../composables/useGoalState'
import { attachToSessionIfNeeded, useChatState } from '../../composables/useChatState'
import { apiPost } from '../../composables/api-client'
import type { GoalStatePayload } from '../../utils/goal-snapshot'

const { t } = useI18n()
const { goalState, visibleBar, dismiss, expandRequest, applyState } = useGoalState()
const chatState = useChatState()
const expanded = ref(false)

// 停止/恢复按钮 loading 态（防止连点）
const stopping = ref(false)
const resuming = ref(false)

async function stopGoal(): Promise<void> {
    if (stopping.value || !chatState.sessionKey) return
    // key 在 await 前捕获：慢响应期间切会话时，结果仍归属点击时的会话
    //（applyState 的归属守卫比对的是响应到达时刻的当前会话，key 现取会串会话）
    const key = chatState.sessionKey
    stopping.value = true
    try {
        const res = await apiPost<{ ok: boolean; state?: GoalStatePayload | null }>(
            `/api/extensions/goal/${encodeURIComponent(key)}/stop`,
        )
        // 按钮线：响应带回变更后状态——idle 无流时（emitExtensionEvent no-op）这是唯一到达线；
        // busy 流开时推送线已到，此处幂等
        applyState(res?.state ?? null, key)
    } catch {
        // apiPost 已弹 toast
    } finally {
        stopping.value = false
    }
}

async function resumeGoal(): Promise<void> {
    if (resuming.value || !chatState.sessionKey) return
    // 同 stopGoal：key 在 await 前捕获
    const key = chatState.sessionKey
    resuming.value = true
    try {
        const res = await apiPost<{ ok: boolean; state?: GoalStatePayload | null }>(
            `/api/extensions/goal/${encodeURIComponent(key)}/resume`,
        )
        applyState(res?.state ?? null, key)
        // 恢复在服务端开了新 run（followUp 驱动），但按钮路径没有流附着：不主动 attach
        // 的话续跑回复/轮数推进/done 对客户端全部不可见（唯一兜底是切会话/刷新）。
        // 已有活跃连接时 attach 幂等跳过；切走会话后响应才到的场景，attach 的旧 key
        // 事件被 applyState 归属守卫拦下，无副作用。stop 不需要：停止不产生新内容。
        // （同款先例：useA2UIActions 面板提交后的服务端续跑流附着）
        if (res?.state?.enabled) attachToSessionIfNeeded(key)
    } catch {
        // apiPost 已弹 toast（409 busy / 400 无可恢复状态）
    } finally {
        resuming.value = false
    }
}

// /goalbar 唤起脉冲：面板「已显示且已展开」时 expanded 置位是纯 no-op，
// 用一次性背景闪烁兑现命令在任何状态下都有可见反馈（同 TasklistBar）。
const flashed = ref(false)
let flashTimer: ReturnType<typeof setTimeout> | undefined

watch(expandRequest, () => {
    expanded.value = true
    // class 摘除 → 下一拍重加：重放 CSS 动画（连续触发也重新起播）
    flashed.value = false
    if (flashTimer !== undefined) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
        flashed.value = true
        flashTimer = setTimeout(() => {
            flashed.value = false
            flashTimer = undefined
        }, 1000)
    }, 0)
})
onBeforeUnmount(() => {
    if (flashTimer !== undefined) clearTimeout(flashTimer)
})

// 会话切换时收起展开态：组件常驻 ChatDockArea 不随会话卸载，
// 展开状态延续到新会话会造成误导（同 TasklistBar）
watch(() => chatState.sessionKey, () => {
    expanded.value = false
})
</script>

<template>
    <div v-if="visibleBar" class="border-t border-base-300 bg-base-100/40 px-4 py-1 text-xs select-none"
        :class="{ 'goalbar-flash': flashed }">
        <div class="mx-auto w-full max-w-3xl">
            <!-- 折叠条：续跑标记 + 轮数 + 裁判 + 展开箭头 / 停止·恢复·关闭钮 -->
            <div class="flex items-center gap-1.5 py-0.5">
                <button type="button"
                    class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-base-content/70 hover:text-base-content transition-colors cursor-pointer"
                    @click="expanded = !expanded">
                    <!-- 运行中 🔄 / 停止 ⏸ -->
                    <span aria-hidden="true">{{ goalState!.enabled ? '🔄' : '⏸' }}</span>
                    <span class="font-medium whitespace-nowrap">
                        {{ goalState!.enabled
                            ? t('chat.goalBar.running')
                            : (goalState!.resumable ? t('chat.goalBar.stopped') : t('chat.goalBar.finished')) }}
                    </span>
                    <span v-if="goalState!.enabled" class="whitespace-nowrap">
                        {{ goalState!.maxTurns > 0
                            ? t('chat.goalBar.turnCount', { current: goalState!.turnCount, max: goalState!.maxTurns })
                            : t('chat.goalBar.turnCountUnlimited', { current: goalState!.turnCount }) }}
                    </span>
                    <span v-if="goalState!.enabled && goalState!.judgeEnabled" class="text-base-content/50 truncate">
                        · {{ t('chat.goalBar.judge', { model: goalState!.judgeModel || t('chat.goalBar.judgeSession') }) }}
                    </span>
                    <ChevronDownIcon class="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200"
                        :class="{ 'rotate-180': expanded }" />
                </button>
                <!-- 停止按钮（运行中） -->
                <button v-if="goalState!.enabled" type="button" :disabled="stopping"
                    class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-error"
                    :title="t('chat.goalBar.stopHint')" :aria-label="t('chat.goalBar.stopHint')" @click="stopGoal()">
                    <StopIcon class="h-3.5 w-3.5" />
                </button>
                <!-- 恢复按钮（已停止且可恢复） -->
                <button v-if="!goalState!.enabled && goalState!.resumable" type="button" :disabled="resuming"
                    class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-success"
                    :title="t('chat.goalBar.resumeHint')" :aria-label="t('chat.goalBar.resumeHint')" @click="resumeGoal()">
                    <PlayIcon class="h-3.5 w-3.5" />
                </button>
                <button type="button"
                    class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-base-content"
                    :title="t('chat.goalBar.dismissHint')" :aria-label="t('chat.goalBar.dismissHint')" @click="dismiss()">
                    <XMarkIcon class="h-3.5 w-3.5" />
                </button>
            </div>

            <!-- 展开态：起始消息 + 续跑消息 -->
            <div v-if="expanded" class="flex flex-col gap-1 pb-1.5 pt-1">
                <div class="text-base-content/40 pt-0.5">{{ t('chat.goalBar.startMessage') }}</div>
                <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-1 text-base-content/70">
                    {{ goalState!.startMessage }}
                </div>
                <div class="text-base-content/40 pt-0.5">{{ t('chat.goalBar.turnMessage') }}</div>
                <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-1 text-base-content/70">
                    {{ goalState!.turnMessage }}
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* /goalbar 唤起脉冲：主题色背景闪烁一次后回到常态底色（bg-base-100/40）。
   同 tasklist-flash；prefers-reduced-motion 用户降级为无动画（展开反馈仍在） */
.goalbar-flash {
    animation: goalbar-flash 1s ease-out;
}

@keyframes goalbar-flash {
    0% {
        background-color: color-mix(in oklab, var(--color-primary) 16%, transparent);
    }

    100% {
        background-color: transparent;
    }
}

@media (prefers-reduced-motion: reduce) {
    .goalbar-flash {
        animation: none;
    }
}
</style>
