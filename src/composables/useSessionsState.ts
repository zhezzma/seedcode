import { reactive, watch } from 'vue'

import { ApiError, apiGet, apiPost, apiDelete } from './api-client'
import { useInputHistoryStore } from '../stores/inputHistory'
import type { SessionCategory } from './session-route-state'
import {
    mergeSessionToRouteState,
    moveSessionToRouteState,
    normalizeSessionRouteState,
    removeSessionFromResult,
    type SessionRouteState,
} from './session-route-state'

// ==================== Types ====================
export interface SessionRow {
    id: string
    agentId?: string
    agentName?: string
    created?: string
    cwd?: string
    /** 会话标题（永不为空——首条消息即占位标题，截断展示同旧 firstMessage 语义） */
    name?: string
    /** 标题是否已被正式设置（用户改名/AI 命名）；false = 占位标题，自动命名仍可触发 */
    titleSet?: boolean
    modelProvider?: string
    model?: string
    modified?: string
    path?: string
    thinkingLevel?: string
    sessionCategory?: SessionCategory
    archived?: boolean
    pinned?: boolean
    /** 软删（回收站桶标记；归档过再删的恢复后回归档桶，archived 独立保留） */
    deleted?: boolean
    /** 软删会话专属：被活会话 fork 链引用的次数（> 0 = 清空时会被保留） */
    referencedBy?: number
}

export interface SessionsResult {
    sessions: SessionRow[]
    total?: number
    page?: number
    pageSize?: number
}

// ==================== State ====================
export interface SessionsState {
    /** 普通会话（侧栏「对话」tab 数据源） */
    sessionsResult: SessionsResult | null
    /** 计划会话（侧栏「计划」tab + cron 执行目标候选） */
    taskSessionsResult: SessionsResult | null
    /** 已归档会话（侧栏「归档」tab 数据源） */
    archivedSessionsResult: SessionsResult | null
    /** 回收站（侧栏「回收站」tab 数据源，软删会话） */
    deletedSessionsResult: SessionsResult | null
}

const state = reactive<SessionsState>({
    sessionsResult: null,
    taskSessionsResult: null,
    archivedSessionsResult: null,
    deletedSessionsResult: null,
})

// Session ID → SessionRow 的索引，用于 O(1) 快速查找
const sessionsIndex = new Map<string, SessionRow>()

// ==================== Actions ====================

const rebuildIndex = () => {
    sessionsIndex.clear()
    state.sessionsResult?.sessions?.forEach(s => sessionsIndex.set(s.id, s))
    state.taskSessionsResult?.sessions?.forEach(s => sessionsIndex.set(s.id, s))
    state.archivedSessionsResult?.sessions?.forEach(s => sessionsIndex.set(s.id, s))
    state.deletedSessionsResult?.sessions?.forEach(s => sessionsIndex.set(s.id, s))
}


const upsertSessionByRouteState = (session: SessionRow, routeState?: SessionRouteState) => {
    const normalized = normalizeSessionRouteState(routeState ?? session)
    const nextSession = {
        ...session,
        ...normalized,
    }
    // merge（按 modified 定位插入）而非 move（置顶）：单查回填不得改变列表排序
    //（排序权威在服务端；点击会话/冷启动回填跳到最前是 bug，见回收站点击跳序）
    Object.assign(state, mergeSessionToRouteState(state, nextSession, normalized))
    // 索引必须存桶里的同一个实例：mergeSessionToRouteState 内部会再展开一次生成
    // 桶行副本，若索引存 nextSession 本体，getSessionById 返回的行就会与列表行
    // 分叉（历史 bug：currentSession 与侧边栏各行其是，单侧写入"看起来没生效"）
    sessionsIndex.set(session.id, findSessionLocal(session.id) ?? nextSession)
}

const findSessionLocal = (id: string) =>
    state.sessionsResult?.sessions?.find((s: SessionRow) => s.id === id)
    || state.taskSessionsResult?.sessions?.find((s: SessionRow) => s.id === id)
    || state.archivedSessionsResult?.sessions?.find((s: SessionRow) => s.id === id)
    || state.deletedSessionsResult?.sessions?.find((s: SessionRow) => s.id === id)

// sessions 变更时自动重建索引（模块级全局 watcher）
watch(() => [state.sessionsResult, state.taskSessionsResult, state.archivedSessionsResult, state.deletedSessionsResult], rebuildIndex, { immediate: true, deep: false })

const loadSessions = async (_opts?: any) => {
    const result = await apiGet<SessionsResult>('/api/sessions')
    state.sessionsResult = result || { sessions: [] }
}

// 懒加载请求序号：归档/取消归档会本地搬运桶内容，晚到的旧响应不得覆盖新状态
let taskSessionsRequestId = 0
let archivedSessionsRequestId = 0
let deletedSessionsRequestId = 0

