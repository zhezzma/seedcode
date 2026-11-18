<script setup lang="ts">
/**
 * team-chat 群管理视图（v7.4 起作为 hub 的「群」tab 内嵌于 AgentDetail，右栏
 * WorkspacePanel 群 tab 与 AgentsView（经 AgentDetail）共用；hub 本体配置面
 * 已回归普通 AgentDetail——本组件只管群，不再顶替 hub 的 agent 详情）。
 *
 * 两种形态：
 * - 带 sessionId（群聊会话右栏「群管理」tab）：直接管理该群（AgentGroupManage）
 * - 无 sessionId（AgentsView 打开 hub / 右栏无群上下文）：群列表（格子卡片，
 *   样式照 AgentTools 工具卡：居中竖排图标卡，compact 时恒 2 列移动端规格）
 *   → 点选在弹窗中管理（AgentGroupManage 套 modal，不导航——列表上下文保留）
 *
 * 管理面本体在 AgentGroupManage.vue（本组件与其弹出的成员表单均只做壳）。
 */
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowPathIcon, XMarkIcon, ArrowLeftIcon, ChatBubbleLeftRightIcon } from '@heroicons/vue/24/outline'

import { useToast } from '../../composables/useToast'
import { useAgentsState, } from '../../composables/useAgentsState'
import { TEAM_CHAT_HUB_AGENT, useSessionsState } from '../../composables/useSessionsState'
import ViewHeader from '../ViewHeader.vue'
import AgentGroupManage from './AgentGroupManage.vue'

const props = withDefaults(defineProps<{
    /** 群聊会话的壳 sessionId（群聊右栏传入）；缺省=群列表形态（AgentsView） */
    sessionId?: string
    /** 嵌入 workspace 面板等非顶层容器时置 false：隐藏整条 ViewHeader（同 AgentDetail） */
    showHeader?: boolean
    /** 嵌入窄容器（workspace 面板）时置 true：网格固定移动端规格 2 列。
     *  视口断点管不到容器宽度：桌面开面板时 sm:grid-cols-3 仍生效，多卡挤在窄面板里 */
    compact?: boolean
}>(), { showHeader: true })

const emit = defineEmits<{ back: [] }>()

const { t } = useI18n()
const toast = useToast()

// ── 群列表形态（无 sessionId）──
// 单一真相：群行随 /api/sessions 统一投影进对话桶，过滤 sessionCategory==='group'
// 即得（与侧栏同一数据源；?? [] 仅初始未载的空态渲染兜底，非数据兜底）
const sessionsState = useSessionsState()
const groupList = computed(() => (sessionsState.sessionsResult?.sessions ?? []).filter(s => s.sessionCategory === 'group'))
const listLoading = ref(false)
/** 列表形态下弹窗管理的群 id；有 sessionId prop 时恒为 undefined */
const managingGroupId = ref<string | undefined>(undefined)

const loadGroups = async () => {
    listLoading.value = true
    try {
        await sessionsState.loadSessions()
    } catch (error) {
        toast.error((error as Error)?.message || String(error))
    } finally {
        listLoading.value = false
    }
}

const openManage = (id: string) => {
    managingGroupId.value = id
}

const closeManage = () => {
    managingGroupId.value = undefined
    // 弹窗内可能改了群名/头像/解散：关闭时回刷列表（管理组件内已同步侧栏群行）
    void loadGroups()
}

onMounted(() => {
    if (!props.sessionId) loadGroups()
})

