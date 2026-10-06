<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
    PlusIcon,
    ChevronDoubleLeftIcon,
    ChevronDoubleRightIcon,
    TrashIcon,
    HashtagIcon,
    FolderOpenIcon,
    ArrowLeftStartOnRectangleIcon,
    ArrowRightStartOnRectangleIcon,
} from '@heroicons/vue/24/outline'
import { FolderIcon } from '@heroicons/vue/24/solid'
import { SIDEBAR_ITEMS } from '../config/navigation'
import { isDesktopTauri } from '../utils/environment'
import SessionActionMenu from './chat/SessionActionMenu.vue'
import SessionInfoModal from './chat/SessionInfoModal.vue'
import GatewaySwitcher from './GatewaySwitcher.vue'

import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { NEW_SESSION_ROUTE_NAME } from '../utils/route-helpers'


import { SessionRow, useSessionsState } from '../composables/useSessionsState'
import { useChatState } from '../composables/useChatState'
import { useAgentsState } from '../composables/useAgentsState'
import { useNavActive } from '../composables/useNavActive'
import { useUiSettingsStore } from '../stores/setting'
import { useI18n } from 'vue-i18n'
import { truncateText } from '../utils/format'

type SessionMenuItem = {
    key: string
    label: string
    tone?: 'default' | 'danger'
}

// 侧栏会话列表 tab：对话 / 计划 / 归档 / 回收站
export type SidebarSessionTab = 'chats' | 'plans' | 'archived' | 'trash'

const sessionTab = ref<SidebarSessionTab>('chats')

// 胶囊分段控件的 tab 配置（纯文字：窄侧栏里四档加图标会被挤到截断，标签自解释）
const SESSION_TABS: Array<{ key: SidebarSessionTab, labelKey: string }> = [
    { key: 'chats', labelKey: 'sidebar.tabChats' },
    { key: 'plans', labelKey: 'sidebar.tabPlans' },
    { key: 'archived', labelKey: 'sidebar.tabArchived' },
    { key: 'trash', labelKey: 'sidebar.tabTrash' },
]

// 需懒加载的 tab 与对应 loader（loader 失败返回 null，据此移除标记下次重试）；
// chats 不在此列：数据由启动链 useAppInit.loadSessions 加载，无需懒加载
const TAB_LOADERS: Partial<Record<SidebarSessionTab, () => Promise<unknown>>> = {
    plans: () => sessionsState.loadTaskSessions(),
    archived: () => sessionsState.loadArchivedSessions(),
    trash: () => sessionsState.loadDeletedSessions(),
}
// 已懒加载过的 tab；失败不标记，下次切换重试
const loadedTabs = new Set<SidebarSessionTab>()
// 在途懒加载的 tab 集合：spinner 跟随当前显示 tab 的在途状态，
// 避免并发切换时先完成的 loader 把仍在途 tab 的 spinner 提前关掉
const loadingTabs = reactive(new Set<SidebarSessionTab>())
// 当前 tab 是否首次加载在途
const tabLoading = computed(() => loadingTabs.has(sessionTab.value))

const switchSessionTab = async (tab: SidebarSessionTab) => {
    sessionTab.value = tab
    const loader = TAB_LOADERS[tab]
    if (!loader || loadedTabs.has(tab)) return
    loadedTabs.add(tab)
    loadingTabs.add(tab)
    try {
        // loader 失败返回 null（桶保持旧值）；成功返回结果（含空列表）
        if (await loader() == null) {
            loadedTabs.delete(tab)
        }
    } catch {
        // loader 违约 reject 时同样释放标记，允许下次重试
        loadedTabs.delete(tab)
    } finally {
        loadingTabs.delete(tab)
    }
}

const route = useRoute()
const router = useRouter()
const { confirm } = useConfirm()
const toast = useToast()

const sessionsState = useSessionsState()
const chatState = useChatState()
const agentsState = useAgentsState()

// 行内重命名状态
const renamingKey = ref<string | null>(null)
const renameText = ref('')
const renameOriginal = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)
const setRenameInput = (el: unknown) => {
    renameInputRef.value = (el as HTMLInputElement) || null
}

// 会话信息弹窗状态
const infoModalOpen = ref(false)
const infoLoading = ref(false)
const infoSession = ref<SessionRow | null>(null)
const { t } = useI18n()
const configStore = useUiSettingsStore()

