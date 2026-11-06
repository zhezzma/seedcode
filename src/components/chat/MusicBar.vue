<!-- 输入框上方 dock 区的音乐生成状态条（BgAgentsBar 同形态）。一行 chip（运行中数量），
     点击 inline 展开逐曲清单（不是浮出弹层）——状态徽标 + 描述·提供商 + 停止按钮
     （在飞时可用）。无轨迹入口（音乐生成无轨迹数据）。数据源 useMusicGen 模块级
     单例（ext.music_state 三到达线，零轮询），无音乐任务时不渲染（dock 约定：
     widget 自决定显隐）。 -->
<script setup lang="ts">
import { ref } from 'vue'
import { MusicalNoteIcon, StopIcon, ChevronDownIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { useMusicGen } from '../../composables/useMusicGen'

const music = useMusicGen()

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

const stopMusic = async (taskId: string) => {
    if (stopping.value) return
    stopping.value = taskId
    try {
        await music.stopMusic(taskId)
    } finally {
        stopping.value = null
    }
}
</script>

<template>
    <div v-if="music.barVisible.value" class="border-t border-base-300 bg-base-100/40 px-4 py-1 text-xs select-none">
        <div class="mx-auto w-full max-w-3xl">
            <!-- 折叠条：同 TaskBar 模式——toggle 主体（flex-1 + 箭头）+ 独立 X 关闭钮。
                 X 只隐藏状态条：新提交 / 已见曲目新终态 / 会话切换自动恢复 -->
            <div class="flex items-center gap-1.5 py-0.5">
                <button type="button"
                    class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-base-content/70 hover:text-base-content transition-colors cursor-pointer"
                    :class="{ 'text-primary': music.workingCount.value > 0 }"
                    :aria-expanded="music.panelOpen.value" @click="music.togglePanel()">
                    <MusicalNoteIcon class="h-3.5 w-3.5 shrink-0" />
                    <span class="font-medium whitespace-nowrap">{{ $t('chat.musicBar.title') }}</span>
                    <span v-if="music.workingCount.value > 0" class="text-base-content/40 truncate">
                        · {{ music.workingCount.value }} {{ $t('chat.musicBar.status.working') }}
                    </span>
                    <ChevronDownIcon class="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200"
                        :class="{ 'rotate-180': music.panelOpen.value }" />
                </button>
                <button type="button"
                    class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-base-content"
                    :title="$t('chat.musicBar.dismissHint')" :aria-label="$t('chat.musicBar.dismissHint')"
                    @click="music.dismissBar()">
                    <XMarkIcon class="h-3.5 w-3.5" />
                </button>
            </div>
            <!-- 展开逐曲清单：inline 与其他 dock widget 同构（非浮出弹层）。
                 停止 = audio-gen stop 路由（在飞时可用） -->
            <div v-if="music.panelOpen.value" class="flex flex-col gap-1 pb-1.5 pt-1">
                <div v-for="task in music.sortedMusics.value" :key="task.taskId"
                    class="flex items-center gap-2 rounded-lg border border-base-300 bg-base-200 px-2 py-1">
                    <span class="badge badge-xs shrink-0 font-normal" :class="statusClass(task.status)">
                        {{ $t('chat.musicBar.status.' + task.status) }}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-base-content/70"
                        :title="task.caption ? `${task.provider} · ${task.caption}` : task.provider">
                        {{ task.caption || task.provider }}<template v-if="task.caption"> · {{ task.provider }}</template>
                    </span>
                    <button v-if="task.status === 'working'" type="button" @click="stopMusic(task.taskId)"
                        class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-error"
                        :disabled="stopping !== null"
                        :title="$t('chat.musicBar.stop')">
                        <StopIcon class="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
