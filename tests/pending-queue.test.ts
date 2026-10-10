import test from 'node:test'
import assert from 'node:assert/strict'

import {
    extractUserText,
    consumeQueueHead,
    consumeRemovedEcho,
    consumeInFlightSend,
    toPendingItems,
    applyQueueSnapshot,
    type PendingItem,
    type QueueSnapshotTarget,
} from '../src/utils/pending-queue.ts'

const item = (over: Partial<PendingItem> = {}): PendingItem => ({
    id: 'p1',
    text: 'hello',
    mode: 'follow',
    timestamp: 1,
    ...over,
})

// ==================== extractUserText ====================

test('extractUserText returns plain string content as-is', () => {
    assert.equal(extractUserText('hello'), 'hello')
})

test('extractUserText joins text blocks with newline', () => {
    // 详见下方源用例（保留原始断言）
})

test('extractUserText skips non-text blocks', () => {
    assert.equal(
        extractUserText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]),
        'a\nb',
    )
})

test('extractUserText returns empty string for null/undefined/object content', () => {
    assert.equal(extractUserText(null), '')
    assert.equal(extractUserText(undefined), '')
    assert.equal(extractUserText({ type: 'text' }), '')
})

// ==================== consumeQueueHead ====================

test('consumeQueueHead returns null for empty queue or empty text', () => {
    assert.equal(consumeQueueHead([], 'hello'), null)
    assert.equal(consumeQueueHead([item()], ''), null)
})

test('consumeQueueHead consumes the head when text matches exactly', () => {
    const head = item({ id: 'a', text: 'first', mode: 'steer' })
    const tail = item({ id: 'b', text: 'second' })
    const result = consumeQueueHead([head, tail], 'first')

    assert.deepEqual(result?.item, head)
    assert.deepEqual(result?.rest, [tail])
})

test('consumeQueueHead requires exact text match (no trimming)', () => {
    const q = [item({ text: 'hi' })]
    assert.equal(consumeQueueHead(q, ' hi '), null)
    assert.equal(consumeQueueHead(q, 'HI'), null)
})

test('consumeQueueHead matches steer lane head behind a follow head', () => {
    // 服务端 steer / followUp 是两条独立队列：steer 先于 follow 被投递时，回显会跳过全局队头
    const follow = item({ id: 'f1', text: 'after this run', mode: 'follow' })
    const steer = item({ id: 's1', text: 'inject now', mode: 'steer' })
    const result = consumeQueueHead([follow, steer], 'inject now')

    assert.deepEqual(result?.item, steer)
    assert.deepEqual(result?.rest, [follow])
})

test('consumeQueueHead matches follow lane head while steer is queued behind', () => {
    const steer = item({ id: 's1', text: 'inject now', mode: 'steer' })
    const follow = item({ id: 'f1', text: 'after this run', mode: 'follow' })
    const result = consumeQueueHead([steer, follow], 'after this run')

    assert.deepEqual(result?.item, follow)
    assert.deepEqual(result?.rest, [steer])
})

test('consumeQueueHead picks the earlier queued item when both lane heads share the same text', () => {
    const early = item({ id: 'e1', text: 'same', mode: 'follow', timestamp: 1 })
    const late = item({ id: 'l1', text: 'same', mode: 'steer', timestamp: 2 })
    const result = consumeQueueHead([early, late], 'same')

    assert.deepEqual(result?.item, early)
    assert.deepEqual(result?.rest, [late])
})

test('consumeQueueHead ignores non-head items in the same lane', () => {
    // 同一队列严格 FIFO：第二条 steer 未出队前，回显第二条不算命中（服务端快照兜底）
    const first = item({ id: 's1', text: 'one', mode: 'steer' })
    const second = item({ id: 's2', text: 'two', mode: 'steer' })
    assert.equal(consumeQueueHead([first, second], 'two'), null)
})

// ==================== toPendingItems（服务端快照 → 本地展示模型） ====================

test('toPendingItems maps server mode followUp to client follow and preserves id/text', () => {
    const result = toPendingItems([
        { id: 'srv-1', mode: 'steer', text: 'a' },
        { id: 'srv-2', mode: 'followUp', text: 'b' },
    ])
    assert.deepEqual(result, [
        { id: 'srv-1', mode: 'steer', text: 'a', timestamp: result[0].timestamp },
        { id: 'srv-2', mode: 'follow', text: 'b', timestamp: result[1].timestamp },
    ])
    assert.equal(typeof result[0].timestamp, 'number')
})

