<script setup lang="ts">
/**
 * 群任务历史 tab（AgentGroupManage 第一 tab；v7.3）：
 * 在飞 + 历史全量代理任务（GroupTurnTask durable 任务面）——GET
 * /groups/:id/tasks 分页列表（新→旧；queue 位置标注），点击任务拉详情
 * （成员执行面：子会话映射）后复用 SubagentTraceDrawer 看执行过程
 * （traceUrl 自定义轨迹源 = /tasks/:id/trace/:memberKey，侧车同契约；
 * managedConfig: false 隐藏模型配置行）。
 *
 * 刷新到达线：挂载 / 手动 / ext.team_state 回合边界（每回合终态后列表变化）。
 * 任务卡形态同 CronView 任务卡（card bg-base-200 border border-base-300 +
 * 状态点 + 徽标 + border-t 底行）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowPathIcon, ChevronRightIcon, ClipboardDocumentListIcon, UserIcon } from '@heroicons/vue/24/outline'

import { apiGet } from '../../composables/api-client'
import { useToast } from '../../composables/useToast'
import { onExtensionEvent } from '../../composables/extension-events'
import { useSubagentTrace } from '../../composables/useSubagentTrace'
import { TEAM_STATE_EVENT } from '../../composables/useSessionsState'

export interface GroupTaskItem {
    taskId: string
    message: string
    speakerName: string
    picks: string[]
    relayDepth: number
    status: string
    outcome?: string
    error?: string
    startedAt?: number
    endedAt?: number
    queuePosition?: number
}

interface GroupTaskDetail {
    taskId: string
    message: string
    status: string
    outcome?: string
    members: Array<{ key: string; name: string; memory: boolean; childSession?: string }>
}

const props = defineProps<{
    /** 群壳 sessionId */
    sessionId: string
    /** 成员名册（picks key → 显示名；群详情同源） */
    members: Array<{ key: string; name: string }>
}>()

const { t } = useI18n()
const toast = useToast()
const trace = useSubagentTrace()

const loading = ref(false)
const tasks = ref<GroupTaskItem[]>([])
const nextCursor = ref<Record<string, unknown> | undefined>(undefined)
/** 展开点击中的任务 id（请求在途指示） */
const openingTaskId = ref('')

const memberName = (key: string): string =>
    props.members.find(m => m.key === key)?.name ?? key

/** 状态投影：durable status/outcome → 展示面（label + 状态点色 + 徽标色） */
function statusOf(task: GroupTaskItem): { label: string, dot: string, badge: string } {
    if (task.status === 'terminal') {
        switch (task.outcome) {
            case 'completed': return { label: t('groupTasks.statusCompleted'), dot: 'bg-success', badge: 'badge-success' }
            case 'aborted': return { label: t('groupTasks.statusAborted'), dot: 'bg-warning', badge: 'badge-warning' }
            case 'failed': return { label: t('groupTasks.statusFailed'), dot: 'bg-error', badge: 'badge-error' }
            default: return { label: t('groupTasks.statusOrphaned'), dot: 'bg-error', badge: 'badge-error' }
        }
    }
    if (task.status === 'waiting' || task.status === 'pending') {
        return { label: t('groupTasks.statusQueued'), dot: 'bg-base-content/40', badge: 'badge-ghost' }
    }
    return { label: t('groupTasks.statusRunning'), dot: 'bg-primary animate-pulse', badge: 'badge-primary' }
}

const hasMore = computed(() => nextCursor.value !== undefined)

// 无感续载：列表尾部哨兵进入视口即拉下一页（IntersectionObserver 不依赖具体
// 滚动容器——右栏面板/弹窗/整页都能工作）。IO 只在 threshold 越界（0↔非0）时
// 回调：追加一页后哨兵仍留在视口内时 ratio 不变不再触发——load 完成后若
// hasMore 且哨兵仍可见则主动续拉一轮（v7.4.3 评审 C-I2，否则旧页永久不可达）
const sentinelRef = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

