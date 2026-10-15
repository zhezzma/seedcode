// tests/abort-goal-state-wiring.test.ts
// node:test 源码锚定（useChatState 难以单独挂载，同 pending-queue-wiring 模式）。
// 契约：/abort 连带停 goal（服务端 goal 扩展 abort 收线 finalizer，off 语义）后，
// 发起停止的本端 SSE 已关（推送线不可达）——abortChat 必须重新 attach 走快照线
// （extension-events collect 各 source 现态）拿 ext.goal_state(enabled=false)，
// GoalBar 从「运行中」转「已停止」。goal-agnostic：attach 是空闲会话的常规姿态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const chatStateSource = readFileSync(path.join(repoRoot, 'src/composables/useChatState.ts'), 'utf8')

/** 截取 `const <name> = ...` 到下一个顶层 `\nconst `（同 pending-queue-wiring） */
function extractFn(source: string, name: string): string {
    const start = source.indexOf(`const ${name} = `)
    assert.ok(start >= 0, `function ${name} not found`)
    const end = source.indexOf('\nconst ', start + 1)
    return source.slice(start, end === -1 ? undefined : end)
}

test('abortChat: abort 后重新 attach（快照线兑底 goal 状态，goal-agnostic 常规姿态）', () => {
    const fn = extractFn(chatStateSource, 'abortChat')

    // 附着兜底：abort 后无活跃 SSE，attachToSessionIfNeeded 必然放行（shouldAttachSession）
    assert.match(fn, /attachToSessionIfNeeded\(targetKey\)/)

    // 守卫次序：必须在 abortSnapshotStale 检查之后——/abort 在途期间切会话/发新消息时
    // 整包丢弃，attach 同规则（旧 key 的 attach 事件由 useGoalState 归属守卫拦下，无副作用）
    const stalePos = fn.indexOf('if (abortSnapshotStale()) return')
    const attachPos = fn.indexOf('attachToSessionIfNeeded(targetKey)')
    assert.ok(stalePos >= 0, '快照落地守卫应存在')
    assert.ok(attachPos > stalePos, 'attach 兜底必须在 stale 守卫之后')

    // 服务端响应契约保持纯净：/abort 不带 goal 扩展字段（扩展边界内收口，快照线兑底）
    assert.ok(!fn.includes('goalState'), '/abort 响应不应承载扩展字段（goal 状态走 attach 快照线）')
})
