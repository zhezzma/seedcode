import test from 'node:test'
import assert from 'node:assert/strict'

import {
    blocksTextSignature,
    hasAssistantTextContent,
    solidifyAssistantContent,
} from '../src/utils/chat-solidify.ts'
import { markContentIndex, replayPartialBlocks } from '../src/utils/chat-attach.ts'

// 流内 _ci 与生产路径一致：不可枚举（JSON 拷贝/固化天然剥离）
function ci(block: object, contentIndex: number): object {
    markContentIndex(block, contentIndex)
    return block
}

const neverInHistory = () => false

// ── hasAssistantTextContent：固化门禁（超短回复整条只在 message_end 落位）──

test('hasAssistantTextContent 只认 assistant 的非空 text/thinking 块', () => {
    assert.equal(hasAssistantTextContent({ role: 'assistant', content: [{ type: 'text', text: '全绿（除基线）' }] }), true)
    assert.equal(hasAssistantTextContent({ role: 'assistant', content: [{ type: 'thinking', thinking: '思路' }] }), true)
    assert.equal(hasAssistantTextContent({ role: 'assistant', content: [{ type: 'text', text: '' }] }), false)
    assert.equal(hasAssistantTextContent({ role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'bash' }] }), false)
    assert.equal(hasAssistantTextContent({ role: 'assistant', content: '纯字符串旧形状' }), false)
    assert.equal(hasAssistantTextContent({ role: 'user', content: [{ type: 'text', text: '你好呀' }] }), false)
    assert.equal(hasAssistantTextContent(undefined), false)
})

// ── 补头/补尾：本地块是权威块的子串，整块替换 ──

test('缺头（message_start 首批丢失）：按 _ci 对位整块替换为权威全文', () => {
    const stream = [{ type: 'text', text: '除基线既有失败）。第三轮审查确认：' }]
    ci(stream[0], 0)
    const solidified = solidifyAssistantContent(
        stream,
        [{ type: 'text', text: '全绿（除基线既有失败）。第三轮审查确认：' }],
        { isToolCallInHistory: neverInHistory },
    )
    assert.deepEqual(solidified, [{ type: 'text', text: '全绿（除基线既有失败）。第三轮审查确认：' }])
})

test('缺尾（最后一次 flush 之后的末批只在 message_end）：替换补齐', () => {
    const stream = [{ type: 'text', text: '第一轮修复（锁内原子分发租借。' }]
    ci(stream[0], 0)
    const solidified = solidifyAssistantContent(
        stream,
        [{ type: 'text', text: '第一轮修复（锁内原子分发租借 + TOCTOU 方向反转）。' }],
        { isToolCallInHistory: neverInHistory },
    )
    assert.equal((solidified[0] as any).text, '第一轮修复（锁内原子分发租借 + TOCTOU 方向反转）。')
})

test('跨块首批丢失（text_start/block change 不下发）：权威块整块替换 thinking 后的正文', () => {
    const stream = [
        { type: 'thinking', thinking: '思考全文' },
        { type: 'text', text: '向反了是我写错、逐项修。' }, // 正文块首批（TOCTOU 方）被投影丢弃
    ]
    ci(stream[0], 0)
    ci(stream[1], 1)
    const solidified = solidifyAssistantContent(
        stream,
        [
            { type: 'thinking', thinking: '思考全文' },
            { type: 'text', text: '第三轮又抓到真问题（TOCTOU 方向反了是我写错、逐项修。' },
        ],
        { isToolCallInHistory: neverInHistory },
    )
    assert.equal((solidified[1] as any).text, '第三轮又抓到真问题（TOCTOU 方向反了是我写错、逐项修。')
})

test('权威块的 thinkingSignature 等元数据随整块替换保留', () => {
    const stream = [{ type: 'thinking', thinking: '思' }]
    ci(stream[0], 0)
    const solidified = solidifyAssistantContent(
        stream,
        [{ type: 'thinking', thinking: '思考全文', thinkingSignature: 'sig-1' }],
        { isToolCallInHistory: neverInHistory },
    )
    assert.equal((solidified[0] as any).thinking, '思考全文')
    assert.equal((solidified[0] as any).thinkingSignature, 'sig-1')
})

// ── 缺块插入 / 工具卡保序 / 去重 ──

test('全程无 delta 的末批块（只在 message_end 落位）：按 ci 顺位追加', () => {
    const stream = [{ type: 'thinking', thinking: '思考全文' }]
    ci(stream[0], 0)
    const solidified = solidifyAssistantContent(
        stream,
        [
            { type: 'thinking', thinking: '思考全文' },
            { type: 'text', text: '正文全文' },
        ],
        { isToolCallInHistory: neverInHistory },
    )
    assert.deepEqual(solidified, [
        { type: 'thinking', thinking: '思考全文' },
        { type: 'text', text: '正文全文' },
    ])
})

test('工具卡保留本地块（运行态在卡上）且顺序不变，权威 toolCall 块不产生第二张卡', () => {
    const card = { type: 'toolCall', id: 'call-1', name: 'bash', toolState: 'success', toolResult: 'ok' }
    const stream = [card, { type: 'text', text: '除基线既有失败）。' }]
    ci(stream[1], 0)
    const solidified = solidifyAssistantContent(
        stream,
        [
            { type: 'text', text: '全绿（除基线既有失败）。' },
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
        ],
        { isToolCallInHistory: neverInHistory },
    )
    assert.equal(solidified.length, 2)
    assert.deepEqual(solidified[0], card) // 本地卡的运行态（toolState/toolResult）随拷贝保留
    assert.notEqual(solidified[0], card)
    assert.equal((solidified[1] as any).text, '全绿（除基线既有失败）。')
})

