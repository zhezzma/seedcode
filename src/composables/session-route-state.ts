export type SessionCategory = 'default' | 'task'

export interface SessionRouteState {
    sessionCategory?: SessionCategory
    archived?: boolean
    /** 软删（回收站）：优先级高于 archived（归档过再删的恢复后仍回归档桶） */
    deleted?: boolean
}

export interface SessionRouteRow extends SessionRouteState {
    id: string
}

export interface SessionRouteResult<TSession extends SessionRouteRow> {
    sessions: TSession[]
    total?: number
    page?: number
    pageSize?: number
}

export interface SessionRouteBuckets<TSession extends SessionRouteRow> {
    sessionsResult: SessionRouteResult<TSession> | null
    taskSessionsResult: SessionRouteResult<TSession> | null
    archivedSessionsResult: SessionRouteResult<TSession> | null
    deletedSessionsResult: SessionRouteResult<TSession> | null
}

export const normalizeSessionRouteState = (routeState?: SessionRouteState): Required<SessionRouteState> => ({
    sessionCategory: routeState?.sessionCategory === 'task' ? 'task' : 'default',
    archived: Boolean(routeState?.archived),
    deleted: Boolean(routeState?.deleted),
})

export const getSessionBucketKey = (routeState?: SessionRouteState): keyof SessionRouteBuckets<SessionRouteRow> => {
    const normalized = normalizeSessionRouteState(routeState)
    if (normalized.deleted) return 'deletedSessionsResult'
    if (normalized.sessionCategory === 'task') return 'taskSessionsResult'
    if (normalized.archived) return 'archivedSessionsResult'
    return 'sessionsResult'
}

export const removeSessionFromResult = <TSession extends SessionRouteRow>(
    result: SessionRouteResult<TSession> | null,
    id: string,
): SessionRouteResult<TSession> | null => {
    if (!result?.sessions) return result
    const nextSessions = result.sessions.filter(session => session.id !== id)
    if (nextSessions.length === result.sessions.length) return result
    const nextTotal = typeof result.total === 'number'
        ? Math.max(0, result.total - (result.sessions.length - nextSessions.length))
        : nextSessions.length
    return {
        ...result,
        sessions: nextSessions,
        total: nextTotal,
    }
}

export const prependSessionToResult = <TSession extends SessionRouteRow>(
    result: SessionRouteResult<TSession> | null,
    session: TSession,
): SessionRouteResult<TSession> => {
    const existing = result?.sessions || []
    const deduped = existing.filter(item => item.id !== session.id)
    const alreadyPresent = deduped.length !== existing.length
    const nextTotal = typeof result?.total === 'number'
        ? (alreadyPresent ? result.total : result.total + 1)
        : deduped.length + 1
    return {
        ...(result || {}),
        sessions: [session, ...deduped],
        total: nextTotal,
    }
}

export const moveSessionToRouteState = <TSession extends SessionRouteRow>(
    sessionsState: SessionRouteBuckets<TSession>,
    session: TSession,
    routeState?: SessionRouteState,
): SessionRouteBuckets<TSession> => {
    const normalized = normalizeSessionRouteState(routeState ?? session)
    const targetKey = getSessionBucketKey(normalized) as keyof SessionRouteBuckets<TSession>
    const nextSession = {
        ...session,
        sessionCategory: normalized.sessionCategory,
        archived: normalized.archived,
        deleted: normalized.deleted,
    } as TSession

    const nextState: SessionRouteBuckets<TSession> = {
        sessionsResult: removeSessionFromResult(sessionsState.sessionsResult, session.id),
        taskSessionsResult: removeSessionFromResult(sessionsState.taskSessionsResult, session.id),
        archivedSessionsResult: removeSessionFromResult(sessionsState.archivedSessionsResult, session.id),
        deletedSessionsResult: removeSessionFromResult(sessionsState.deletedSessionsResult, session.id),
    }

    nextState[targetKey] = prependSessionToResult(nextState[targetKey], nextSession)
    return nextState
}
