<!-- 输入框上方 dock 区的视频生成状态条（MusicBar 同形态）。一行 chip（运行中数量），
     点击 inline 展开逐条清单（不是浮出弹层）——状态徽标 + 描述·模型 + 停止按钮
     （在飞时可用；仅排队中的任务能在上游取消，已开始生成的本地停止仍会计费）。
     数据源 useVideoGen 模块级单例（ext.video_state 三到达线，零轮询），无视频
     任务时不渲染（dock 约定：widget 自决定显隐）；/videobar 客户端命令同源切换。 -->
<script setup lang="ts">
import { ref } from 'vue'
import { VideoCameraIcon, StopIcon, ChevronDownIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { useVideoGen } from '../../composables/useVideoGen'

const video = useVideoGen()

const stopping = ref<string | null>(null)

const statusClass = (status: string): string => {
    switch (status) {
        case 'working': return 'badge-primary'
        case 'completed': return 'badge-success badge-outline'
        case 'error': return 'badge-error badge-outline'
        case 'aborted': return 'badge-warning badge-outline'
        default: return 'badge-ghost'
    }
}

const stopVideo = async (taskId: string) => {
    if (stopping.value) return
    stopping.value = taskId
    try {
        await video.stopVideo(taskId)
    } finally {
        stopping.value = null
    }
}
</script>

<template>
    <div v-if="video.barVisible.value" class="border-t border-base-300 bg-base-100/40 px-4 py-1 text-xs select-none">
        <div class="mx-auto w-full max-w-3xl">
            <!-- 折叠条：同 MusicBar 模式——toggle 主体（flex-1 + 箭头）+ 独立 X 关闭钮。
                 X 只隐藏状态条：新提交 / 已见条目新终态 / 会话切换 / /videobar 自动恢复 -->
            <div class="flex items-center gap-1.5 py-0.5">
                <button type="button"
                    class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-base-content/70 hover:text-base-content transition-colors cursor-pointer"
                    :class="{ 'text-primary': video.workingCount.value > 0 }"
                    :aria-expanded="video.panelOpen.value" @click="video.togglePanel()">
                    <VideoCameraIcon class="h-3.5 w-3.5 shrink-0" />
                    <span class="font-medium whitespace-nowrap">{{ $t('chat.videoBar.title') }}</span>
                    <span v-if="video.workingCount.value > 0" class="text-base-content/40 truncate">
                        · {{ video.workingCount.value }} {{ $t('chat.videoBar.status.working') }}
                    </span>
                    <ChevronDownIcon class="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200"
                        :class="{ 'rotate-180': video.panelOpen.value }" />
                </button>
                <button type="button"
                    class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-base-content"
                    :title="$t('chat.videoBar.dismissHint')" :aria-label="$t('chat.videoBar.dismissHint')"
                    @click="video.dismissBar()">
                    <XMarkIcon class="h-3.5 w-3.5" />
                </button>
            </div>
            <!-- 展开逐条清单：inline 与其他 dock widget 同构（非浮出弹层）。封顶
                 max-h-64 + overflow-y-auto：任务多时面板内部滚动，不把输入框 dock 区
                 顶出屏。停止 = video-gen stop 路由（在飞时可用；停止按钮 tooltip 说明
                 仅排队中的任务能在上游取消、已开始生成的仍会计费） -->
            <div v-if="video.panelOpen.value" class="flex flex-col gap-1 pb-1.5 pt-1 max-h-64 overflow-y-auto">
                <div v-for="task in video.sortedVideos.value" :key="task.taskId"
                    class="flex items-center gap-2 rounded-lg border border-base-300 bg-base-200 px-2 py-1">
                    <span class="badge badge-xs shrink-0 font-normal" :class="statusClass(task.status)">
                        {{ $t('chat.videoBar.status.' + task.status) }}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-base-content/70"
                        :title="task.caption ? `${task.model} · ${task.caption}` : task.model">
                        {{ task.caption || task.model }}<template v-if="task.caption"> · {{ task.model }}</template>
                    </span>
                    <button v-if="task.status === 'working'" type="button" @click="stopVideo(task.taskId)"
                        class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-error"
                        :disabled="stopping !== null"
                        :title="$t('chat.videoBar.stop')">
                        <StopIcon class="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