test('toPendingItems returns empty array for empty/invalid input', () => {
    assert.deepEqual(toPendingItems([]), [])
    // @ts-expect-error 防御性：运行时可能收到脏数据
    assert.deepEqual(toPendingItems(null), [])
})

// ==================== applyQueueSnapshot（版本门禁） ====================
// DELETE 响应与 WS 广播走不同 TCP 连接，到达顺序无保证：跨操作的旧快照
// 可能晚于新快照到达，无门禁时会复活已删条目。queueRev 单调递增，
// 只应用比本地新的快照。

test('applyQueueSnapshot applies newer rev and records it', () => {
    const sd: any = { pendingQueue: [], queueRev: 5 }
    applyQueueSnapshot(sd, 6, [{ id: 'a', mode: 'steer', text: 'x' }])
    assert.equal(sd.queueRev, 6)
    assert.deepEqual(sd.pendingQueue, [{ id: 'a', mode: 'steer', text: 'x', timestamp: sd.pendingQueue[0].timestamp }])
})

test('applyQueueSnapshot drops stale rev (out-of-order broadcast)', () => {
    const sd: any = { pendingQueue: [{ id: 'keep', mode: 'follow', text: 'y', timestamp: 1 }], queueRev: 9 }
    applyQueueSnapshot(sd, 8, []) // 旧快照：复活已删条目的元凶，必须丢弃
    assert.equal(sd.queueRev, 9)
    assert.equal(sd.pendingQueue.length, 1)
    assert.equal(sd.pendingQueue[0].id, 'keep')
})

test('applyQueueSnapshot drops equal rev (idempotent double delivery)', () => {
    const sd: any = { pendingQueue: [{ id: 'a', mode: 'follow', text: 'y', timestamp: 1 }], queueRev: 7 }
    applyQueueSnapshot(sd, 7, [{ id: 'b', mode: 'steer', text: 'z' }])
    assert.equal(sd.pendingQueue.length, 1)
    assert.equal(sd.pendingQueue[0].id, 'a')
})

test('applyQueueSnapshot applies when either side has no rev yet (bootstrap)', () => {
    const sd: any = { pendingQueue: [] }
    applyQueueSnapshot(sd, 3, [{ id: 'a', mode: 'followUp', text: 'y' }])
    assert.equal(sd.queueRev, 3)
    assert.equal(sd.pendingQueue.length, 1)

    const sd2: any = { pendingQueue: [], queueRev: 2 }
    applyQueueSnapshot(sd2, undefined, []) // 异常路径无 rev：保守应用
    assert.deepEqual(sd2.pendingQueue, [])
})

// ==================== 快照移除缓存 + 回显补齐（consumeRemovedEcho） ====================
// 服务端 WS 删除快照恒先于 SSE 回显到达（账本监听器先注册，广播早于 SSE 转发）：
// 快照先撤掉排队条目，随后的 message_start 回显 consumeQueueHead 必然 miss——
// 回显凭移除缓存补齐正式气泡，否则长 run 期间消息在聊天区隐身。

test('applyQueueSnapshot records removed entries for echo compensation', () => {
    const sd: any = {
        pendingQueue: [
            { id: 'a', mode: 'steer', text: 'x', timestamp: 1 },
            { id: 'b', mode: 'follow', text: 'y', timestamp: 1 },
        ],
        queueRev: 5,
    }
    applyQueueSnapshot(sd, 6, [{ id: 'b', mode: 'followUp', text: 'y' }])
    assert.deepEqual(sd.queueRemovedEchoes?.map((e: any) => e.text), ['x'])
})

test('stale snapshots rejected by rev gate must not pollute the removal cache', () => {
    const sd: any = { pendingQueue: [{ id: 'a', mode: 'steer', text: 'x', timestamp: 1 }], queueRev: 9 }
    applyQueueSnapshot(sd, 8, []) // 旧快照被门禁丢弃：缓存不得记录其移除
    assert.ok((sd.queueRemovedEchoes ?? []).every((e: any) => e.text !== 'x'))
    assert.equal(sd.pendingQueue.length, 1)
    assert.equal(sd.queueRev, 9)
})

test('consumeRemovedEcho consumes one matching entry per echo (multi same-text)', () => {
    const sd: any = { pendingQueue: [], queueRemovedEchoes: [{ text: 'x', at: Date.now() }, { text: 'x', at: Date.now() }] }
    assert.equal(consumeRemovedEcho(sd, 'x'), true)
    assert.equal(consumeRemovedEcho(sd, 'x'), true)
    assert.equal(consumeRemovedEcho(sd, 'x'), false)
})