// 侧栏 tab 懒加载依赖返回值区分成败：失败返回 null（桶保持旧值），成功返回结果或空列表
const loadTaskSessions = async (page = 1, pageSize = 50): Promise<SessionsResult | null> => {
    const requestId = ++taskSessionsRequestId
    try {
        const result = await apiGet<SessionsResult>(`/api/sessions/tasks?page=${page}&pageSize=${pageSize}`)
        // 过期响应直接丢弃（内容可能不含期间发生的本地搬运），但按成功返回让 loadedTabs 正常落盘
        if (requestId !== taskSessionsRequestId) return result || { sessions: [] }
        state.taskSessionsResult = result || { sessions: [] }
        return result || { sessions: [] }
    } catch (error) {
        console.error('Failed to load task sessions', error)
        return null
    }
}

const loadArchivedSessions = async (page = 1, pageSize = 50): Promise<SessionsResult | null> => {
    const requestId = ++archivedSessionsRequestId
    try {
        const result = await apiGet<SessionsResult>(`/api/sessions/archived?page=${page}&pageSize=${pageSize}`)
        if (requestId !== archivedSessionsRequestId) return result || { sessions: [] }
        state.archivedSessionsResult = result || { sessions: [] }
        return result || { sessions: [] }
    } catch (error) {
        console.error('Failed to load archived sessions', error)
        return null
    }
}

const loadDeletedSessions = async (page = 1, pageSize = 50): Promise<SessionsResult | null> => {
    const requestId = ++deletedSessionsRequestId
    try {
        const result = await apiGet<SessionsResult>(`/api/sessions/deleted?page=${page}&pageSize=${pageSize}`)
        if (requestId !== deletedSessionsRequestId) return result || { sessions: [] }
        state.deletedSessionsResult = result || { sessions: [] }
        return result || { sessions: [] }
    } catch (error) {
        console.error('Failed to load deleted sessions', error)
        return null
    }
}

const patchSession = async (key: string, patch: { label?: string | null }) => {
    try {
        await apiPost(`/api/sessions/${encodeURIComponent(key)}/name`, { name: patch.label })
        const found = findSessionLocal(key)
        if (found) {
            found.name = patch.label || undefined
        }
    } catch (error) {
        console.error('Failed to rename session', error)
        throw error
    }
}

/**
 * 仅更新本地 session 数据，不发送 API 请求。
 * 用于后端已持久化的场景（如 /name 命令回调），只需同步前端响应式状态。
 */
const updateSessionLocal = (key: string, patch: Partial<SessionRow>) => {
    const found = findSessionLocal(key)
    if (found) {
        Object.assign(found, patch)
    }
}

const triggerSessionRename = async (targetKey: string, userText: string) => {
    try {
        const result = await apiPost<{ sessionId: string; name: string }>(
            `/api/sessions/${encodeURIComponent(targetKey)}/generate-title`,
            { text: userText.substring(0, 500) }
        )
        const name = result?.name
        if (name) {
            const target = findSessionLocal(targetKey)
            if (target) {
                target.name = name
            }
        }
    } catch (e) {
        console.warn('Failed to auto-rename session', e)
    }
}

const archiveSession = async (id: string) => {
    await apiPost(`/api/sessions/${encodeURIComponent(id)}/archive`)

    const known = findSessionLocal(id)
    if (known) {
        const archivedSession = {
            ...known,
            // 服务端归档时会同步移除置顶，本地状态保持一致
            pinned: false,
            ...normalizeSessionRouteState({
                sessionCategory: known.sessionCategory,
                archived: true,
            }),
        }
        Object.assign(state, moveSessionToRouteState(state, archivedSession, archivedSession))
        sessionsIndex.set(id, findSessionLocal(id) ?? archivedSession)
    } else {
        state.sessionsResult = removeSessionFromResult(state.sessionsResult, id)
        state.taskSessionsResult = removeSessionFromResult(state.taskSessionsResult, id)
        state.archivedSessionsResult = removeSessionFromResult(state.archivedSessionsResult, id)
    }

    return { archived: true }
}

const unarchiveSession = async (id: string) => {
    await apiPost(`/api/sessions/${encodeURIComponent(id)}/unarchive`)

    const known = findSessionLocal(id)
    if (known) {
        const restoredSession = {
            ...known,
            ...normalizeSessionRouteState({
                sessionCategory: known.sessionCategory,
                archived: false,
            }),
        }
        Object.assign(state, moveSessionToRouteState(state, restoredSession, restoredSession))
        sessionsIndex.set(id, findSessionLocal(id) ?? restoredSession)
    } else {
        state.sessionsResult = removeSessionFromResult(state.sessionsResult, id)
        state.taskSessionsResult = removeSessionFromResult(state.taskSessionsResult, id)
        state.archivedSessionsResult = removeSessionFromResult(state.archivedSessionsResult, id)
    }

    return { archived: false }
}

