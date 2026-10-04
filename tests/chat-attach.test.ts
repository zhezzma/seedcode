import test from 'node:test'
import assert from 'node:assert/strict'

import {
    applyAttachMessageState,
    getLastMessageEntryId,
    isLiveStreamBlock,
    markLiveStreamBlock,
    shouldAttachSession,
} from '../src/utils/chat-attach.ts'

function createSessionData() {
    return {
        chatMessages: [],
        chatToolMessages: [],
        sessionTree: null,
        chatStream: null,
        chatStreamStartedAt: null,
        chatSending: false,
        chatRunId: null,
        chatLoading: false,
    }
}

test('shouldAttachSession only when there is no active SSE', () => {
    assert.equal(shouldAttachSession(false), true)
    assert.equal(shouldAttachSession(true), false)
})

test('live stream block marker: multi-mark survives delta switching, isolated per stream, JSON-safe', () => {
    const streamA = [{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'b' }]
    const streamB = [{ type: 'thinking', thinking: 'c' }]

    assert.equal(isLiveStreamBlock(streamA, streamA[0]), false, 'unmarked stream has no live block')

    markLiveStreamBlock(streamA, streamA[0])
    assert.equal(isLiveStreamBlock(streamA, streamA[0]), true)
    assert.equal(isLiveStreamBlock(streamA, streamA[1]), false)

    // 交错推理：text_delta 落到另一块后，先前标记的思考块不能丢标记（单标记会
    // 被「挬走」，导致仍在增长的思考块在 text/thinking 交错间隙被误判为已定格）
    markLiveStreamBlock(streamA, streamA[1])
    assert.equal(isLiveStreamBlock(streamA, streamA[0]), true, 'thinking block must stay live during interleaved text deltas')
    assert.equal(isLiveStreamBlock(streamA, streamA[1]), true)

    // 标记存在流数组上：多会话并发（各自独立 chatStream）互不串扰
    assert.equal(isLiveStreamBlock(streamB, streamB[0]), false)

    // JSON 序列化不污染块（message_end 固化/快照拷贝天然剥离）
    assert.deepEqual(JSON.parse(JSON.stringify(streamA)), [
        { type: 'thinking', thinking: 'a' },
        { type: 'text', text: 'b' },
    ])

    // 历史消息内容（普通数组，无标记）恒为 false
    assert.equal(isLiveStreamBlock(undefined, streamA[1]), false)
    assert.equal(isLiveStreamBlock(null, streamA[1]), false)
    // 防御：空入参不抛
    assert.doesNotThrow(() => markLiveStreamBlock(null, streamA[0]))
    assert.doesNotThrow(() => markLiveStreamBlock(streamA, undefined))
})

test('getLastMessageEntryId reads the last persisted message entry id', () => {
    assert.equal(getLastMessageEntryId([]), undefined)
    assert.equal(getLastMessageEntryId([
        { role: 'user', content: 'a', entryId: 'm1' },
        { role: 'assistant', content: 'b', entryId: 'm2' },
    ] as any), 'm2')
})

test('applyAttachMessageState replaces full history when messages are present', () => {
    const sessionData = createSessionData()
    sessionData.chatMessages = [{ role: 'user', content: 'old', entryId: 'old-1' }] as any

    applyAttachMessageState(sessionData as any, {
        messages: [{ role: 'assistant', content: 'new', entryId: 'new-1' }] as any,
        streamMessage: null,
        isStreaming: false,
    })

    assert.deepEqual(sessionData.chatMessages, [{ role: 'assistant', content: 'new', entryId: 'new-1' }])
    assert.equal(sessionData.chatSending, false)
    assert.equal(sessionData.chatStream, null)
})

test('applyAttachMessageState appends deduped delta messages', () => {
    const sessionData = createSessionData()
    sessionData.chatMessages = [
        { role: 'user', content: 'u1', entryId: 'm1' },
        { role: 'assistant', content: 'a1', entryId: 'm2' },
    ] as any

    applyAttachMessageState(sessionData as any, {
        deltaMessages: [
            { role: 'assistant', content: 'dup', entryId: 'm2' },
            { role: 'user', content: 'u2', entryId: 'm3' },
        ] as any,
        streamMessage: null,
        isStreaming: false,
    })

    assert.deepEqual(sessionData.chatMessages, [
        { role: 'user', content: 'u1', entryId: 'm1' },
        { role: 'assistant', content: 'a1', entryId: 'm2' },
        { role: 'user', content: 'u2', entryId: 'm3' },
    ])
})

