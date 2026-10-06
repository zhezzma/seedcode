import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { insertSessionByModified, mergeSessionToRouteState, moveSessionToRouteState, normalizeSessionRouteState, prependSessionToResult } from '../src/composables/session-route-state.ts'

const root = path.resolve(import.meta.dirname, '..')
const sessionsStateSource = readFileSync(path.join(root, 'src/composables/useSessionsState.ts'), 'utf8')

test('session state defines archived sessions state and archive helpers', () => {
  assert.match(sessionsStateSource, /archivedSessionsResult:\s*SessionsResult \| null/)
  // 失败返回 null（桶保持旧值），侧栏懒加载据此重试；两个懒加载桶同步签名
  assert.match(sessionsStateSource, /const loadArchivedSessions = async \(page = 1, pageSize = 50\): Promise<SessionsResult \| null> =>/)
  assert.match(sessionsStateSource, /const loadTaskSessions = async \(page = 1, pageSize = 50\): Promise<SessionsResult \| null> =>/)
  assert.match(sessionsStateSource, /const archiveSession = async \(id: string\) =>/)
  assert.match(sessionsStateSource, /const unarchiveSession = async \(id: string\) =>/)
  assert.match(sessionsStateSource, /archived\?: boolean/)
  assert.match(sessionsStateSource, /\/api\/sessions\/archived\?page=\$\{page\}&pageSize=\$\{pageSize\}/)
})