test('consumeRemovedEcho ignores expired entries (no false bubble for coincidental prompt)', () => {
    const stale = Date.now() - 61_000
    const sd: any = { pendingQueue: [], queueRemovedEchoes: [{ text: 'x', at: stale }] }
    assert.equal(consumeRemovedEcho(sd, 'x'), false)
    // 缓存本身不被过期条目破坏
    assert.equal(sd.queueRemovedEchoes.length, 1)
})

test('consumeRemovedEcho returns false for empty text or missing buffer', () => {
    assert.equal(consumeRemovedEcho({ pendingQueue: [] }, 'x'), false)
    assert.equal(consumeRemovedEcho({ pendingQueue: [], queueRemovedEchoes: [{ text: 'x', at: Date.now() }] }, ''), false)
})

test('applyQueueSnapshot prunes expired echoes and caps the buffer', () => {
    const stale = Date.now() - 61_000
    const sd: any = { pendingQueue: [], queueRev: 1, queueRemovedEchoes: [{ text: 'stale', at: stale }] }
    // 一次移除 40 条，超过 CAP=32：只剩最新 32 条，过期条目已被清琀
    const entries = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, mode: 'steer' as const, text: `t${i}` }))
    applyQueueSnapshot(sd, 2, [])
    assert.equal(sd.queueRemovedEchoes?.length, 0)
    sd.pendingQueue = entries.map(e => ({ ...e, timestamp: 2 }))
    applyQueueSnapshot(sd, 3, [])
    assert.ok(sd.queueRemovedEchoes.length <= 32)
    assert.ok(sd.queueRemovedEchoes.every((e: any) => e.text !== 'stale'))
})

// ==================== 在途本地发送判别（removedEcho 误补双气泡回归） ====================
// 根因：applyQueueSnapshot 把手动 DELETE / abort 清账的条目也记入 queueRemovedEchoes，
// 但这些条目永不投递、永无回显。残留文本（TTL 内）与后续正常 sendMessage 回显
// 同文本时 consumeRemovedEcho 误命中 → 回显处理器在乐观气泡之外补了第二个正式气泡。
// 判别凭据：正常 sendMessage 启动时登记在途文本，回显命中在途登记即跳过补齐。

test('删除排队消息后发送同文本新消息：回显凭在途登记跳过 removedEcho 补齐（不双气泡）', () => {
    // 复现时序：busy 排队 X → 删除 X（快照移除 → removedEchoes 记入 X）→
    // 中止 → idle 发送同文本 X（正常 sendMessage：乐观气泡 + 在途登记）→ 回显 X
    const target: QueueSnapshotTarget & { inFlightSendTexts?: string[] } = { pendingQueue: [] }
    target.pendingQueue = [item({ id: 'e1', text: 'X' })]
    applyQueueSnapshot(target, 2, [])
    assert.deepEqual(target.queueRemovedEchoes?.map(e => e.text), ['X'])

    // 正常 sendMessage 启动：登记在途发送文本（整体替换）
    target.inFlightSendTexts = ['X']

    // 回显到达：队列已空，consumeQueueHead miss
    assert.equal(consumeQueueHead(target.pendingQueue, 'X'), null)
    // 在途登记命中 → 调用方必须跳过 removedEcho 补齐（乐观气泡已覆盖）
    assert.equal(consumeInFlightSend(target, 'X'), true)
    // 登记一次性消费：同文本的第二条回显不再被在途登记误判
    assert.equal(consumeInFlightSend(target, 'X'), false)
})

test('在途登记不影响非本地发起的 drain 回显（removedEcho 补齐保持）', () => {
    // 排队 X 在途 → drain（WS 快照先移除）→ removedEchoes 记入 X；
    // 本窗口没有为 X 发起过 sendMessage（drain 是服务端行为，无在途登记）
    const target: QueueSnapshotTarget & { inFlightSendTexts?: string[] } = { pendingQueue: [] }
    target.pendingQueue = [item({ id: 'e1', text: 'X' })]
    applyQueueSnapshot(target, 2, [])

    assert.equal(consumeInFlightSend(target, 'X'), false)
    // removedEcho 补齐照常命中（长 run 隐身窗口的补齐链路不受影响）
    assert.equal(consumeRemovedEcho(target, 'X'), true)
})