test('applyAttachMessageState restores stream content when attach lands on an active stream', () => {
    const sessionData = createSessionData()

    applyAttachMessageState(sessionData as any, {
        streamMessage: {
            content: [{ type: 'text', text: 'partial' }],
        },
        isStreaming: true,
    })

    assert.equal(sessionData.chatSending, true)
    assert.deepEqual(sessionData.chatStream, [{ type: 'text', text: 'partial' }])
})

test('attach replay re-marks thinking blocks live so streaming thinking stays plain text', () => {
    const sessionData = createSessionData()

    applyAttachMessageState(sessionData as any, {
        streamMessage: {
            content: [
                { type: 'thinking', thinking: 'half-thought' },
                { type: 'text', text: 'partial' },
            ],
        },
        isStreaming: true,
    })

    // 重放重建的流数组是全新对象（JSON 深拷贝），原标记天然丢失——必须补标记，
    // 否则重连后到下一个 delta 到达前，增长中的思考块被误判为已定格而走 markdown
    const stream = sessionData.chatStream as any[]
    const thinking = stream.find((b: any) => b.type === 'thinking')
    assert.ok(isLiveStreamBlock(stream, thinking), 'replayed thinking block must be live')
})

test('applyAttachMessageState strips stale toolCall blocks from replayed stream snapshot', () => {
    const sessionData = createSessionData()

    applyAttachMessageState(sessionData as any, {
        streamMessage: {
            content: [
                { type: 'thinking', thinking: 'partial thought' },
                // attach 时刻参数还在流式传输中：partial-json 会把未传完的字符串
                // 解析成空串，这种过期快照不应进入客户端状态
                {
                    type: 'toolCall',
                    id: 'call_1',
                    name: 'subagent',
                    arguments: { agent: '{"name": "code_reviewer"}', mode: 'single', task: '' },
                },
            ],
        },
        isStreaming: true,
    })

    // 注意不比较整个数组（markLiveStreamBlock 在流数组上挂 __liveBlocks expando，
    // 整组 deepEqual 会看到）；按元素比较块内容
    assert.deepEqual([...(sessionData.chatStream as any[])], [{ type: 'thinking', thinking: 'partial thought' }])
})

test('applyAttachMessageState keeps empty stream when snapshot only contained a toolCall', () => {
    const sessionData = createSessionData()

    applyAttachMessageState(sessionData as any, {
        streamMessage: {
            content: [{ type: 'toolCall', id: 'call_1', name: 'subagent', arguments: {} }],
        },
        isStreaming: true,
    })

    assert.deepEqual(sessionData.chatStream, [])
})

test('applyAttachMessageState clears stale stream content for idle attach responses', () => {
    const sessionData = createSessionData()
    sessionData.chatStream = [{ type: 'text', text: 'stale' }]
    sessionData.chatSending = true

    applyAttachMessageState(sessionData as any, {
        streamMessage: null,
        isStreaming: false,
    })

    assert.equal(sessionData.chatSending, false)
    assert.equal(sessionData.chatStream, null)
})

test('applyAttachMessageState restores busy + compacting from a mid-compaction snapshot', () => {
    // 切会话/刷新落在压缩窗口：isStreaming=false 而 compacting=true（2026-09 服务端
    // attach 语义），据此恢复 busy 与压缩指示器；后续 compaction_end/续跑事件继续驱动
    const sessionData = createSessionData()

    applyAttachMessageState(sessionData as any, {
        streamMessage: null,
        isStreaming: false,
        compacting: true,
    })

    assert.equal(sessionData.compacting, true)
    assert.equal(sessionData.chatSending, true)
    assert.equal(sessionData.chatStream, null)
})

test('applyAttachMessageState ignores absent compacting field (legacy server)', () => {
    // 旧服务端 message_state 不携带 compacting：缺省不动本地压缩态
    const sessionData = createSessionData()
    sessionData.compacting = true

    applyAttachMessageState(sessionData as any, {
        streamMessage: null,
        isStreaming: true,
    })

    assert.equal(sessionData.compacting, true)
    assert.equal(sessionData.chatSending, true)
})

test('applyAttachMessageState clears compacting when snapshot says idle', () => {
    const sessionData = createSessionData()
    sessionData.compacting = true

    applyAttachMessageState(sessionData as any, {
        streamMessage: null,
        isStreaming: false,
        compacting: false,
    })

    assert.equal(sessionData.compacting, false)
    assert.equal(sessionData.chatSending, false)
})
