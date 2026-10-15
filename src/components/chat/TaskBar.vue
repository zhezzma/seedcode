<!-- src/components/chat/TaskBar.vue -->
<!-- 会话工作步骤条：有步骤才出现；折叠态一行摘要，点击展开按状态分组。
     ✕ 任何状态可用（含中断/未完成），关闭记忆按会话持久化（同结构快照不再弹出）；
     新步骤/状态变化（结构指纹变化）后面板自动重现一次，可再次关闭。 -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDownIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { useTaskBarState } from '../../composables/useTaskBarState'
import { useChatState } from '../../composables/useChatState'
import type { TaskBarTask } from '../../utils/taskbar-snapshot'

const { t } = useI18n()
const { tasks, counts, inProgress, dismiss, visibleBar, allDone, expandRequest } = useTaskBarState()
const expanded = ref(false)

// /taskbar 唤起脉冲：面板「已显示且已展开」时 expanded 置位是纯 no-op，
// 用一次性背景闪烁兑现在何状态下执行命令都有可见反馈的承诺。
const flashed = ref(false)
let flashTimer: ReturnType<typeof setTimeout> | undefined

// /taskbar 客户端命令的展开请求：restore 重现面板时同时展开分组清单；
// 配合 taskbar-flash 脉冲，任何状态下执行命令都有可见反馈。
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
// 展开状态延续到新会话的步骤列表会造成误导
const chatState = useChatState()
watch(() => chatState.sessionKey, () => {
    expanded.value = false
})

// 分组标题的 i18n 键查表：避免模板里动态拼接键名，显式映射更稳。
// 注：v-for 对象迭代时 key 被 Vue 推断为 string，故用 Record<string, string>
// 以通过 strict 模式索引（union 字面量键会触发 TS7053）。
const SECTION_KEY: Record<string, string> = {
    inProgress: 'chat.taskBar.sectionInProgress',
    pending: 'chat.taskBar.sectionPending',
    completed: 'chat.taskBar.sectionCompleted',
}

const groups = (list: TaskBarTask[]) => ({
    inProgress: list.filter((x) => x.status === 'in_progress'),
    pending: list.filter((x) => x.status === 'pending'),
    completed: list.filter((x) => x.status === 'completed'),
})
</script>

<template>
    <div v-if="visibleBar" class="border-t border-base-300 bg-base-100/40 px-4 py-1 text-xs select-none"
        :class="{ 'taskbar-flash': flashed }">
        <div class="mx-auto w-full max-w-3xl">
            <!-- 折叠条：进度 + 正在做的事 + 展开箭头 / 完成态关闭钮 -->
            <div class="flex items-center gap-1.5 py-0.5 ">
                <button type="button"
                    class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-base-content/70 hover:text-base-content transition-colors cursor-pointer"
                    @click="expanded = !expanded">
                    <span aria-hidden="true">{{ allDone ? '✓' : '📋' }}</span>
                    <span class="font-medium whitespace-nowrap">
                        {{ allDone
                            ? t('chat.taskBar.allDone', { done: counts.done, total: counts.total })
                            : t('chat.taskBar.countLabel', { done: counts.done, total: counts.total }) }}
                    </span>
                    <span v-if="inProgress && !allDone" class="text-base-content/50 truncate">
                        · {{ t('chat.taskBar.workingOn', { active: inProgress.activeForm || inProgress.subject }) }}
                    </span>
                    <span v-if="!allDone && !expanded" class="text-base-content/40 whitespace-nowrap">· {{ t('chat.taskBar.hint') }}</span>
                    <ChevronDownIcon class="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200"
                        :class="{ 'rotate-180': expanded }" />
                </button>
                <button type="button"
                    class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-base-content"
                    :title="t('chat.taskBar.dismissHint')" :aria-label="t('chat.taskBar.dismissHint')" @click="dismiss()">
                    <XMarkIcon class="h-3.5 w-3.5" />
                </button>
            </div>

            <!-- 展开态：按状态分组（进行中 → 待处理 → 已完成），样式对齐 PendingQueueBar 展开条 -->
            <div v-if="expanded" class="flex flex-col gap-1 pb-1.5 pt-1">
                <template v-for="(group, key) in groups(tasks)" :key="key">
                    <template v-if="group.length > 0">
                        <div class="text-base-content/40 pt-0.5">{{ t(SECTION_KEY[key]) }}</div>
                        <div v-for="item in group" :key="item.id"
                            class="flex items-center gap-2 rounded-lg border border-base-300 px-2 py-1"
                            :class="item.status === 'completed' ? 'bg-base-200/40 text-base-content/40 line-through' : (item.status === 'in_progress' ? 'bg-base-200 border-primary/30 ' : 'bg-base-200')">
                            <span class="shrink-0" aria-hidden="true">{{ item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○' }}</span>
                            <span class="min-w-0 flex-1 truncate" :title="item.description || item.subject">
                                {{ item.status === 'in_progress' && item.activeForm ? item.activeForm : item.subject }}
                            </span>
                            <span class="badge badge-ghost badge-xs shrink-0 font-normal">#{{ item.id }}</span>
                        </div>
                    </template>
                </template>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* /taskbar 唤起脉冲：主题色背景闪烁一次后回到常态底色（bg-base-100/40）。
   daisyUI 5 主题色以 --color-primary 等 CSS 变量暴露；
   prefers-reduced-motion 用户降级为无动画（展开反馈仍在） */
.taskbar-flash {
    animation: taskbar-flash 1s ease-out;
}

@keyframes taskbar-flash {
    0% {
        background-color: color-mix(in oklab, var(--color-primary) 16%, transparent);
    }

    100% {
        background-color: transparent;
    }
}

@media (prefers-reduced-motion: reduce) {
    .taskbar-flash {
        animation: none;
    }
}
</style>
