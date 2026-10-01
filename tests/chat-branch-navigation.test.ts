import test from 'node:test'
import assert from 'node:assert/strict'

import {
    buildBranchIndexes,
    findLeafId,
    getBranchInfo,
    type BranchMessageLike,
    type SessionTreeEntry,
} from '../src/utils/chatBranchNavigation.ts'

const getInfo = (tree: SessionTreeEntry[], msg: BranchMessageLike) =>
    getBranchInfo(msg, buildBranchIndexes(tree))

test('assistant branch navigation ignores dead user branches without assistant descendants', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'root', parentId: null, type: 'root' },
        { id: 'user-dead', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'user-live', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'assistant-live', parentId: 'user-live', type: 'message', message: { role: 'assistant' } },
    ]

    const info = getInfo(tree, {
        role: 'assistant',
        entryId: 'assistant-live',
        parentEntryId: 'user-live',
    })

    assert.equal(info, null)
})

test('assistant branch navigation keeps sibling user branches that both resolve to assistant replies', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'root', parentId: null, type: 'root' },
        { id: 'user-a', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'meta-a', parentId: 'user-a', type: 'session_info' },
        { id: 'assistant-a', parentId: 'meta-a', type: 'message', message: { role: 'assistant' } },
        { id: 'user-b', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'assistant-b', parentId: 'user-b', type: 'message', message: { role: 'assistant' } },
    ]

    const indexes = buildBranchIndexes(tree)
    const info = getBranchInfo(
        {
            role: 'assistant',
            entryId: 'assistant-b',
            parentEntryId: 'user-b',
        },
        indexes,
    )

    assert.deepEqual(info, {
        siblings: ['user-a', 'user-b'],
        currentIndex: 1,
    })
    assert.equal(findLeafId('user-a', indexes), 'assistant-a')
    assert.equal(findLeafId('user-b', indexes), 'assistant-b')
})

test('direct assistant siblings still produce branch navigation', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'root', parentId: null, type: 'root' },
        { id: 'user-1', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'assistant-a', parentId: 'user-1', type: 'message', message: { role: 'assistant' } },
        { id: 'assistant-b', parentId: 'user-1', type: 'message', message: { role: 'assistant' } },
    ]

    const info = getInfo(tree, {
        role: 'assistant',
        entryId: 'assistant-b',
        parentEntryId: 'user-1',
    })

    assert.deepEqual(info, {
        siblings: ['assistant-a', 'assistant-b'],
        currentIndex: 1,
    })
})

test('branch navigation still works when entries API omits message payloads', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'root', parentId: null, type: 'root' },
        { id: 'user-a', parentId: 'root', type: 'message' },
        { id: 'assistant-a', parentId: 'user-a', type: 'message' },
        { id: 'user-b', parentId: 'root', type: 'message' },
        { id: 'assistant-b', parentId: 'user-b', type: 'message' },
    ]

    const info = getInfo(tree, {
        role: 'assistant',
        entryId: 'assistant-b',
        parentEntryId: 'user-b',
    })

    assert.deepEqual(info, {
        siblings: ['user-a', 'user-b'],
        currentIndex: 1,
    })
})

test('deleted assistant siblings are excluded from direct assistant branch navigation', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'root', parentId: null, type: 'root' },
        { id: 'user-1', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'assistant-dead', parentId: 'user-1', type: 'message', message: { role: 'assistant', deletedAt: '2026-03-17T00:00:00Z' } },
        { id: 'assistant-live', parentId: 'user-1', type: 'message', message: { role: 'assistant' } },
    ]

    const info = getInfo(tree, {
        role: 'assistant',
        entryId: 'assistant-live',
        parentEntryId: 'user-1',
    })

    assert.equal(info, null)
})

test('branch lookup skips empty non-message child paths and finds assistant on later child path', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'root', parentId: null, type: 'root' },
        { id: 'user-a', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'meta-empty', parentId: 'user-a', type: 'session_info' },
        { id: 'meta-real', parentId: 'user-a', type: 'session_info' },
        { id: 'assistant-a', parentId: 'meta-real', type: 'message', message: { role: 'assistant' } },
        { id: 'user-b', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'assistant-b', parentId: 'user-b', type: 'message', message: { role: 'assistant' } },
    ]

    const indexes = buildBranchIndexes(tree)
    const info = getBranchInfo(
        {
            role: 'assistant',
            entryId: 'assistant-b',
            parentEntryId: 'user-b',
        },
        indexes,
    )

    assert.deepEqual(info, {
        siblings: ['user-a', 'user-b'],
        currentIndex: 1,
    })
    assert.equal(findLeafId('user-a', indexes), 'assistant-a')
})

