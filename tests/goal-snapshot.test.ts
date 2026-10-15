// tests/goal-snapshot.test.ts
// node:test 风格（纯函数，无 mock/无 vue 响应性），纳入 `node --test` 回归基线。
// 覆盖 goal_state 事件载荷形状守卫与面板记忆状态机。
// 数据通道：服务端扩展事件推送（emitExtensionEvent 推送线 + attach 快照线），
// 不再从会话消息流提取（UI 状态不落 transcript）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
    applyGoalStateToMemory,
    isGoalStatePayload,
    type GoalPanelMemory,
    type GoalStatePayload,
} from '../src/utils/goal-snapshot.ts'

const FULL_PAYLOAD = {
    enabled: true,
    turnCount: 1,
    maxTurns: 5,
    startMessage: '任务',
    turnMessage: '继续',
    judgeEnabled: false,
    startedAt: 1000,
    resumable: true,
}

const mem = (seenStartedAt: number | null, dismissed: boolean): GoalPanelMemory => ({ seenStartedAt, dismissed })

const state = (startedAt: number, enabled = true): GoalStatePayload => ({ ...FULL_PAYLOAD, startedAt, enabled })

// ============================================================
// 事件载荷形状守卫（推送线/快照线统一入口）
// ============================================================

test('合法载荷通过（完整形状 + judgeModel 缺失的 session 模式形态）', () => {
    assert.ok(isGoalStatePayload(FULL_PAYLOAD))
    assert.ok(isGoalStatePayload({ ...FULL_PAYLOAD, judgeModel: undefined }), 'session 模式 JSON 序列化丢键')
    assert.ok(isGoalStatePayload({ ...FULL_PAYLOAD, judgeModel: 'openai/gpt-4o' }), 'explicit 模式带模型')
})

test('形状非法的载荷被守卫逐字段拒绝', () => {
    const bad = (over: Partial<Record<string, unknown>>) => isGoalStatePayload({ ...FULL_PAYLOAD, ...over })
    assert.equal(bad({ enabled: 'yes' }), false, 'enabled 非布尔')
    assert.equal(bad({ turnCount: '1' }), false, 'turnCount 非数字')
    assert.equal(bad({ maxTurns: null }), false, 'maxTurns null')
    assert.equal(bad({ startMessage: 1 }), false, 'startMessage 非字符串')
    assert.equal(bad({ turnMessage: null }), false, 'turnMessage null')
    assert.equal(bad({ judgeEnabled: 1 }), false, 'judgeEnabled 非布尔')
    assert.equal(bad({ judgeModel: 3 }), false, 'judgeModel 非字符串/undefined')
    assert.equal(bad({ startedAt: undefined }), false, 'startedAt 缺失')
    assert.equal(bad({ resumable: 'yes' }), false, 'resumable 非布尔')
    assert.equal(bad({ resumable: undefined }), false, 'resumable 缺失')
})

test('非对象输入拒绝', () => {
    assert.equal(isGoalStatePayload(null), false)
    assert.equal(isGoalStatePayload('str'), false)
    assert.equal(isGoalStatePayload([]), false)
    assert.equal(isGoalStatePayload(undefined), false)
})

// ============================================================
// 面板记忆状态机（v2：停止不重置——停止态显示恢复按钮，已关保持隐藏）
// ============================================================

test('null 快照（加载窗口）不动记忆——脏记忆原引用返回，不被误判为停止', () => {
    const dirty = mem(1000, true)
    assert.equal(applyGoalStateToMemory(dirty, null), dirty, '刷新/切会话空窗期 goalState=null，不得吞掉 dismiss 记忆')
    const clean = mem(null, false)
    assert.equal(applyGoalStateToMemory(clean, null), clean)
})

test('显式停止（enabled=false 载荷）不动记忆——不重置（停止态显示恢复按钮，已关保持隐藏）', () => {
    const dirty = mem(1000, true)
    assert.equal(applyGoalStateToMemory(dirty, state(1000, false)), dirty, '已关的停止态保持隐藏，不重置')
    const visible = mem(1000, false)
    assert.equal(applyGoalStateToMemory(visible, state(1000, false)), visible, '可见的停止态保持可见，不重置')
    const clean = mem(null, false)
    assert.equal(applyGoalStateToMemory(clean, state(1000, false)), clean)
})

test('新 startedAt（start/restart/resume 新周期）→ 重现', () => {
    const dismissedDuringPrevRun = mem(999, true)
    const next = applyGoalStateToMemory(dismissedDuringPrevRun, state(1000))
    assert.deepEqual(next, { seenStartedAt: 1000, dismissed: false })
})

test('同一运行内轮数推进（startedAt 不变）→ 记忆不变（原引用）', () => {
    const m = mem(1000, true)
    assert.equal(applyGoalStateToMemory(m, state(1000)), m, '已关就保持隐藏，不因每轮 onYield 弹回')
    const untouched = mem(1000, false)
    assert.equal(applyGoalStateToMemory(untouched, state(1000)), untouched)
})

test('完整生命周期：dismiss 后同周期隐藏 → 停止不动记忆 → resume（新 startedAt）重现', () => {
    let m: GoalPanelMemory = { seenStartedAt: null, dismissed: false }
    // goal 启动（T1）
    m = applyGoalStateToMemory(m, state(1000))
    assert.deepEqual(m, { seenStartedAt: 1000, dismissed: false })
    // 用户 ✕ 关闭
    m = { seenStartedAt: 1000, dismissed: true }
    // 轮数推进，同周期保持隐藏
    m = applyGoalStateToMemory(m, state(1000))
    assert.equal(m.dismissed, true)
    // 停止（off 语义，按钮线）→ 不动记忆（不重置，已关保持隐藏）
    m = applyGoalStateToMemory(m, state(1000, false))
    assert.deepEqual(m, { seenStartedAt: 1000, dismissed: true })
    // /goal resume（服务端赋新 startedAt T2 = 新周期）→ 重现
    m = applyGoalStateToMemory(m, state(2000))
    assert.deepEqual(m, { seenStartedAt: 2000, dismissed: false })
})

test('刷新后停止态不反复弹出：attach 快照线 enabled=false 不重置已关记忆', () => {
    // 模拟刷新：localStorage 恢复 {T1, dismissed} → attach 快照线送达停止载荷
    const dismissed = mem(1000, true)
    const afterRefresh = applyGoalStateToMemory(dismissed, state(1000, false))
    assert.equal(afterRefresh, dismissed, '停止载荷不吞 dismiss 记忆——刷新后不反复弹出停止条')
})