test('与历史同 id 的工具卡不随流固化（防双卡，沿用既有去重规则）', () => {
    const stream = [
        { type: 'toolCall', id: 'dup-1', name: 'bash', toolState: 'calling' },
        { type: 'text', text: '全文' },
    ]
    ci(stream[1], 0)
    const solidified = solidifyAssistantContent(
        stream,
        [{ type: 'text', text: '全文' }],
        { isToolCallInHistory: (id) => id === 'dup-1' },
    )
    assert.deepEqual(solidified, [{ type: 'text', text: '全文' }])
})

// ── 兼容门禁 / 空流 / 深拷贝 ──

test('旧服务端（流内无 _ci 标记）：原样固化，不与权威全文叠加', () => {
    const stream = [{ type: 'text', text: '本地拼接文本' }]
    const solidified = solidifyAssistantContent(
        stream,
        [{ type: 'text', text: '服务端权威全文' }],
        { isToolCallInHistory: neverInHistory },
    )
    assert.deepEqual(solidified, [{ type: 'text', text: '本地拼接文本' }])
})

test('message_end 无 content（旧形状）：原样固化本地流', () => {
    const stream = [{ type: 'text', text: '本地拼接文本' }]
    ci(stream[0], 0)
    const solidified = solidifyAssistantContent(stream, undefined, { isToolCallInHistory: neverInHistory })
    assert.deepEqual(solidified, [{ type: 'text', text: '本地拼接文本' }])
})

test('空流 + 权威全文（超短回复整条只在 message_end）：直接采用权威全文', () => {
    const solidified = solidifyAssistantContent(
        [],
        [{ type: 'text', text: '好的。' }],
        { isToolCallInHistory: neverInHistory },
    )
    assert.deepEqual(solidified, [{ type: 'text', text: '好的。' }])
})

test('固化产物是深拷贝：_ci 剥离、不共享引用', () => {
    const raw = [{ type: 'text', text: '半截' }]
    ci(raw[0], 0)
    const solidified = solidifyAssistantContent(
        raw,
        [{ type: 'text', text: '全文', thinkingSignature: undefined }],
        { isToolCallInHistory: neverInHistory },
    )
    assert.equal(Object.keys(solidified[0] as any).includes('_ci'), false)
    assert.equal((solidified[0] as any).text, '全文')
    assert.notEqual(solidified[0], raw[0])
})

// ── replayPartialBlocks：message_start 首批播种（与 attach 重放共用） ──

test('replayPartialBlocks：剥离 toolCall、按下标打 _ci、深拷贝', () => {
    const content = [
        { type: 'thinking', thinking: '思考首批', thinkingSignature: 'sig' },
        { type: 'toolCall', id: 't1', name: 'bash', arguments: {} },
        { type: 'text', text: '全绿（除' },
    ]
    const replayed = replayPartialBlocks(content)
    assert.equal(replayed.length, 2)
    assert.equal((replayed[0] as any)._ci, 0)
    assert.equal((replayed[0] as any).thinking, '思考首批')
    assert.equal((replayed[0] as any).thinkingSignature, 'sig')
    assert.equal((replayed[1] as any)._ci, 2) // toolCall 占位下标不挤占
    assert.equal((replayed[1] as any).text, '全绿（除')
    // 深拷贝：改结果不影响输入
    ;(replayed[1] as any).text = 'mutated'
    assert.equal((content[2] as any).text, '全绿（除')
})

test('中位缺块（reasoning 交错穿插、整块首批未达）：落到作者位置而非尾部', () => {
    // openai 网关 reasoning 交错：正文(0) → thinking(1) → 正文(2)；
    // thinking(1) 整块只在 block change（未下发），本地缺失，正文(2) 正常收 delta
    const stream = [
        { type: 'text', text: '第一段。' },
        { type: 'text', text: '第三段。' },
    ]
    ci(stream[0], 0)
    ci(stream[1], 2)
    const solidified = solidifyAssistantContent(
        stream,
        [
            { type: 'text', text: '第一段。' },
            { type: 'thinking', thinking: '中间思考' },
            { type: 'text', text: '第三段。' },
        ],
        { isToolCallInHistory: neverInHistory },
    )
    assert.deepEqual(solidified.map((b: any) => b.type), ['text', 'thinking', 'text'])
    assert.equal((solidified[1] as any).thinking, '中间思考')
})

test('流首工具卡锚 -1：排在全部文本块之前（多轮工具卡随下一条消息固化的既有顺序）', () => {
    const stream = [
        { type: 'toolCall', id: 'c1', name: 'bash', toolState: 'success' },
        { type: 'text', text: '正文。' },
    ]
    ci(stream[1], 0)
    const solidified = solidifyAssistantContent(
        stream,
        [{ type: 'text', text: '正文全文。' }],
        { isToolCallInHistory: neverInHistory },
    )
    assert.equal(solidified.length, 2)
    assert.equal((solidified[0] as any).type, 'toolCall')
    assert.equal((solidified[1] as any).text, '正文全文。')
})

test('blocksTextSignature：text/thinking 拼接签名（防重放比对用）', () => {
    assert.equal(blocksTextSignature([{ type: 'text', text: 'ab' }, { type: 'thinking', thinking: 'cd' }, { type: 'toolCall', id: 'x' }]), 'abcd')
    assert.equal(blocksTextSignature(undefined), '')
    assert.equal(blocksTextSignature([]), '')
})

test('replayPartialBlocks：非数组/空 content 返回空数组', () => {
    assert.deepEqual(replayPartialBlocks(undefined), [])
    assert.deepEqual(replayPartialBlocks('字符串 content'), [])
    assert.deepEqual(replayPartialBlocks([]), [])
})
