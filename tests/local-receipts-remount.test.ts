/**
 * remountLocalReceipts 锚点重挂规则钉子（!! bash-receipt 会话内驻留机制的核心）：
 * - anchor 命中快照 → 插锚后（同锚多条按登记顺序接续）
 * - 快照非空而 anchor 缺失 → 丢弃（/reset 或分支切换后不复活——跨窗口 reset、
 *   跨分支不回魂是锚点规则相对 timestamp 比较的关键正确性收益）
 * - 无 anchor（登记时会话尚无 durable 消息）→ 插头部
 * - 快照为空 → 无锚回执保留尾部
 * - 按 id 去重幂等（回滚快照已含回执条目时跳过）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { remountLocalReceipts } from '../src/utils/chat-attach.ts'

/** 最小 ChatSessionData 形状（remountLocalReceipts 只触碰 chatMessages/localReceipts） */
function makeSd(messages: any[], receipts: any[]) {
    return { chatMessages: messages, chatToolMessages: [], localReceipts: receipts } as any
}

const user1 = { role: 'user', content: 'hi', entryId: 'e1' }
const asst1 = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], entryId: 'e2' }

test('anchor 命中 → 插锚后（回执落在它登记时所在的位置）', () => {
    const sd = makeSd([user1, asst1], [
        { id: 'r1', role: 'custom', customType: 'bash-receipt', content: '$ !!ls\n退出码: 0', anchor: 'e1' },
    ])
    remountLocalReceipts(sd)
    assert.deepEqual(sd.chatMessages.map((m: any) => m.id ?? m.entryId), ['e1', 'r1', 'e2'])
})

test('anchor 缺失且快照非空 → 丢弃（/reset 或分支切换后不复活）', () => {
    const sd = makeSd([user1, asst1], [
        { id: 'r1', role: 'custom', customType: 'bash-receipt', content: '$ !!ls', anchor: 'e-erased' },
    ])
    remountLocalReceipts(sd)
    assert.equal(sd.chatMessages.length, 2, '旧时代回执不得复活')
})

test('无 anchor + 快照非空 → 插头部（登记时会话尚无 durable 消息，早于快照全部消息）', () => {
    const sd = makeSd([user1], [
        { id: 'r1', role: 'custom', customType: 'bash-receipt', content: '$ !!ls', anchor: null },
    ])
    remountLocalReceipts(sd)
    assert.deepEqual(sd.chatMessages.map((m: any) => m.id ?? m.entryId), ['r1', 'e1'])
})

test('快照为空 + 无锚回执 → 保留（新会话首条命令的回执）；有锚 → 丢弃', () => {
    const keep = makeSd([], [{ id: 'r1', role: 'custom', customType: 'bash-receipt', content: '$ !!ls', anchor: null }])
    remountLocalReceipts(keep)
    assert.equal(keep.chatMessages.length, 1)

    const drop = makeSd([], [{ id: 'r1', role: 'custom', customType: 'bash-receipt', content: '$ !!ls', anchor: 'e-old' }])
    remountLocalReceipts(drop)
    assert.equal(drop.chatMessages.length, 0)
})

test('同锚多条按登记顺序接续（不因逐条插锚后而逆序）', () => {
    const sd = makeSd([user1, asst1], [
        { id: 'r1', role: 'custom', customType: 'bash-receipt', content: 'first', anchor: 'e1' },
        { id: 'r2', role: 'custom', customType: 'bash-receipt', content: 'second', anchor: 'e1' },
    ])
    remountLocalReceipts(sd)
    assert.deepEqual(sd.chatMessages.map((m: any) => m.id ?? m.entryId), ['e1', 'r1', 'r2', 'e2'])
})

test('按 id 去重幂等：目标列表已含同 id 回执（回滚快照）时跳过，重复调用不翻倍', () => {
    const receipt = { id: 'r1', role: 'custom', customType: 'bash-receipt', content: '$ !!ls', anchor: 'e1' }
    const sd = makeSd([user1, { ...receipt }], [receipt])
    remountLocalReceipts(sd)
    assert.equal(sd.chatMessages.length, 2, 'id 已存在不重复插入')

    const sd2 = makeSd([user1, asst1], [
        { id: 'r1', role: 'custom', customType: 'bash-receipt', content: 'first', anchor: 'e1' },
    ])
    remountLocalReceipts(sd2)
    const once = sd2.chatMessages.length
    remountLocalReceipts(sd2)
    assert.equal(sd2.chatMessages.length, once, '幂等：重复重挂不翻倍')
})

test('localReceipts 为空/缺省 → 无操作（旧会话数据形状兼容）', () => {
    const sd = makeSd([user1], undefined)
    remountLocalReceipts(sd)
    assert.equal(sd.chatMessages.length, 1)
})