test('session state defines pin helpers calling the backend pin/unpin endpoints', () => {
  assert.match(sessionsStateSource, /const pinSession = async \(id: string\) => {[\s\S]*?apiPost\(`\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/pin`\)/)
  assert.match(sessionsStateSource, /const unpinSession = async \(id: string\) => {[\s\S]*?apiPost\(`\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/unpin`\)/)
  assert.match(sessionsStateSource, /SessionRow[\s\S]*?pinned\?: boolean/)
})

test('archiveSession clears local pinned state to match backend archive-removes-pin semantics', () => {
  // 服务端归档会同步移除置顶，本地构造 archivedSession 时必须显式置 pinned: false
  assert.match(sessionsStateSource, /pinned: false,\s*\.\.\.normalizeSessionRouteState/)
})

test('unarchiveSession calls the backend unarchive endpoint', () => {
  assert.match(sessionsStateSource, /const unarchiveSession = async \(id: string\) => {[\s\S]*?apiPost\(`\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/unarchive`\)/)
  assert.doesNotMatch(sessionsStateSource, /const unarchiveSession = async \(id: string\) => {[\s\S]*?apiDelete\(`\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/archive`\)/)
})

test('moveSessionToRouteState removes stale default copies when a session becomes archived', () => {
  const session = { id: 'sess-default', sessionCategory: 'default' as const, archived: false }
  const nextState = moveSessionToRouteState(
    {
      sessionsResult: { sessions: [session], total: 1 },
      taskSessionsResult: { sessions: [], total: 0 },
      archivedSessionsResult: { sessions: [{ ...session, archived: true }], total: 4 },
    },
    session,
    { sessionCategory: 'default', archived: true },
  )

  assert.deepEqual(nextState.sessionsResult?.sessions, [])
  assert.equal(nextState.sessionsResult?.total, 0)
  // 归档桶内对象应携带 archived: true 且其余字段保留
  assert.deepEqual(nextState.archivedSessionsResult?.sessions, [{ ...session, archived: true, deleted: false }])
  assert.equal(nextState.archivedSessionsResult?.total, 4)
})

test('moveSessionToRouteState removes stale archived copies when a session becomes active again', () => {
  const archivedSession = { id: 'sess-archived', sessionCategory: 'default' as const, archived: true }
  const nextState = moveSessionToRouteState(
    {
      sessionsResult: { sessions: [], total: 2 },
      taskSessionsResult: { sessions: [], total: 0 },
      archivedSessionsResult: { sessions: [archivedSession], total: 1 },
    },
    archivedSession,
    { sessionCategory: 'default', archived: false },
  )

  assert.deepEqual(nextState.archivedSessionsResult?.sessions, [])
  assert.equal(nextState.archivedSessionsResult?.total, 0)
  assert.deepEqual(nextState.sessionsResult?.sessions, [{ ...archivedSession, archived: false, deleted: false }])
  assert.equal(nextState.sessionsResult?.total, 3)
})

test('moveSessionToRouteState keeps task sessions in the task bucket even when archived', () => {
  // task 优先于 archived：归档的计划会话留在计划桶（带 archived 标志），
  // 与后端 /api/sessions/tasks 含归档项、/api/sessions/archived 仅 default 的语义一致
  const taskSession = { id: 'sess-task', sessionCategory: 'task' as const, archived: false }
  const nextState = moveSessionToRouteState(
    {
      sessionsResult: { sessions: [{ id: 'sess-task', sessionCategory: 'default' as const, archived: false }], total: 1 },
      taskSessionsResult: { sessions: [], total: 0 },
      archivedSessionsResult: { sessions: [{ ...taskSession, archived: true }], total: 1 },
    },
    taskSession,
    normalizeSessionRouteState({ sessionCategory: 'task', archived: true }),
  )

  assert.deepEqual(nextState.sessionsResult?.sessions, [])
  assert.deepEqual(nextState.archivedSessionsResult?.sessions, [])
  assert.deepEqual(nextState.taskSessionsResult?.sessions, [{ ...taskSession, archived: true, deleted: false }])
  assert.equal(nextState.taskSessionsResult?.total, 1)
})

test('normalizeSessionRouteState normalizes undefined to default/unarchived', () => {
  assert.deepEqual(normalizeSessionRouteState(undefined), {
    sessionCategory: 'default',
    archived: false,
    deleted: false,
  })
  assert.deepEqual(normalizeSessionRouteState({ sessionCategory: 'task', archived: true }), {
    sessionCategory: 'task',
    archived: true,
    deleted: false,
  })
})

test('prependSessionToResult dedupes and adjusts total when session already present', () => {
  const session = { id: 'sess-1', sessionCategory: 'default' as const, archived: false }
  const result = { sessions: [session], total: 5 }

  // 同 ID 再次 prepend：新对象替换旧对象（归档搬桶依赖此语义），total 不变
  const prepended = prependSessionToResult(result, { ...session, archived: true })

  assert.deepEqual(prepended.sessions, [{ ...session, archived: true }])
  assert.equal(prepended.total, 5)

  // 新 ID prepend：插到队首，total +1
  const other = { id: 'sess-2', sessionCategory: 'default' as const, archived: false }
  const grown = prependSessionToResult(result, other)
  assert.deepEqual(grown.sessions, [other, session])
  assert.equal(grown.total, 6)

  // total 缺失时按列表长度计
  const fallback = prependSessionToResult({ sessions: [session] }, other)
  assert.equal(fallback.total, 2)
})

test('session state keeps three buckets for sidebar tabs without notification routing helpers', () => {
  // 三个桶分别是侧栏 tabs（对话/计划/归档）的数据源
  assert.ok(sessionsStateSource.includes('/** 普通会话（侧栏「对话」tab 数据源） */'))
  assert.ok(sessionsStateSource.includes('/** 计划会话（侧栏「计划」tab + cron 执行目标候选） */'))
  assert.ok(sessionsStateSource.includes('/** 已归档会话（侧栏「归档」tab 数据源） */'))
  // 通知分流函数已删除
  assert.doesNotMatch(sessionsStateSource, /resolveNotificationSessionRouteState/)
  assert.doesNotMatch(sessionsStateSource, /resolveNotificationSessionCategory/)
  // getSessionById 不再携带 category（所有会话统一走 /chat）
  assert.doesNotMatch(sessionsStateSource, /getSessionById, category/)
})

test('moveSessionToRouteState routes soft-deleted sessions to the recycle bin bucket', () => {
  // deleted 优先于 archived/task：软删会话一律进回收站桶（带 deleted 标志）
  const archivedSession = { id: 'sess-del', sessionCategory: 'default' as const, archived: true }
  const nextState = moveSessionToRouteState(
    {
      sessionsResult: { sessions: [], total: 0 },
      taskSessionsResult: { sessions: [], total: 0 },
      archivedSessionsResult: { sessions: [archivedSession], total: 1 },
      deletedSessionsResult: { sessions: [], total: 0 },
    },
    archivedSession,
    { archived: true, deleted: true },
  )

  assert.deepEqual(nextState.archivedSessionsResult?.sessions, [])
  assert.equal(nextState.archivedSessionsResult?.total, 0)
  assert.deepEqual(nextState.deletedSessionsResult?.sessions, [{ ...archivedSession, deleted: true }])
  assert.equal(nextState.deletedSessionsResult?.total, 1)
})

test('moveSessionToRouteState restores a soft-deleted session back to its original bucket', () => {
  // 归档过再删的会话恢复后回归档桶（archived 字段独立保留，不受 deleted 影响）
  const deletedSession = { id: 'sess-restore', sessionCategory: 'default' as const, archived: true, deleted: true }
  const nextState = moveSessionToRouteState(
    {
      sessionsResult: { sessions: [], total: 0 },
      taskSessionsResult: { sessions: [], total: 0 },
      archivedSessionsResult: { sessions: [], total: 0 },
      deletedSessionsResult: { sessions: [deletedSession], total: 1 },
    },
    deletedSession,
    { archived: true, deleted: false },
  )

  assert.deepEqual(nextState.deletedSessionsResult?.sessions, [])
  assert.equal(nextState.deletedSessionsResult?.total, 0)
  assert.deepEqual(nextState.archivedSessionsResult?.sessions, [{ ...deletedSession, deleted: false }])
  assert.equal(nextState.archivedSessionsResult?.total, 1)
})

test('insertSessionByModified inserts by modified order instead of pinning to top', () => {
  // 单查回填（点击会话 / 冷启动回填）按 modified 定位：不改变既有列表排序
  const older = { id: 'a', modified: '2026-01-01T00:00:00Z' }
  const newer = { id: 'b', modified: '2026-01-03T00:00:00Z' }
  const clicked = { id: 'c', modified: '2026-01-02T00:00:00Z' }

  const next = insertSessionByModified(
    { sessions: [newer, older], total: 2 },
    clicked,
  )

  assert.deepEqual(next.sessions.map(s => s.id), ['b', 'c', 'a'])
  assert.equal(next.total, 3)
})

test('insertSessionByModified never crosses pinned rows and dedupes in place', () => {
  // 置顶行保持在前（与后端置顶优先排序一致），回填行插在置顶区之后
  const pinned = { id: 'p', modified: '2025-01-01T00:00:00Z', pinned: true }
  const older = { id: 'a', modified: '2026-01-01T00:00:00Z' }
  const updated = { id: 'a', modified: '2026-06-01T00:00:00Z' }

  const inserted = insertSessionByModified(
    { sessions: [pinned, older], total: 2 },
    updated,
  )
  assert.deepEqual(inserted.sessions.map(s => s.id), ['p', 'a'])
  assert.equal(inserted.total, 2)
})

test('mergeSessionToRouteState fills back without reordering the bucket', () => {
  // 点击回收站会话 → /info 回填：行落到回收站桶的 modified 位置，不跳到最前
  const first = { id: 'x-1', modified: '2026-02-01T00:00:00Z', deleted: true }
  const second = { id: 'x-2', modified: '2026-01-01T00:00:00Z', deleted: true }
  const clicked = { id: 'x-2', modified: '2026-01-01T00:00:00Z', deleted: true }

  const nextState = mergeSessionToRouteState(
    {
      sessionsResult: { sessions: [], total: 0 },
      taskSessionsResult: { sessions: [], total: 0 },
      archivedSessionsResult: { sessions: [], total: 0 },
      deletedSessionsResult: { sessions: [first, second], total: 2 },
    },
    clicked,
  )

  assert.deepEqual(nextState.deletedSessionsResult?.sessions.map(s => s.id), ['x-1', 'x-2'])
  assert.equal(nextState.deletedSessionsResult?.total, 2)
})