const isCollapsed = computed(() => configStore.isSidebarCollapsed)

const toggleCollapsed = () => {
    configStore.toggleSidebarCollapsed()
}

// Active session key: prefer chatState (reactive), fallback to route param
const activeSessionKey = computed(() => {
    return chatState.sessionKey || (route.params.sessionkey as string) || ''
})

// ---------- 侧栏 tab 跟随当前会话 ----------
// 通知点击/路由跳转 /chat/:id 后，tab 自动切到该会话所属桶。
// key 所属桶（桶间互斥由 moveSessionToRouteState 保证）；
// 桶未加载或无此会话时返回 null，不盲切
const sessionTabOfKey = (key: string): SidebarSessionTab | null => {
    if (sessionsState.sessionsResult?.sessions?.some(s => s.id === key)) return 'chats'
    if (sessionsState.taskSessionsResult?.sessions?.some(s => s.id === key)) return 'plans'
    if (sessionsState.archivedSessionsResult?.sessions?.some(s => s.id === key)) return 'archived'
    if (sessionsState.deletedSessionsResult?.sessions?.some(s => s.id === key)) return 'trash'
    return null
}

// 每次会话跳转只跟随一次：之后用户手动切到其他 tab 浏览不被拉回。
// 冷启动点通知时桶数据由 setSessionKey → getSessionById 单查回填，
// 命中晚于路由跳转，因此同时监听三桶引用变化补切
let followedKey: string | null = null
watch([activeSessionKey, () => sessionsState.sessionsResult, () => sessionsState.taskSessionsResult, () => sessionsState.archivedSessionsResult, () => sessionsState.deletedSessionsResult], () => {
    const key = activeSessionKey.value
    if (!key || followedKey === key) return
    const tab = sessionTabOfKey(key)
    if (!tab) return
    followedKey = key
    if (tab !== sessionTab.value) void switchSessionTab(tab)
})


// 会话行的统一渲染投影（四桶共用）
type DisplaySession = {
    key: string
    label: string
    pinned: boolean
    archived: boolean
    /** 分组键用 agentId：显示名可重复/可改，不能作为分组身份 */
    agentId: string
    agent: string
    /** 软删会话被活会话 fork 引用的次数（仅回收站桶，> 0 = 清空时保留） */
    referencedBy: number
}

// agent 显示名：任务会话接口只带 agentId 不带 agentName，本地从 agent 列表解析。
// 取 name（如「万能助手」），与对话 tab 直接显示 agentName 的结果保持一致
const agentDisplayName = (s: SessionRow): string => {
    if (s.agentName) return s.agentName
    const agent = agentsState.agentsList?.find(a => a.id === s.agentId)
    return agent?.name || s.agentId || ''
}

// 当前 tab 展示的会话列表（回收站行不显示置顶标记——置顶对软删会话无意义）
const displaySessions = computed<DisplaySession[]>(() => {
    const raw = sessionTab.value === 'chats'
        ? sessionsState.sessionsResult?.sessions
        : sessionTab.value === 'plans'
            ? sessionsState.taskSessionsResult?.sessions
            : sessionTab.value === 'trash'
                ? sessionsState.deletedSessionsResult?.sessions
                : sessionsState.archivedSessionsResult?.sessions
    return raw?.map((s: SessionRow) => ({
        key: s.id,
        label: s?.name || '新对话',
        pinned: sessionTab.value !== 'trash' && Boolean(s.pinned),
        archived: Boolean(s.archived),
        agentId: s.agentId || '',
        agent: agentDisplayName(s),
        referencedBy: sessionTab.value === 'trash' ? (s.referencedBy ?? 0) : 0,
    })) ?? []
})

// ---------- 按 agent 分组显示 ----------
// 开关持久化到 UI 设置（localStorage），刷新后保留
const groupByAgent = computed(() => configStore.isSidebarGrouped)
const toggleGroupByAgent = () => {
    configStore.toggleSidebarGrouped()
}

// agent 创建时间毫秒数（后端 /api/agents 同规则：缺失按 0），用于组固定排序
const agentCreatedAtMs = (agentId: string): number => {
    const createdAt = agentsState.agentsList?.find(a => a.id === agentId)?.createdAt
    return createdAt ? new Date(createdAt).getTime() : 0
}

