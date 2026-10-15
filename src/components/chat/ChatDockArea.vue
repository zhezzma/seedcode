<!-- 输入框上方唯一扩展挂载点：按 registry 顺序渲染各 widget，
     显隐由 widget 组件内部条件决定（无数据时根节点 v-if 不渲染）。 -->
<script setup lang="ts">
import PendingQueueBar from './PendingQueueBar.vue'
import TasklistBar from './TasklistBar.vue'
import GoalBar from './GoalBar.vue'
import { getChatDockWidgets, registerChatDockWidget } from './chat-dock-registry'

registerChatDockWidget({ id: 'pending-queue', order: 10, component: PendingQueueBar })
registerChatDockWidget({ id: 'tasklist', order: 20, component: TasklistBar })
registerChatDockWidget({ id: 'goalbar', order: 5, component: GoalBar })

const widgets = getChatDockWidgets()
</script>

<template>
    <template v-for="w in widgets" :key="w.id">
        <component :is="w.component" />
    </template>
</template>
