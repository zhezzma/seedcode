// tests/tasklist-snapshot.test.ts
// node:test 风格（纯函数，无 mock/无 vue 响应性），纳入 `node --test` 回归基线。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
    applySnapshotToMemory,
    extractTasklistSnapshot,
    extractTasklistSnapshotFromSources,
    unionSeen,
    type MinimalMessage,
    type TasklistPanelMemory,
    type TasklistTask,
} from '../src/utils/tasklist-snapshot.ts'

const msg = (over: Partial<MinimalMessage>): MinimalMessage => ({ role: 'toolResult', toolName: 'tasklist', ...over })

const snapMsg = (subjects: string[], nextId: number) =>
    msg({ details: { tasks: subjects.map((s, i) => ({ id: i + 1, subject: s, status: 'pending' })), nextId } })

const snapOf = (tasks: Array<{ id: number; subject: string; status: string }>, nextId?: number) => ({
    tasks: tasks.map((t) => ({ ...t })) as TasklistTask[],
    nextId: nextId ?? Math.max(0, ...tasks.map((t) => t.id)) + 1,
})

// ============================================================
// 提取器
// ============================================================

test('空消息 / 无 tasklist 结果 → null', () => {
    assert.equal(extractTasklistSnapshot([]), null)
    assert.equal(extractTasklistSnapshot([{ role: 'assistant', content: [] }]), null)
    assert.equal(extractTasklistSnapshot([msg({ toolName: 'read', details: { tasks: [], nextId: 1 } })]), null)
})

test('旧工具名 todo 的结果不被识别（零残留守卫：无双名兼容）', () => {
    assert.equal(
        extractTasklistSnapshot([{ role: 'toolResult', toolName: 'todo', details: { tasks: [], nextId: 1 } }]),
        null,
    )
})

test('取最后一条 tasklist 快照（last-write-wins）', () => {
    const messages = [
        snapMsg(['A'], 2),
        { role: 'assistant', content: [] },
        snapMsg(['A', 'B'], 3),
    ]
    const snap = extractTasklistSnapshot(messages)!
    assert.equal(snap.tasks.length, 2)
    assert.equal(snap.nextId, 3)
})

test('形状不匹配的 details 被跳过（错误结果 / 旧数据）', () => {
    const messages = [
        msg({ details: { error: 'boom' } }),
        msg({ details: 'garbage' }),
        snapMsg(['ok'], 2),
    ]
    const snap = extractTasklistSnapshot(messages)!
    assert.equal(snap.tasks[0].subject, 'ok')
})

test('tasks 元素畸形（null / 缺字段 / 字段类型错）整条跳过', () => {
    const messages = [
        msg({ details: { tasks: [null, { id: 1, subject: 'A', status: 'pending' }], nextId: 2 } }),
        msg({ details: { tasks: [{ id: 'x', subject: 1, status: 'pending' }], nextId: 2 } }),
        msg({ details: { tasks: [{ id: NaN, subject: 'A', status: 'pending' }], nextId: 2 } }),
        msg({ details: { tasks: [{ id: 1.5, subject: 'A', status: 'pending' }], nextId: 2 } }),
        // 重复 id：update 会覆写全部同 id 步骤、Vue :key 冲突
        msg({ details: { tasks: [{ id: 1, subject: 'A', status: 'pending' }, { id: 1, subject: 'B', status: 'pending' }], nextId: 2 } }),
        msg({ details: { tasks: [{ id: 2, subject: 'A', status: 'pending' }], nextId: 2 } }),
        msg({ details: { tasks: [{ id: 1, subject: 'A' }], nextId: 2 } }),
        snapMsg(['ok'], 2),
    ]
    const snap = extractTasklistSnapshot(messages)!
    assert.equal(snap.tasks[0].subject, 'ok')
})

test('nextId 非有限数（NaN）视为畸形整条跳过', () => {
    assert.equal(extractTasklistSnapshot([msg({ details: { tasks: [], nextId: NaN } })]), null)
})

test('负数 id / id≥nextId / description null 整条跳过', () => {
    assert.equal(extractTasklistSnapshot([msg({ details: { tasks: [{ id: -1, subject: 'A', status: 'pending' }], nextId: 1 } })]), null)
    assert.equal(extractTasklistSnapshot([msg({ details: { tasks: [{ id: 2, subject: 'A', status: 'pending' }], nextId: 2 } })]), null)
    // null 与 undefined 不同：守卫要求缺省或 string，null 拒绝（与服务端对称）
    assert.equal(extractTasklistSnapshot([msg({ details: { tasks: [{ id: 1, subject: 'A', status: 'pending', description: null }], nextId: 2 } })]), null)
})

test('非整数 nextId / 字段类型错 / 超规模快照整条跳过（与服务端守卫同强度）', () => {
    // 非整数 nextId：服务端 create 会派生非法 id 快照，该快照反被守卫拒绝 → 双端静默失步
    assert.equal(extractTasklistSnapshot([msg({ details: { tasks: [], nextId: 2.5 } })]), null)
    assert.equal(extractTasklistSnapshot([msg({ details: { tasks: [{ id: 1, subject: 'A', status: 'pending', description: { evil: 1 } }], nextId: 2 } })]), null)
    assert.equal(extractTasklistSnapshot([msg({ details: { tasks: [{ id: 1, subject: 'A', status: 'pending', activeForm: 9 }], nextId: 2 } })]), null)
    assert.equal(
        extractTasklistSnapshot([msg({ details: { tasks: Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, subject: 'A', status: 'pending' })), nextId: 1002 } })]),
        null,
    )
})