/** 哨兵当前是否在视口内（含 rootMargin 前瞻区）——追加后仍可见则续拉 */
const sentinelVisible = () => {
    const el = sentinelRef.value
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return rect.top < window.innerHeight + 200 && rect.bottom > -200
}

onMounted(() => {
    void load()
    observer = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting) && hasMore.value && !loading.value) {
            void load(true)
        }
    }, { rootMargin: '200px' })
    watch(sentinelRef, (el) => {
        observer?.disconnect()
        if (el) observer?.observe(el)
    }, { immediate: true })
})

onUnmounted(() => {
    observer?.disconnect()
    unsubscribe()
})

function formatTime(ts?: number): string {
    if (!ts) return ''
    return new Date(ts).toLocaleString()
}

/** 时长（ms → 人话；在飞任务=now-ended） */
function formatDuration(task: GroupTaskItem): string {
    if (!task.startedAt) return ''
    const end = task.endedAt ?? Date.now()
    const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000))
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
    return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

const load = async (append = false) => {
    if (!props.sessionId || loading.value) return
    loading.value = true
    try {
        const query = append && nextCursor.value !== undefined
            ? `?cursor=${encodeURIComponent(JSON.stringify(nextCursor.value))}`
            : ''
        const result = await apiGet<{ tasks: GroupTaskItem[], nextCursor?: Record<string, unknown> }>(
            `/api/extensions/team-chat/groups/${encodeURIComponent(props.sessionId)}/tasks${query}`,
        )
        tasks.value = append ? [...tasks.value, ...result.tasks] : result.tasks
        nextCursor.value = result.nextCursor
    } catch (error) {
        toast.error((error as Error)?.message || t('groupTasks.loadFailed'))
    } finally {
        loading.value = false
        // 在途期间到达的回合边界事件不丢弃（评审 C-I2：丢事件=任务卡停在
        // 「执行中」直到下个事件/手动刷新）：补刷一次
        if (refreshPending) {
            refreshPending = false
            void load()
        }
    }
}

/** 在途载期间到达的事件补刷标记（load finally 消费） */
let refreshPending = false

// 回合边界刷新（每回合终态/接力建链后任务面变化；群切走时静默）
const unsubscribe = onExtensionEvent(TEAM_STATE_EVENT, (_data, key) => {
    if (key !== props.sessionId) return
    if (loading.value) {
        refreshPending = true
        return
    }
    void load()
})

/** 点击任务：拉详情 → 复用轨迹抽屉（tab=有子会话的成员） */
const openTask = async (task: GroupTaskItem) => {
    if (openingTaskId.value) return
    openingTaskId.value = task.taskId
    try {
        const detail = await apiGet<GroupTaskDetail>(
            `/api/extensions/team-chat/groups/${encodeURIComponent(props.sessionId)}/tasks/${task.taskId}`,
        )
        const withSession = detail.members.filter(m => m.childSession)
        if (withSession.length === 0) {
            toast.info(t('groupTasks.noTrace'), 3000)
            return
        }
        // subId（=childSession）→ memberKey：traceUrl 端点按成员键寻址；
        // 映射缺失（防御分支，正常不可达）走 noTrace 提示而非静默 404
        const keyBySession = new Map(withSession.map(m => [m.childSession!, m.key]))
        // 抽屉 statusBadge/traceActive 词表收敛：orphaned/未知终态 → 'error'
        //（直传会让 traceActive 判非终态→尾条永久假流式，评审 C-I1）
        const drawerStatus = task.status === 'terminal'
            ? (task.outcome === 'completed' ? 'completed' : task.outcome === 'aborted' ? 'aborted' : 'error')
            : (task.status === 'waiting' || task.status === 'pending' ? 'idle' : 'working')
        trace.open(props.sessionId, withSession.map(m => ({
            subagentSessionId: m.childSession,
            agent: m.name,
            status: drawerStatus,
        })), withSession[0]!.childSession, {
            traceUrl: (subId, offset) => {
                const memberKey = keyBySession.get(subId)
                if (memberKey === undefined) throw new Error(t('groupTasks.noTrace'))
                return `/api/extensions/team-chat/groups/${encodeURIComponent(props.sessionId)}/tasks/${task.taskId}/trace/${encodeURIComponent(memberKey)}?offset=${offset}`
            },
            managedConfig: false,
        })
    } catch (error) {
        toast.error((error as Error)?.message || t('groupTasks.loadFailed'))
    } finally {
        openingTaskId.value = ''
    }
}
</script>