// 分组模型：按 agentId 分组（同名 agent 不合并）；
// 组头显示 agent 显示名，无 agent 的会话归入「未分组」组
const sessionGroups = computed(() => {
    const groups: Array<{ key: string, label: string, sessions: DisplaySession[] }> = []
    const indexOf = new Map<string, number>()
    for (const session of displaySessions.value) {
        const idx = indexOf.get(session.agentId)
        if (idx !== undefined) {
            groups[idx].sessions.push(session)
            continue
        }
        indexOf.set(session.agentId, groups.length)
        groups.push({
            key: session.agentId,
            label: session.agent || t('sidebar.ungrouped'),
            sessions: [session],
        })
    }
    // 组顺序固定不漂移：按 agent 创建时间从早到晚（与后端 agent 列表排序一致），
    // 「未分组」组（key 为空）永远最后；同刻/缺失时退回显示名拼音（agentId 决胜）。
    // 若按首现顺序（时间倒序），任一 agent 有会话更新其组就会跳到最上面；
    // 组内会话仍保持时间倒序不变
    return groups.sort((a, b) => {
        if (!a.key) return 1
        if (!b.key) return -1
        const byCreated = agentCreatedAtMs(a.key) - agentCreatedAtMs(b.key)
        if (byCreated !== 0) return byCreated
        return a.label.localeCompare(b.label, 'zh') || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    })
})

// 列表渲染模型：分组开 → 组头与行交错；关 → 纯行。
// 组头/行共用一个 v-for，行模板无需按两种视图复制
type SessionGroupItem = { kind: 'group', key: string, label: string, groupKey: string }
type SessionRowItem = { kind: 'session', key: string, label: string, pinned: boolean, archived: boolean, referencedBy: number }
type SessionListItem = SessionGroupItem | SessionRowItem
const toSessionItem = (session: DisplaySession): SessionRowItem => ({
    kind: 'session',
    key: session.key,
    label: session.label,
    pinned: session.pinned,
    archived: session.archived,
    referencedBy: session.referencedBy,
})

// 组的展开/收起状态：按 tab 独立记忆互不干扰（仅会话内记忆，不持久化）；
// 点组头切换，文件夹图标随状态切换
const collapsedGroups = ref<Record<SidebarSessionTab, Set<string>>>({
    chats: new Set(),
    plans: new Set(),
    archived: new Set(),
    trash: new Set(),
})
const toggleGroup = (key: string) => {
    const tab = sessionTab.value
    const next = new Set(collapsedGroups.value[tab])
    if (next.has(key)) {
        next.delete(key)
    } else {
        next.add(key)
    }
    collapsedGroups.value = { ...collapsedGroups.value, [tab]: next }
}
// 当前 tab 下某组是否收起
const isGroupCollapsed = (key: string) => collapsedGroups.value[sessionTab.value].has(key)

const sessionListItems = computed<SessionListItem[]>(() => {
    if (!groupByAgent.value) {
        return displaySessions.value.map(toSessionItem)
    }
    const collapsed = collapsedGroups.value[sessionTab.value]
    const items: SessionListItem[] = []
    for (const group of sessionGroups.value) {
        items.push({ kind: 'group', key: `group:${group.key}`, label: group.label, groupKey: group.key })
        // 收起的组只保留组头，会话行不进列表
        if (collapsed.has(group.key)) continue
        for (const session of group.sessions) {
            items.push(toSessionItem(session))
        }
    }
    return items
})

const closeSidebarDrawer = () => {
    const drawer = document.getElementById('sidebar-drawer') as HTMLInputElement
    if (drawer) drawer.checked = false
}


const selectSession = (key: string) => {
    router.push({ name: 'chat', params: { sessionkey: key } })
    closeSidebarDrawer()
}

const createNewSession = () => {
    // Navigate to new-session route
    router.push({ name: NEW_SESSION_ROUTE_NAME })
    closeSidebarDrawer()
}

// 分组组头「+」按钮：为指定 agent 打开新对话页（?agent= 让 /new 预选该智能体）
const createSessionForAgent = (agentId: string) => {
    router.push({ name: NEW_SESSION_ROUTE_NAME, query: { agent: agentId } })
    closeSidebarDrawer()
}

const handleDeleteSession = async (session: { key: string, label: string }) => {
    // 软删可从回收站恢复，无需确认打断（真删除 = 清空回收站，那里仍有确认）
    const result = await sessionsState.deleteSession(session.key)
    if (result?.deleted && chatState.sessionKey === session.key) {
        router.push({ name: 'home' })
    }
}

