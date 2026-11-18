<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAgentsState } from '../../composables/useAgentsState'
import { useI18n } from 'vue-i18n'
import { PencilIcon, ArrowLeftIcon, Squares2X2Icon, WrenchIcon, PuzzlePieceIcon, UserGroupIcon, DocumentTextIcon, ChatBubbleLeftRightIcon } from '@heroicons/vue/24/outline'
import ViewHeader from '../ViewHeader.vue'

// Tab components
import AgentOverview from './tabs/AgentOverview.vue'
import AgentTools from './tabs/AgentTools.vue'
import AgentSkills from './tabs/AgentSkills.vue'
import AgentSubagents from './tabs/AgentSubagents.vue'
import AgentPrompts from './tabs/AgentPrompts.vue'
import AgentFormModal from './AgentFormModal.vue'
import AgentAvatar from './AgentAvatar.vue'
import AgentTeamGroups from './AgentTeamGroups.vue'
import { TEAM_CHAT_HUB_AGENT } from '../../composables/useSessionsState'

const props = withDefaults(defineProps<{
    agentId: string
    /** 嵌入 workspace 面板等非顶层容器时置 false：隐藏整条 ViewHeader（标题/拖拽区/返回键均由容器承担） */
    showHeader?: boolean
    /** 嵌入窄容器（workspace 面板）时置 true：透传给内容 tab 组件，布局用移动端规格
     *  （网格退单列等；胶囊 tab 条自身已容器查询自适应，不消费本参数）。视口断点管不到容器宽度，
     *  桌面开面板时 lg:/md: 前缀仍生效，不传会撑爆窄面板 */
    compact?: boolean
}>(), { showHeader: true })

const emit = defineEmits<{
    (e: 'back'): void
}>()

const agentsState = useAgentsState()
const { t } = useI18n()

/** hub agent 判定（契约常量）：tabs 追加群 tab + 渲染门控双用 */
const isHub = computed(() => props.agentId === TEAM_CHAT_HUB_AGENT)



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
    { id: 'overview', label: t('agent.tab.overview'), icon: Squares2X2Icon, component: AgentOverview },
    { id: 'tools', label: t('agent.tab.tools'), icon: WrenchIcon, component: AgentTools },
    { id: 'skills', label: t('agent.tab.skills'), icon: PuzzlePieceIcon, component: AgentSkills },
    { id: 'subagents', label: t('agent.tab.subagents'), icon: UserGroupIcon, component: AgentSubagents },
    { id: 'prompts', label: t('agent.tab.prompts'), icon: DocumentTextIcon, component: AgentPrompts },
    // hub agent（team-chat-hub）＝普通 agent 配置面 + 群 tab（v7.4 去特殊化：
    // 模型/思考/工具/技能与普通 agent 同面可改，bot 继承这些配置；群 tab=
    // 群列表形态，点群进管理弹窗）
    ...(isHub.value
        ? [{ id: 'groups', label: t('agent.tab.groups'), icon: ChatBubbleLeftRightIcon, component: AgentTeamGroups }]
        : []),
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
        <!-- 顶栏：标题 + 拖拽区 + 窗口键预留；← 返回键仅移动端显示（PC 端经侧栏切换智能体）。
             嵌入 workspace 面板时不渲染：面板自己的 tab 栏承担拖拽，智能体名在内容区大头像旁已有 -->
        <ViewHeader v-if="showHeader" :title="agent?.name || 'Agent'" wc-pad>
            <template #left>
                <button class="btn btn-ghost btn-sm btn-circle lg:hidden" @click="$emit('back')" :aria-label="$t('common.back')">
                    <ArrowLeftIcon class="h-5 w-5" />
                </button>
            </template>
        </ViewHeader>
        <!-- scrollbar-gutter: stable：滚动条出现/消失不再挤压内容区宽度——
             下方 tab 条的 @sm 容器查询断点恰在边缘时，切 tab（内容长短不同
             →滚动条有无）会让整个 tab 条在「图标/图标+文字」形态间跳变；
             gutter 恒定占位后容器宽度恒定，形态稳定 -->
        <div class="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
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

                    <!-- Tabs：宽度与文字显隐都走容器查询（基准=本行容器，非视口断点），
                         侧边栏面板/移动端/整页同一套自适应：极窄(<@sm)占 90% 且只显图标，
                         中等宽度 90% 图标+文字（此时 60% 装不下图标+文字，中段回落会 truncate 咬字），
                         宽容器(≥@2xl)回落 60% 居中；各 tab flex-1 等宽平分自适应，间距 gap-1 固定 -->
                    <div class="mt-6 flex justify-center w-full @container">
                        <div role="tablist"
                            class="bg-base-300 p-1 rounded-full flex relative shadow-inner w-[90%] @2xl:w-[60%] gap-1">
                            <a role="tab" v-for="tab in tabs" :key="tab.id" :aria-label="tab.label"
                                @click="activeTab = tab.id"
                                class="flex-1 min-w-0 flex items-center justify-center gap-1.5 py-2 rounded-full text-sm font-semibold transition-all duration-300 ease-out cursor-pointer select-none"
                                :class="activeTab === tab.id ? 'bg-base-100 text-base-content shadow-sm scale-100' : 'text-base-content/55 hover:text-base-content'">
                                <component :is="tab.icon" class="h-4 w-4 shrink-0" />
                                <span class="hidden @sm:block truncate">{{ tab.label }}</span>
                            </a>
                        </div>
                    </div>
                </div>

                <!-- Content Area -->
                <div class="flex-1 bg-base-50/50 p-4 md:px-8 md:py-6">
                    <div class="w-full h-full max-w-6xl mx-auto">
                        <!-- 群 tab（hub 专用）：单独分支不进 keep-alive（列表组件，
                             切走销毁无损失）；不透传 :agent（AgentTeamGroups 不消费，
                             避免 fallthrough 污染根元素）。hub 门控双保险：tabs
                             computed 只在 hub 追加 groups 项，这里再校验一次，
                             防 activeTab 残留（跨 agent remount 靠挂载点 :key） -->
                        <AgentTeamGroups v-if="activeTab === 'groups' && isHub" :show-header="false"
                            :compact="compact" />
                        <keep-alive v-else>
                            <component :is="tabs.find(t => t.id === activeTab)?.component" :agent="agent"
                                :compact="compact" @deleted="$emit('back')" />
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
