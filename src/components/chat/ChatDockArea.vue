<!-- 输入框上方唯一扩展挂载点：按 registry 顺序渲染各 widget，
     显隐由 widget 组件内部条件决定（无数据时根节点 v-if 不渲染）。 -->
<script setup lang="ts">
import PendingQueueBar from './PendingQueueBar.vue'
import TaskBar from './TaskBar.vue'
import GoalBar from './GoalBar.vue'
import BgAgentsBar from './BgAgentsBar.vue'
import MusicBar from './MusicBar.vue'
import VideoBar from './VideoBar.vue'
import { getChatDockWidgets, registerChatDockWidget } from './chat-dock-registry'

registerChatDockWidget({ id: 'pending-queue', order: 10, component: PendingQueueBar })
registerChatDockWidget({ id: 'bg-agents', order: 12, component: BgAgentsBar })
registerChatDockWidget({ id: 'music-bar', order: 14, component: MusicBar })
registerChatDockWidget({ id: 'video-bar', order: 15, component: VideoBar })
registerChatDockWidget({ id: 'taskbar', order: 20, component: TaskBar })
registerChatDockWidget({ id: 'goalbar', order: 5, component: GoalBar })

const widgets = getChatDockWidgets()
</script>

<template>
    <template v-for="w in widgets" :key="w.id">
        <component :is="w.component" />
    </template>
</template>