// 归档/取消归档后：若归档的是当前会话，回首页；若在归档 tab 取消归档，会话自动搬回对话/计划桶
const handleArchiveSession = async (session: { key: string, label: string }) => {
    await sessionsState.archiveSession(session.key)

    if (chatState.sessionKey === session.key) {
        router.push({ name: 'home' })
    }
}

const handleUnarchiveSession = async (session: { key: string, label: string }) => {
    await sessionsState.unarchiveSession(session.key)
}

// 恢复回收站会话（本地搬回原桶；归档过再删的恢复后回归档桶）
const handleRestoreSession = async (session: { key: string, label: string }) => {
    await sessionsState.restoreSession(session.key)
    toast.success(t('sidebar.restoreSuccess', { key: session.label }))
}

// 清空回收站：确认后物理清理全部软删会话；不保证全清——busy agent 整体跳过、
// 被活会话引用的死树保留（防断链）。purge 后已重拉列表，以剩余数量为准提示
const isPurging = ref(false)
const handlePurgeDeleted = async () => {
    const count = displaySessions.value.length
    if (!await confirm(t('sidebar.emptyTrashConfirm', { count }))) {
        return
    }

    isPurging.value = true
    try {
        const results = await sessionsState.purgeDeleted()
        const purged = results.reduce((sum, r) => sum + (r.deletedConversations || 0), 0)
        const remaining = sessionsState.deletedSessionsResult?.sessions?.length ?? 0
        const skippedBusy = results.filter(r => r.skipped === 'busy').map(r => r.agentId)

        if (remaining === 0) {
            toast.success(t('sidebar.purgeSuccess'))
        } else if (skippedBusy.length > 0) {
            toast.warning(t('sidebar.purgePartialBusy', { purged, count: remaining, agents: skippedBusy.join(', ') }))
        } else {
            toast.info(t('sidebar.purgePartial', { purged, count: remaining }))
        }
    } finally {
        isPurging.value = false
    }
}

// 各 tab 的行菜单配置：
// - 对话：置顶/取消置顶仅普通会话有效（后端 pin 只作用于普通列表）
// - 归档仅对话 tab 的普通会话可用：任务会话（计划 tab）不支持归档
// - 已归档行（归档 tab 全部 + 计划 tab 中已归档项）显示取消归档
// - 回收站行：恢复/重命名/信息（删除/归档/置顶对软删会话无意义）
const getSessionMenuItems = (session: { pinned?: boolean, archived?: boolean }): SessionMenuItem[] => {
    if (sessionTab.value === 'trash') {
        return [
            { key: 'restore', label: t('sidebar.restore') },
            { key: 'rename', label: t('sidebar.rename') },
            { key: 'info', label: t('sidebar.viewInfo') },
        ]
    }

    const items: SessionMenuItem[] = [
        {
            key: 'rename',
            label: t('sidebar.rename'),
        },
    ]

    if (sessionTab.value === 'chats') {
        items.push({
            key: session.pinned ? 'unpin' : 'pin',
            label: session.pinned ? t('sidebar.unpin') : t('sidebar.pin'),
        })
    }

    items.push({
        key: 'info',
        label: t('sidebar.viewInfo'),
    })

    if (session.archived) {
        items.push({
            key: 'unarchive',
            label: t('sidebar.unarchive'),
        })
    } else if (sessionTab.value === 'chats') {
        // 归档仅对话 tab 可用；任务会话（计划 tab）不支持归档
        items.push({
            key: 'archive',
            label: t('sidebar.archive'),
        })
    }

    items.push({
        key: 'delete',
        label: t('common.delete'),
        tone: 'danger',
    })
    return items
}

// 会话行右键菜单：通过 ref 打开对应行的 SessionActionMenu
const sessionMenuRefs = new Map<string, { openMenu: () => void }>()
const setSessionMenuRef = (key: string, el: unknown) => {
    if (el) {
        sessionMenuRefs.set(key, el as { openMenu: () => void })
    } else {
        sessionMenuRefs.delete(key)
    }
}
const openSessionContextMenu = (key: string) => {
    sessionMenuRefs.get(key)?.openMenu()
}

