<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAgentsState } from '../../composables/useAgentsState'
import { useI18n } from 'vue-i18n'
import { PencilIcon } from '@heroicons/vue/24/outline'
import { ArrowLeftIcon } from '@heroicons/vue/24/outline'
import ViewHeader from '../ViewHeader.vue'

// Tab components
import AgentOverview from './tabs/AgentOverview.vue'
import AgentTools from './tabs/AgentTools.vue'
import AgentSkills from './tabs/AgentSkills.vue'
import AgentSubagents from './tabs/AgentSubagents.vue'
import AgentPrompts from './tabs/AgentPrompts.vue'
import AgentFormModal from './AgentFormModal.vue'
import AgentAvatar from './AgentAvatar.vue'

const props = defineProps<{
    agentId: string
}>()

const emit = defineEmits<{
    (e: 'back'): void
}>()

const agentsState = useAgentsState()
const { t } = useI18n()



// Get full agent object from agentsState
const agent = computed(() => {
    const list = agentsState.agentsList || []
    const rawAgent = list.find((a: any) => a.id === props.agentId)
    if (!rawAgent) return null

    return {
        ...rawAgent,
        name: rawAgent.name || rawAgent.id,
        description: (rawAgent as any).description || '',
        isDefault: false, // TODO: compare with actual default agent id if available
    }
})

// Get raw agent data for editing
const rawAgentData = computed(() => {
    const list = agentsState.agentsList || []
    return list.find((a: any) => a.id === props.agentId)
})

// Tab navigation state
const activeTab = ref('overview')

const tabs = computed(() => [
    { id: 'overview', label: t('agent.tab.overview'), component: AgentOverview },
    { id: 'tools', label: t('agent.tab.tools'), component: AgentTools },
    { id: 'skills', label: t('agent.tab.skills'), component: AgentSkills },
    { id: 'subagents', label: t('agent.tab.subagents'), component: AgentSubagents },
    { id: 'prompts', label: t('agent.tab.prompts'), component: AgentPrompts },
])

// Edit modal state
const showEditModal = ref(false)

const openEditModal = () => {
    showEditModal.value = true
}

const handleAgentSaved = async () => {
    await agentsState.loadAgents()
    showEditModal.value = false
}
</script>

<template>
    <div class="h-full w-full relative flex flex-col">
        <!-- 顶栏：标题 + 拖拽区 + 窗口键预留；← 返回键仅移动端显示（PC 端经侧栏切换智能体） -->
        <ViewHeader :title="agent?.name || 'Agent'" wc-pad>
            <template #left>
                <button class="btn btn-ghost btn-sm btn-circle lg:hidden" @click="$emit('back')" :aria-label="$t('common.back')">
                    <ArrowLeftIcon class="h-5 w-5" />
                </button>
            </template>
        </ViewHeader>
        <div class="flex-1 min-h-0 overflow-y-auto">
            <div v-if="agent" class="min-h-full flex flex-col ">
                <!-- Detail Header -->
                <div class="px-2 lg:px-6 py-6 border-b border-base-300 sticky top-0 z-30  backdrop-blur-sm">
                    <div class="flex flex-col items-center gap-4">
                        <!-- Avatar with Edit Button -->
                        <div class="relative shrink-0 group">
                            <AgentAvatar :avatar="agent.avatar" :name="agent.name" size="lg"
                                class="shadow-sm ring-4 ring-base-100" />
                            <!-- Edit Button -->
                            <button @click="openEditModal"
                                class="absolute -bottom-1 -right-1 btn btn-circle btn-xs btn-primary shadow-md group-hover:opacity-100 transition-opacity">
                                <PencilIcon class="w-3 h-3" />
                            </button>
                        </div>

                        <!-- Info -->
                        <div class="flex-1 text-center space-y-1.5 min-w-0">
                            <div class="flex flex-row items-center gap-2 justify-center">
                                <h1 class="text-xl lg:text-2xl font-bold tracking-tight truncate max-w-full">{{
                                    agent.name
                                    }}
                                </h1>
                                <!-- Compact ID & Default Badge -->
                                <div class="flex items-center gap-2">
                                    <div class="badge badge-ghost badge-sm font-mono opacity-60 text-xs shrink-0 max-w-[10ch] overflow-hidden align-middle"
                                        :title="agent.id">
                                        <span class="block truncate whitespace-nowrap">{{ agent.id }}</span>
                                    </div>
                                    <div v-if="agent.isDefault" class="badge badge-primary badge-xs">{{
                                        $t('agent.default')
                                        }}</div>
                                </div>
                            </div>

                            <p class="text-base-content/60 text-sm leading-relaxed max-w-2xl mx-auto">{{
                                agent.description || '这个智能体还很神秘，没有描述。' }}</p>
                        </div>
                    </div>

                    <!-- Tabs -->
                    <div class="mt-6 flex justify-center w-full">
                        <div role="tablist"
                            class="bg-base-200/50 p-1 rounded-full inline-flex relative shadow-inner max-w-full overflow-x-auto scrollbar-hidden">
                            <a role="tab" v-for="tab in tabs" :key="tab.id" @click="activeTab = tab.id"
                                class="px-0 lg:px-10 py-2 rounded-full text-sm font-semibold transition-all duration-300 ease-out cursor-pointer select-none text-center min-w-[3.5rem] whitespace-nowrap shrink-0"
                                :class="activeTab === tab.id ? 'bg-base-200 text-primary shadow-sm scale-100' : 'text-base-content/60 hover:text-base-content/80 hover:bg-base-200/30'">
                                {{ tab.label }}
                            </a>
                        </div>
                    </div>
                </div>

                <!-- Content Area -->
                <div class="flex-1 bg-base-50/50 p-4 md:px-8 md:py-6">
                    <div class="w-full h-full max-w-6xl mx-auto">
                        <keep-alive>
                            <component :is="tabs.find(t => t.id === activeTab)?.component" :agent="agent"
                                @deleted="$emit('back')" />
                        </keep-alive>
                    </div>
                </div>
            </div>

            <!-- Empty State (Agent Not Found) -->
            <div v-else class="h-full flex items-center justify-center">
                <div class="text-center">
                    <h3 class="font-bold text-lg">{{ $t('agent.notFound') }}</h3>
                    <p class="text-base-content/60">{{ $t('agent.configNotFound', { id: agentId }) }}</p>
                </div>
            </div>

        </div>

        <!-- Edit Agent Modal -->
        <AgentFormModal :show="showEditModal" mode="edit" :agent-data="rawAgentData" @close="showEditModal = false"
            @saved="handleAgentSaved" />
    </div>
</template>