// 时间格式化：格子卡窄，toLocaleString 全量时间必然截断——收敛到短格式
//（月/日 时:分；非 CronView 复用场景，本视图本地实现先例已记录）
const formatDate = (ts: string | undefined) => {
    if (!ts) return '-'
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 标题=hub agent 名（同 AgentDetail 的 agent?.name；agentsState 缺数据时兑底 tab 名）
const agentsState = useAgentsState()
const headerTitle = computed(() =>
    agentsState.agentsList?.find((a: { id: string; name?: string }) => a.id === TEAM_CHAT_HUB_AGENT)?.name
        || t('workspace.tabTeam'))
</script>

<template>
    <div class="h-full flex flex-col min-h-0">
        <!-- 顶栏：复用 ViewHeader（标题/拖拽区/窗口键预留）+ 移动端返回（同 AgentDetail）；
             嵌入 workspace 面板时不渲染：面板自己的 tab 栏承担 -->
        <ViewHeader v-if="showHeader" :title="headerTitle" wc-pad>
            <template #left>
                <button class="btn btn-ghost btn-sm btn-circle lg:hidden" @click="emit('back')" :aria-label="t('common.back')">
                    <ArrowLeftIcon class="h-5 w-5" />
                </button>
            </template>
            <template #actions>
                <div class="flex items-center gap-5">
                    <button class="btn btn-ghost btn-circle btn-xs" :disabled="listLoading"
                        :title="t('common.refresh')" @click="loadGroups">
                        <ArrowPathIcon class="w-5 h-5" :class="{ 'animate-spin': listLoading }" />
                    </button>
                </div>
            </template>
        </ViewHeader>

        <!-- ── 群列表形态（无 sessionId：AgentsView 打开 hub / 右栏无群上下文）：
             格子卡片（样式照 AgentTools 工具卡：居中竖排图标卡），点选弹窗管理。
             容器不带 padding（边距归挂载环境：AgentDetail 群 tab=内容区 p-4，
             WorkspacePanel=外层包 p-4——自带会叠成双份，比工具 tab 多一圈） ── -->
        <div v-if="!sessionId" class="flex-1 overflow-y-auto">
            <div>
                <p v-if="listLoading && groupList.length === 0" class="text-center py-8 opacity-50">
                    {{ t('common.loading') }}
                </p>
                <div v-if="!listLoading && groupList.length === 0" class="text-center py-12 opacity-50">
                    <div class="text-6xl mb-4">💬</div>
                    <p>{{ t('sidebar.groupListEmpty') }}</p>
                </div>

                <div v-else class="grid grid-cols-2 gap-4 p-1"
                    :class="compact ? '' : 'sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'">
                    <div v-for="s in groupList" :key="s.id"
                        class="card bg-base-200 border border-base-300 shadow-sm hover:shadow-md hover:border-primary transition-all cursor-pointer h-full"
                        :title="s.name" @click="openManage(s.id)">
                        <div class="card-body p-4 flex flex-col items-center text-center gap-2">
                            <!-- 图标：置顶群实底高亮 + 右上角点（同工具卡图标容器规格） -->
                            <div class="relative w-12 h-12 rounded-xl flex items-center justify-center shrink-0 mb-1 transition-colors"
                                :class="s.pinned ? 'bg-primary text-primary-content' : 'bg-primary/10 text-primary'">
                                <ChatBubbleLeftRightIcon class="w-6 h-6" />
                                <span v-if="s.pinned"
                                    class="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-primary ring-2 ring-base-200"></span>
                            </div>

                            <!-- 名称（同工具卡名称行结构；成员数在 AgentGroupManage 详情） -->
                            <div class="w-full min-w-0 flex-1 flex flex-col items-center">
                                <h3 class="font-bold text-sm truncate w-full">{{ s.name }}</h3>
                            </div>

                            <!-- 底部：更新时间（同工具卡 border-t 操作区位置） -->
                            <div class="w-full justify-center mt-2 pt-2 border-t border-base-300">
                                <span class="text-xs text-base-content/40 truncate block">{{ s.modified ?
                                    formatDate(s.modified) : '' }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- ── 右栏直管形态（群聊会话带 sessionId prop）──边距同上归挂载环境 ── -->
        <div v-else class="flex-1 overflow-y-auto">
            <AgentGroupManage :session-id="sessionId" />
        </div>

        <!-- ── 列表形态点选 → 管理弹窗 ── -->
        <Teleport to="body">
            <dialog v-if="!sessionId && managingGroupId" class="modal modal-open z-[210]">
                <button class="modal-backdrop" type="button" :aria-label="t('common.close')" @click="closeManage"></button>
                <div class="modal-box max-w-2xl bg-base-100 w-full p-4">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="font-bold text-lg">{{ t('workspace.tabTeam') }}</h3>
                        <button class="btn btn-sm btn-circle btn-ghost" :aria-label="t('common.close')" @click="closeManage">
                            <XMarkIcon class="w-5 h-5" />
                        </button>
                    </div>
                    <div class="max-h-[65vh] overflow-y-auto">
                        <AgentGroupManage :session-id="managingGroupId" />
                    </div>
                </div>
            </dialog>
        </Teleport>
    </div>
</template>