test('空 tasks 快照（clear 后）合法：返回非 null 空快照而非 null', () => {
    const snap = extractTasklistSnapshot([msg({ details: { tasks: [], nextId: 1 } })])
    assert.ok(snap, 'empty tasks snapshot must not be rejected')
    assert.equal(snap!.tasks.length, 0)
    assert.equal(snap!.nextId, 1)
})

test('双源拼接：流式条目必须排在历史之后才赢得 last-write-wins（顺序假设守门）', () => {
    const history = [snapMsg(['old'], 2)]
    const streaming = [snapMsg(['new'], 3)]
    // 流式在后：胜出（面板实时更新的前提）
    assert.equal(extractTasklistSnapshotFromSources(history, streaming)!.tasks[0].subject, 'new')
    // 空流式：回退历史（done 清空临时条目后的接力路径）
    assert.equal(extractTasklistSnapshotFromSources(history, [])!.tasks[0].subject, 'old')
    // 双源都空：null
    assert.equal(extractTasklistSnapshotFromSources([], []), null)
})

test('返回深拷贝，调用方改动不污染源消息', () => {
    const details = { tasks: [{ id: 1, subject: 'A', status: 'pending' }], nextId: 2 }
    const snap = extractTasklistSnapshot([msg({ details })])!
    snap.tasks[0].subject = 'MUTATED'
    assert.equal(details.tasks[0].subject, 'A')
})

// ============================================================
// 面板关闭记忆状态机（applySnapshotToMemory）
// 语义：✕ 任何状态可关闭；重现只由「新活步骤创建」触发；
// 回退、改名、完成、删除都不再影响面板可见性。
// ============================================================

test('applySnapshotToMemory：新活步骤出现 → 面板重现（dismissed 解除）', () => {
    const mem = applySnapshotToMemory({ seen: [1], dismissed: true }, snapOf([{ id: 2, subject: 'B', status: 'pending' }]))
    assert.equal(mem.dismissed, false)
    assert.deepEqual(mem.seen, [1, 2])
})

test('applySnapshotToMemory：已见步骤的变化（完成/删除/改名/回退）不改记忆', () => {
    const mem = { seen: [1, 2], dismissed: true }
    // 完成（状态变化）
    assert.equal(applySnapshotToMemory(mem, snapOf([{ id: 1, subject: 'A', status: 'completed' }, { id: 2, subject: 'B', status: 'in_progress' }])), mem)
    // 删除（墓碑）
    assert.equal(applySnapshotToMemory(mem, snapOf([{ id: 1, subject: 'A', status: 'deleted' }, { id: 2, subject: 'B', status: 'pending' }])), mem)
    // 改名
    assert.equal(applySnapshotToMemory(mem, snapOf([{ id: 2, subject: 'renamed', status: 'pending' }])), mem)
    // 回退到旧结构（快照消失类场景——「完成后自动消失」的根因）
    assert.equal(applySnapshotToMemory(mem, snapOf([{ id: 1, subject: 'A', status: 'completed' }])), mem)
})

test('applySnapshotToMemory：clear（空快照且 nextId 归位）重置记忆', () => {
    const mem = applySnapshotToMemory({ seen: [1, 2, 3], dismissed: true }, snapOf([]))
    assert.deepEqual(mem, { seen: [], dismissed: false })
    // 全墓碑但 nextId 未归位（delete 全部）：不重置，后续 create 的新 id 仍会重现
    const keep = applySnapshotToMemory({ seen: [1, 2], dismissed: true }, snapOf([{ id: 1, subject: 'A', status: 'deleted' }]))
    assert.deepEqual(keep, { seen: [1, 2], dismissed: true })
    // null 快照：不变（返回原引用）
    assert.deepEqual(applySnapshotToMemory({ seen: [1], dismissed: false }, null), { seen: [1], dismissed: false })
})

test('applySnapshotToMemory：无变化返回原引用（调用方据引用判断是否落盘）', () => {
    const mem = { seen: [1], dismissed: false }
    assert.equal(applySnapshotToMemory(mem, snapOf([{ id: 1, subject: 'A', status: 'completed' }])), mem)
    assert.equal(applySnapshotToMemory(mem, null), mem)
})

// ============================================================
// unionSeen：dismiss 的 seen 固化
// ============================================================

test('unionSeen：并入活步骤 id（去重升序），空 seen 场景全量固化', () => {
    // 空 seen（快照稳定期挂载 → watch 从未触发）+ 当前活清单 → 全量固化
    assert.deepEqual(unionSeen([], [3, 1, 2]), [1, 2, 3])
    // 已有 seen 与活清单求并：保留历史已见 id，新 id 去重升序
    assert.deepEqual(unionSeen([1, 2], [2, 3]), [1, 2, 3])
    // 重复 id 不重复出现
    assert.deepEqual(unionSeen([1, 1, 2], [2, 2]), [1, 2])
    // 活清单为空（边界）：原样返回升序结果
    assert.deepEqual(unionSeen([5, 1], []), [1, 5])
    // 双空
    assert.deepEqual(unionSeen([], []), [])
})