// 回归钉子（2026-09-20 session 01a0bf01）：用户在收到回复前点停止 → 空 aborted
// assistant 消息落盘（content=[]），该分支唯一可见锚点是 user 消息。
// user 角色消息必须能拿到与 assistant 侧一致的兄弟分支列表，否则该分支
// 没有任何导航挂载点，切进去就是死胡同。
test('user message on aborted-branch resolves sibling navigation and leaf through meta entries', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'root', parentId: null, type: 'root' },
        { id: 'meta-model', parentId: 'root', type: 'model_change' },
        { id: 'meta-thinking', parentId: 'meta-model', type: 'thinking_level_change' },
        { id: 'user-1', parentId: 'meta-thinking', type: 'message', message: { role: 'user' } },
        { id: 'meta-state', parentId: 'user-1', type: 'custom' },
        { id: 'meta-info', parentId: 'meta-state', type: 'session_info' },
        { id: 'assistant-aborted', parentId: 'meta-info', type: 'message', message: { role: 'assistant' } },
        { id: 'branch-summary', parentId: 'assistant-aborted', type: 'branch_summary' },
        { id: 'user-2', parentId: 'meta-thinking', type: 'message', message: { role: 'user' } },
        { id: 'meta-state-2', parentId: 'user-2', type: 'custom' },
        { id: 'assistant-2', parentId: 'meta-state-2', type: 'message', message: { role: 'assistant' } },
    ]

    const indexes = buildBranchIndexes(tree)

    // user 气泡上的导航：ownSiblings 即分支列表
    assert.deepEqual(
        getBranchInfo({ role: 'user', entryId: 'user-1', parentEntryId: 'meta-thinking' }, indexes),
        { siblings: ['user-1', 'user-2'], currentIndex: 0 },
    )
    // 与 assistant 气泡侧（分支2）的 parentSiblings 是同一批 user id
    assert.deepEqual(
        getBranchInfo({ role: 'assistant', entryId: 'assistant-2', parentEntryId: 'meta-state-2' }, indexes),
        { siblings: ['user-1', 'user-2'], currentIndex: 1 },
    )
    // 叶子解析穿过 custom/session_info 到达空 aborted assistant
    assert.equal(findLeafId('user-1', indexes), 'branch-summary')
})

// 复审钉子（3eea829 发现 B）：user 尾锚的兄弟列表必须与 assistant 侧 parentSiblings
// 同口径——只数「自己 + 有活跃消息后代的兄弟」。无活跃后代的分支（回复被删光）
// 不占计数、不从活分支跳入；自身恒保留（死分支的逃逸锚点）。assistant 直系兄弟
// 不走此过滤（回复级分支，契约见上方 direct assistant siblings 钉子）。
test('user branch-tail navigation filters reply-less siblings but keeps self', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'root', parentId: null, type: 'root' },
        // 分支1：尾部 user 消息，其下是零渲染的空 aborted assistant（真实 entry，非删除）
        { id: 'user-tail', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'assistant-aborted', parentId: 'user-tail', type: 'message', message: { role: 'assistant' } },
        // 分支2：回复被删光的死分支
        { id: 'user-dead', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'assistant-deleted', parentId: 'user-dead', type: 'message', message: { role: 'assistant', deletedAt: '2026-03-17T00:00:00Z' } },
        // 分支3：有活跃回复的活分支
        { id: 'user-live', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'assistant-live', parentId: 'user-live', type: 'message', message: { role: 'assistant' } },
    ]

    const indexes = buildBranchIndexes(tree)

    // 从死分支尾锚出发：user-dead 被过滤（无活跃后代），自身保留 → 可逃逸到活分支
    assert.deepEqual(
        getBranchInfo({ role: 'user', entryId: 'user-dead', parentEntryId: 'root' }, indexes),
        { siblings: ['user-tail', 'user-dead', 'user-live'], currentIndex: 1 },
    )
    // 从空 aborted 尾锚出发：自身保留（真实 entry 计为活跃后代），user-dead 过滤
    assert.deepEqual(
        getBranchInfo({ role: 'user', entryId: 'user-tail', parentEntryId: 'root' }, indexes),
        { siblings: ['user-tail', 'user-live'], currentIndex: 0 },
    )
    // 从活分支 user 消息出发：与 assistant 侧 parentSiblings 完全同口径（死分支不占计数）
    assert.deepEqual(
        getBranchInfo({ role: 'user', entryId: 'user-live', parentEntryId: 'root' }, indexes),
        { siblings: ['user-tail', 'user-live'], currentIndex: 1 },
    )
    assert.deepEqual(
        getBranchInfo({ role: 'assistant', entryId: 'assistant-live', parentEntryId: 'user-live' }, indexes),
        { siblings: ['user-tail', 'user-live'], currentIndex: 1 },
    )
})