<template>
    <section class="space-y-3">
        <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
                <ClipboardDocumentListIcon class="w-5 h-5 text-primary" />
                <h3 class="text-sm font-bold">{{ t('groupTasks.title') }}</h3>
                <div class="badge badge-sm font-mono badge-primary">{{ tasks.length }}</div>
            </div>
            <button class="btn btn-ghost btn-xs btn-square" :disabled="loading" :title="t('common.refresh')"
                @click="load()">
                <ArrowPathIcon class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
            </button>
        </div>

        <!-- 空态 -->
        <div v-if="!loading && tasks.length === 0"
            class="card bg-base-200 border border-base-300 shadow-sm">
            <div class="card-body p-6 items-center text-center gap-1">
                <ClipboardDocumentListIcon class="w-8 h-8 opacity-30" />
                <p class="text-sm text-base-content/60">{{ t('groupTasks.empty') }}</p>
            </div>
        </div>

        <!-- 任务卡（CronView 任务卡形态：状态点 + 主体 + 徽标 + border-t 底行） -->
        <button v-for="task in tasks" :key="task.taskId" type="button" class="card bg-base-200 border border-base-300 shadow-sm text-left w-full hover:border-primary/40 transition-colors cursor-pointer"
            :class="{ 'opacity-60': openingTaskId === task.taskId }"
            @click="openTask(task)">
            <div class="card-body p-3 sm:p-4 gap-2">
                <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2 min-w-0">
                        <div class="w-2 h-2 rounded-full shrink-0" :class="statusOf(task).dot"></div>
                        <span class="font-bold text-sm truncate">{{ task.message }}</span>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                        <span v-if="task.queuePosition !== undefined" class="badge badge-ghost badge-xs font-mono">
                            #{{ task.queuePosition }}
                        </span>
                        <span class="badge badge-xs" :class="statusOf(task).badge">{{ statusOf(task).label }}</span>
                        <ChevronRightIcon class="w-3.5 h-3.5 text-base-content/40" />
                    </div>
                </div>
                <p v-if="task.error" class="text-xs text-error line-clamp-2">{{ task.error }}</p>
                <div class="flex items-center justify-between gap-2 pt-2 border-t border-base-300 text-xs text-base-content/50">
                    <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
                        <UserIcon class="w-3 h-3 shrink-0" />
                        <span class="truncate">{{ task.speakerName }}</span>
                        <span>→</span>
                        <span v-for="pick in task.picks" :key="pick"
                            class="badge badge-ghost badge-xs font-normal max-w-32 truncate">
                            {{ memberName(pick) }}
                        </span>
                        <span v-if="task.relayDepth > 0" class="badge badge-outline badge-xs font-normal">
                            {{ t('groupTasks.relayDepth', { depth: task.relayDepth }) }}
                        </span>
                    </div>
                    <div class="shrink-0 flex items-center gap-2 font-mono">
                        <span v-if="formatDuration(task)">{{ formatDuration(task) }}</span>
                        <span>{{ formatTime(task.startedAt ?? task.endedAt) }}</span>
                    </div>
                </div>
            </div>
        </button>

        <!-- 尾部哨兵：进入视口自动续载下一页（无感分页，无按钮） -->
        <div v-if="hasMore" ref="sentinelRef" class="flex justify-center py-2">
            <span v-if="loading" class="loading loading-dots loading-xs text-base-content/40"></span>
        </div>
    </section>
</template>