const pinSession = async (id: string) => {
    await apiPost(`/api/sessions/${encodeURIComponent(id)}/pin`)
    // 置顶改变列表排序，直接重新拉取服务端排好序的列表
    await loadSessions()
}

const unpinSession = async (id: string) => {
    await apiPost(`/api/sessions/${encodeURIComponent(id)}/unpin`)
    await loadSessions()
}

const deleteSession = async (key: string) => {
    await apiDelete(`/api/sessions/${encodeURIComponent(key)}`)
    // 本地搬进回收站桶（服务端为软删，会话可恢复；归档/任务分类字段原样保留）
    const known = findSessionLocal(key)
    if (known) {
        const deletedSession = {
            ...known,
            ...normalizeSessionRouteState({
                sessionCategory: known.sessionCategory,
                archived: known.archived,
                deleted: true,
            }),
        }
        Object.assign(state, moveSessionToRouteState(state, deletedSession, deletedSession))
        sessionsIndex.set(key, findSessionLocal(key) ?? deletedSession)
    } else {
        state.sessionsResult = removeSessionFromResult(state.sessionsResult, key)
        state.taskSessionsResult = removeSessionFromResult(state.taskSessionsResult, key)
        state.archivedSessionsResult = removeSessionFromResult(state.archivedSessionsResult, key)
        state.deletedSessionsResult = removeSessionFromResult(state.deletedSessionsResult, key)
    }
    useInputHistoryStore().removeSessionHistory(key)
    // 排队队列随服务端账本生命周期（abort/会话替换时已清），本地无持久化，无需额外清理
    return { deleted: true }
}

/** 恢复软删会话：本地从回收站桶搬回原桶（archived 独立字段决定回归对话/归档桶） */
const restoreSession = async (id: string) => {
    await apiPost(`/api/sessions/${encodeURIComponent(id)}/restore`)

    const known = findSessionLocal(id)
    if (known) {
        const restoredSession = {
            ...known,
            ...normalizeSessionRouteState({
                sessionCategory: known.sessionCategory,
                archived: known.archived,
                deleted: false,
            }),
        }
        Object.assign(state, moveSessionToRouteState(state, restoredSession, restoredSession))
        sessionsIndex.set(id, findSessionLocal(id) ?? restoredSession)
    } else {
        state.deletedSessionsResult = removeSessionFromResult(state.deletedSessionsResult, id)
    }

    return { restored: true }
}

/** 清空回收站：物理清理全部软删会话。返回逐 agent 报告（skipped busy 等）。
 *  被跳过 agent（busy）的软删会话仍在服务端——拉取后以服务端为准，不清空桶。 */
const purgeDeleted = async (): Promise<PurgeResult[]> => {
    const result = await apiPost<{ results: PurgeResult[] }>('/api/sessions/purge', {})
    await loadDeletedSessions()
    return result?.results || []
}

export interface PurgeResult {
    agentId: string
    dryRun?: boolean
    skipped?: 'busy' | 'no-database' | 'schema-version'
    detail?: string
    deletedConversations: number
    deletedEntries?: number
    deletedTasks?: number
    deletedSubmissions?: number
    deletedDocuments?: number
}

const commitNewSession = async (agentId: string, inputText?: string): Promise<string> => {
    const body = inputText ? { firstMessage: inputText } : undefined
    const session = await apiPost<SessionRow>(`/api/sessions/${agentId}`, body)
    upsertSessionByRouteState(session)
    return session.id
}

const fetchSessionInfo = (id: string) =>
    apiGet<SessionRow>(`/api/sessions/${encodeURIComponent(id)}/info`)

const getSessionById = async (
    id: string,
    options?: { forceRefresh?: boolean; throwOnError?: boolean },
): Promise<SessionRow | undefined> => {
    // forceRefresh 绕过本地缓存，直接向后端确认 session 是否还存在（用于前台恢复场景）
    const cached = options?.forceRefresh ? undefined : sessionsIndex.get(id)
    if (cached) return cached

    try {
        const session = await fetchSessionInfo(id)
        if (!session) return undefined

        upsertSessionByRouteState(session)
        return sessionsIndex.get(id) || session
    } catch (error: unknown) {
        if (options?.throwOnError) {
            throw error
        }
        if (error instanceof ApiError && error.code === 404) {
            return undefined
        }
        console.warn('Failed to fetch session by id', id, error)
        return undefined
    }
}

const _sessionsState = Object.assign(state, {
    loadSessions,
    loadTaskSessions,
    loadArchivedSessions,
    loadDeletedSessions,
    patchSession,
    updateSessionLocal,
    archiveSession,
    unarchiveSession,
    pinSession,
    unpinSession,
    deleteSession,
    restoreSession,
    purgeDeleted,
    findSessionLocal,
    commitNewSession,
    triggerSessionRename,
    getSessionById,
})

export function useSessionsState() {
    return _sessionsState
}