const startRename = async (session: { key: string, label: string }) => {
    renamingKey.value = session.key
    renameText.value = session.label
    renameOriginal.value = session.label
    await nextTick()
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
}

const cancelRename = () => {
    renamingKey.value = null
    renameText.value = ''
    renameOriginal.value = ''
}

const confirmRename = async () => {
    const key = renamingKey.value
    if (!key) return

    const next = renameText.value.trim()
    const original = renameOriginal.value.trim()
    cancelRename()
    // 空值或未变化时不发请求
    if (!next || next === original) return

    try {
        await sessionsState.patchSession(key, { label: next })
    } catch {
        // patchSession 内部已记录错误
    }
}

const openSessionInfo = async (session: { key: string, label: string }) => {
    infoModalOpen.value = true
    infoLoading.value = true
    infoSession.value = sessionsState.findSessionLocal(session.key) || null
    try {
        const detail = await sessionsState.getSessionById(session.key, { forceRefresh: true })
        if (detail) infoSession.value = detail
    } finally {
        infoLoading.value = false
    }
}

const handleSessionMenuSelect = async (session: { key: string, label: string }, action: string) => {
    if (action === 'rename') {
        await startRename(session)
        return
    }

    if (action === 'pin') {
        await sessionsState.pinSession(session.key)
        return
    }

    if (action === 'unpin') {
        await sessionsState.unpinSession(session.key)
        return
    }

    if (action === 'info') {
        await openSessionInfo(session)
        return
    }

    if (action === 'archive') {
        await handleArchiveSession(session)
        return
    }

    if (action === 'unarchive') {
        await handleUnarchiveSession(session)
        return
    }

    if (action === 'restore') {
        await handleRestoreSession(session)
        return
    }

    if (action === 'delete') {
        await handleDeleteSession(session)
    }
}

const navItems = SIDEBAR_ITEMS

const { isItemActive } = useNavActive()

const handleNavClick = (item: any) => {
    if (item.route) {
        router.push({ name: item.route, query: item.query })
        closeSidebarDrawer()
    }
}
</script>

