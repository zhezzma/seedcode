<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAgentsState } from '../composables/useAgentsState'
import { useUiSettingsStore } from '@/stores/setting'
import { useI18n } from 'vue-i18n'

// Components
import AgentSidebar from '../components/agents/AgentSidebar.vue'
import AgentDetail from '../components/agents/AgentDetail.vue'
import AgentFormModal from '../components/agents/AgentFormModal.vue'

const router = useRouter()
const route = useRoute()
const agentsState = useAgentsState()
const settingsStore = useUiSettingsStore()
const { t } = useI18n()

const showAddModal = ref(false)

// Selected Agent from Query Params - this is the source of truth for navigation state
const selectedAgentId = computed(() => {
    return (route.query.agentId as string) || undefined
})

const selectAgent = (agentId: string) => {
    // Update URL query parameter
    router.push({ query: { ...route.query, agentId } })
}

const clearSelection = () => {
    // 返回列表（移动端）：上一条历史就是本页列表时用 back() 弹栈；
    // replace 会改写当前项而非回退，栈里留下重复列表页，列表页需按两次返回才能退出。
    // 深链直达详情时无列表历史可回，才 replace 清掉 agentId
    const backPath = (window.history.state as any)?.back
    if (typeof backPath === 'string' && backPath.split('?')[0] === route.path) {
        router.back()
    } else {
        const query = { ...route.query }
        delete query.agentId
        router.replace({ query })
    }
}

const handleAgentCreated = async (newAgentId: string) => {
    selectAgent(newAgentId)
    showAddModal.value = false
}

// Default selection logic for Desktop
// If no agent selected and we have agents, select the first one on large screens
watch(() => [agentsState.agentsList, route.query.agentId], ([agentsList, currentId]) => {
    const isDesktop = window.matchMedia('(min-width: 1024px)').matches
    const agents = agentsList as any[]

    if (isDesktop && !currentId && agents && agents.length > 0) {
        const firstId = agents[0].id
        router.replace({ query: { ...route.query, agentId: firstId } })
    }
}, { immediate: true })

</script>

<template>
    <!-- Simplified Master-Detail Layout -->
    <div class="flex h-full w-full overflow-hidden">

        <!-- Sidebar Container -->
        <!-- 
            Mobile: 
                - If !selectedAgentId: Visible (w-full)
                - If selectedAgentId: Hidden
            Desktop (lg):
                - Always Visible (w-80)
        -->
        <div class="h-full bg-base-200/40 flex flex-col shrink-0" :class="[
            selectedAgentId ? 'hidden lg:flex lg:w-80' : 'w-full lg:w-80 flex'
        ]">
            <AgentSidebar :agents="agentsState.agentsList || []" :selectedId="selectedAgentId ?? null"
                @select="selectAgent" @add="showAddModal = true" />
        </div>

        <!-- Detail Container -->
        <!-- 
            Mobile:
                - If !selectedAgentId: Hidden
                - If selectedAgentId: Visible (w-full)
            Desktop (lg):
                - Always Visible (flex-1)
        -->
        <div class="h-full flex flex-col min-w-0" :class="[
            selectedAgentId ? 'w-full flex lg:flex-1' : 'hidden lg:flex lg:flex-1'
        ]">

            <!-- v7.4：hub agent（team-chat-hub）去特殊化——同一 AgentDetail
                 （+群 tab，见 AgentDetail tabs），模型/思考/工具/技能与普通
                 agent 同面可改，bot 继承 hub 配置。:key=agentId 跨 agent 强
                 remount（防 hub 的 groups activeTab 残留到普通 agent——
                 WorkspacePanel 同策略） -->
            <AgentDetail v-if="selectedAgentId" :key="selectedAgentId" :agent-id="selectedAgentId" @back="clearSelection"
                class="flex-1 overflow-hidden" />

            <!-- Empty State for Desktop (if no selection) -->
            <div v-else class="hidden lg:flex flex-1 items-center justify-center text-base-content/40">
                <div class="text-center">
                    <div class="text-6xl mb-4">🤖</div>
                    <h3 class="text-xl font-bold mb-2">{{ $t('agent.noAgentSelected') }}</h3>
                    <p>{{ $t('agent.selectAgentPrompt') }}</p>
                </div>
            </div>
        </div>

        <!-- Add Modal -->
        <AgentFormModal :show="showAddModal" mode="add" @close="showAddModal = false" @saved="handleAgentCreated" />
    </div>
</template>

<style scoped>
/* Custom transitions for smooth master-detail switch on mobile could be added here if needed, 
   but simplistic v-if/class toggling is usually robust enough. */
</style>