// 过滤后仅剩自身时返回 null：没有可切目标就不挂导航（与 assistant 侧一致）
test('user branch-tail navigation returns null when only self survives filtering', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'root', parentId: null, type: 'root' },
        { id: 'user-dead', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'assistant-deleted', parentId: 'user-dead', type: 'message', message: { role: 'assistant', deletedAt: '2026-03-17T00:00:00Z' } },
        { id: 'user-live', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'assistant-live-deleted', parentId: 'user-live', type: 'message', message: { role: 'assistant', deletedAt: '2026-03-17T00:00:00Z' } },
    ]

    const indexes = buildBranchIndexes(tree)

    assert.equal(
        getBranchInfo({ role: 'user', entryId: 'user-dead', parentEntryId: 'root' }, indexes),
        null,
    )
})

test('root 级兄弟分支：root 重试产生的首层分支可导航', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'u1', parentId: null, type: 'message', message: { role: 'user' } },
        { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant' } },
        { id: 'u2', parentId: null, type: 'message', message: { role: 'user' } },
        { id: 'a2', parentId: 'u2', type: 'message', message: { role: 'assistant' } },
    ]
    // 新分支尾（u2）与旧分支（u1）互为 root 兄弟
    assert.deepEqual(getInfo(tree, { role: 'user', entryId: 'u2', parentEntryId: null }), {
        siblings: ['u1', 'u2'],
        currentIndex: 1,
    })
    assert.deepEqual(getInfo(tree, { role: 'user', entryId: 'u1', parentEntryId: null }), {
        siblings: ['u1', 'u2'],
        currentIndex: 0,
    })
})

test('root 级 assistant 兄弟：直系回复级分支计数不衰减', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'u1', parentId: null, type: 'message', message: { role: 'user' } },
        { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant' } },
        { id: 'a2', parentId: 'u1', type: 'message', message: { role: 'assistant' } },
    ]
    assert.deepEqual(getInfo(tree, { role: 'assistant', entryId: 'a2', parentEntryId: 'u1' }), {
        siblings: ['a1', 'a2'],
        currentIndex: 1,
    })
})

test('root 唯一首层消息（无 root 重试发生）：不出现分支导航', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'u1', parentId: null, type: 'message', message: { role: 'user' } },
        { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant' } },
    ]
    assert.equal(getInfo(tree, { role: 'user', entryId: 'u1', parentEntryId: null }), null)
})

test('既有合成 root entry 形状（parentId 指向 type:root 条目）回归不变', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'root', parentId: null, type: 'root' },
        { id: 'u1', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant' } },
        { id: 'u2', parentId: 'root', type: 'message', message: { role: 'user' } },
        { id: 'a2', parentId: 'u2', type: 'message', message: { role: 'assistant' } },
    ]
    assert.deepEqual(getInfo(tree, { role: 'user', entryId: 'u1', parentEntryId: 'root' }), {
        siblings: ['u1', 'u2'],
        currentIndex: 0,
    })
})

test('无后代的首层消息不可作分支导航（既有活后代过滤语义，root 与否一致）', () => {
    const tree: SessionTreeEntry[] = [
        { id: 'u1', parentId: null, type: 'message', message: { role: 'user' } },
        { id: 'u2', parentId: null, type: 'message', message: { role: 'user' } },
    ]
    assert.equal(getInfo(tree, { role: 'user', entryId: 'u2', parentEntryId: null }), null)
})