<template>
    <div class="flex flex-col h-full bg-base-200 pt-[env(safe-area-inset-top)]">
        <!-- Header -->
        <div class="shrink-0 px-5 py-3 flex items-center justify-between"
            :class="isCollapsed && 'lg:flex-col lg:items-center lg:gap-2 lg:px-0'"
            :data-tauri-drag-region="isDesktopTauri ? 'deep' : undefined">
            <div class="flex items-center gap-2">
                <img src="/icon.svg" alt="SeedCode" class="h-7 w-7" />
                <span class="text-lg font-bold tracking-tight" :class="isCollapsed && 'lg:hidden'">SeedCode</span>
            </div>
            <div class="flex gap-1">
                <!-- 收起/展开（桌面端，仅图标） -->
                <button @click="toggleCollapsed"
                    class="btn btn-ghost btn-circle btn-sm hover:bg-base-300 hidden lg:inline-flex"
                    :title="isCollapsed ? $t('sidebar.expand') : $t('sidebar.collapse')"
                    :aria-label="isCollapsed ? $t('sidebar.expand') : $t('sidebar.collapse')">
                    <ArrowRightStartOnRectangleIcon v-if="isCollapsed" class="h-5 w-5" />
                    <ArrowLeftStartOnRectangleIcon v-else class="h-5 w-5" />
                </button>
            </div>
        </div>

        <!-- New Chat Button -->
        <div class="shrink-0 px-4" >
            <button @click="createNewSession"
            :class="isCollapsed && 'px-0'"
                class="btn btn-primary btn-block btn-sm gap-2 shadow-md hover:shadow-lg transition-shadow rounded-xl"
                :title="$t('sidebar.newChat')"  >
                <PlusIcon class="h-5 w-5" />
                <span class="font-medium" :class="isCollapsed && 'lg:hidden'">{{ $t('sidebar.newChat') }}</span>
            </button>
        </div>

        <!-- Divider -->
        <div class="shrink-0 px-4 py-3">
            <div class="border-t border-base-300"></div>
        </div>


        <!-- Nav -->
        <div class="shrink-0 px-3 flex flex-col gap-1.5">
            <button v-for="item in navItems" :key="item.label" @click="handleNavClick(item)"
                class="group flex items-center gap-3  px-1 w-full rounded-2xl text-left transition-all duration-200 hover:bg-base-300/90 hover:border-base-300 hover:shadow-sm border border-transparent  active:scale-[0.98] cursor-pointer"
                :class="[
                    { 'bg-base-300 shadow-sm': isItemActive(item) },
                    isCollapsed && 'lg:justify-center',
                ]" :title="$t(item.label)">
                <div class="p-1 rounded-xl transition-colors duration-200  group-hover:text-primary text-base-content/60"
                    :class="{ ' text-primary': isItemActive(item) }">
                    <component :is="item.icon" class="h-5 w-5" />
                </div>
                <span class="font-medium text-sm text-base-content/70 group-hover:text-base-content transition-colors"
                    :class="[
                        { 'text-base-content font-semibold': isItemActive(item) },
                        isCollapsed && 'lg:hidden',
                    ]">
                    {{ $t(item.label) }}
                </span>
            </button>
        </div>



        <!-- Divider -->
        <div class="shrink-0 px-4 py-2">
            <div class="border-t border-base-300"></div>
        </div>

        <!-- Session Tabs: 对话 / 计划 / 归档（胶囊分段控件）+ 分组开关 -->
        <div class="shrink-0 px-3 pt-2 pb-1 flex items-center gap-1" :class="isCollapsed && 'lg:hidden'">
            <div role="tablist" class="flex flex-1 min-w-0 items-center gap-0.5 rounded-full bg-base-300 p-1">
                <button v-for="tab in SESSION_TABS" :key="tab.key" role="tab" type="button"
                    class="flex flex-1 min-w-0 items-center justify-center rounded-full px-1 py-1 text-xs font-medium whitespace-nowrap cursor-pointer border transition-all duration-200"
                    :class="sessionTab === tab.key
                        ? 'bg-base-100 border-base-300 shadow-sm text-base-content'
                        : 'border-transparent text-base-content/55 hover:text-base-content'"
                    :aria-selected="sessionTab === tab.key"
                    :title="$t(tab.labelKey)"
                    @click="switchSessionTab(tab.key)">
                    <span class="truncate">{{ $t(tab.labelKey) }}</span>
                </button>
            </div>
            <button type="button" @click="toggleGroupByAgent"
                class="flex shrink-0 items-center rounded-full px-2 py-1 cursor-pointer border transition-all duration-200"
                :class="groupByAgent
                    ? 'bg-primary/10 border-primary/20 text-primary'
                    : 'border-transparent text-base-content/55 hover:text-base-content hover:bg-base-300/60'"
                :aria-pressed="groupByAgent" :title="$t('sidebar.group')" :aria-label="$t('sidebar.group')">
                <HashtagIcon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </button>
        </div>

        <!-- Conversations List - scrollable -->
        <div class="flex-1 overflow-y-auto px-3 pb-4 min-h-0" :class="isCollapsed && 'lg:hidden'">
            <!-- 回收站：清空按钮（仅回收站 tab 显示，整行带边框） -->
            <div v-if="sessionTab === 'trash' && displaySessions.length > 0 && !tabLoading"
                class="pb-2">
                <button type="button" :disabled="isPurging"
                    class="btn btn-sm btn-block btn-outline btn-error gap-1.5 rounded-xl font-medium"
                    @click="handlePurgeDeleted">
                    <TrashIcon class="h-4 w-4" />
                    <span>{{ isPurging ? $t('sidebar.purging') : $t('sidebar.emptyTrash') }}</span>
                </button>
            </div>
            <!-- Loading state: 当前 tab 首次懒加载在途 -->
            <div v-if="tabLoading"
                class="flex items-center justify-center py-4">
                <span class="loading loading-spinner loading-sm"></span>
            </div>
            <!-- Empty state -->
            <div v-else-if="!displaySessions || displaySessions.length === 0"
                class="text-center py-4 text-base-content/50 text-sm">
                {{ $t(sessionTab === 'chats' ? 'sidebar.noChats' : sessionTab === 'plans' ? 'sidebar.noPlans' : sessionTab === 'trash' ? 'sidebar.noTrash' : 'sidebar.noArchived') }}
            </div>
            <!-- Sessions list: 分组开时组头与行交错，否则纯行 -->
            <div v-else class="space-y-1">
                <template v-for="session in sessionListItems" :key="session.key">
                    <!-- 分组头：agent 名（仅分组模式），点击展开/收起该组会话 -->
                    <div v-if="session.kind === 'group'" role="button" tabindex="0"
                        class="flex items-center gap-2 mt-2.5 mb-1 px-2 py-1  cursor-pointer select-none transition-colors"
                        :title="session.label" :aria-expanded="!isGroupCollapsed(session.groupKey)"
                        @click="toggleGroup(session.groupKey)"
                        @keydown.enter.prevent="toggleGroup(session.groupKey)"
                        @keydown.space.prevent="toggleGroup(session.groupKey)">
                        <component :is="isGroupCollapsed(session.groupKey) ? FolderIcon : FolderOpenIcon"
                            class="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span class="truncate flex-1 font-semibold text-sm  hover:text-base-content " :class="isGroupCollapsed(session.groupKey) ? 'text-base-content/90' : 'text-base-content/50'">{{ session.label }}</span>
                        <!-- 为该 agent 新建对话：未分组（无 agentId）不显示；
                             click/keydown 阻止冒泡，避免顺带触发展开/收起 -->
                        <button v-if="session.groupKey" type="button"
                            class="btn btn-ghost btn-circle btn-xs shrink-0 "
                            :title="$t('sidebar.newChatForAgent')" :aria-label="$t('sidebar.newChatForAgent')"
                            @click.stop="createSessionForAgent(session.groupKey)"
                            @keydown.stop>
                            <PlusIcon class="h-3.5 w-3.5" />
                        </button>
                    </div>
                    <a v-else @click="selectSession(session.key)"
                        @contextmenu.prevent="openSessionContextMenu(session.key)"
                        class="flex items-center gap-2 px-3 py-1 rounded-xl cursor-pointer transition-colors group"
                        :class="activeSessionKey === session.key
                            ? 'bg-base-300  '
                            : 'hover:bg-base-300'">
                        <template v-if="session.pinned">
                            <span class="h-4 w-4 shrink-0 inline-flex items-center justify-center" :title="$t('sidebar.pin')" aria-hidden="true">📌</span>
                            <span class="sr-only">{{ $t('sidebar.pin') }}</span>
                        </template>
                        <input v-if="renamingKey === session.key" :ref="setRenameInput" v-model="renameText" type="text"
                            class="input input-xs input-bordered flex-1 min-w-0 h-6 rounded-lg" @click.stop @contextmenu.stop
                            @keydown.enter.prevent="confirmRename" @keydown.esc.prevent="cancelRename"
                            @blur="confirmRename" />
                        <template v-else>
                            <span class="text-sm truncate flex-1"
                                :class="activeSessionKey === session.key ? 'font-semibold text-primary' : ''">{{
                                session.label }}</span>
                            <!-- 回收站：被 fork 链引用标记（清空时会被保留，tooltip 说明原因） -->
                            <span v-if="session.referencedBy > 0"
                                class="shrink-0 badge badge-ghost badge-sm gap-0.5 font-normal text-base-content/50"
                                :title="$t('sidebar.referencedTooltip', { count: session.referencedBy })">
                                {{ $t('sidebar.referencedBadge', { count: session.referencedBy }) }}
                            </span>
                            <SessionActionMenu :ref="(el) => setSessionMenuRef(session.key, el)"
                                :actions="getSessionMenuItems(session)" :menu-id="`recent:${session.key}`"
                                :title="$t('sidebar.more')" @select="handleSessionMenuSelect(session, $event)" />
                        </template>
                    </a>
                </template>
            </div>
        </div>

        <!-- 网关账号区：当前网关名称+地址，点击弹出账号菜单（切换账号/添加服务器/设置）；
             菜单关闭时发 navigate，移动端在此收起抽屉 -->
        <GatewaySwitcher :collapsed="isCollapsed" @navigate="closeSidebarDrawer" />
    </div>

    <SessionInfoModal :open="infoModalOpen" :session="infoSession" :loading="infoLoading"
        @close="infoModalOpen = false" />
</template>

<style scoped>
/* Custom scrollbar for dark theme */
.overflow-y-auto::-webkit-scrollbar {
    width: 6px;
}

.overflow-y-auto::-webkit-scrollbar-track {
    background: transparent;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
    background: oklch(var(--bc) / 0.2);
    border-radius: 3px;
}

.overflow-y-auto::-webkit-scrollbar-thumb:hover {
    background: oklch(var(--bc) / 0.3);
}
</style>
