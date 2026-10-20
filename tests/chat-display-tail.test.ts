import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { computeDisplayTailIndex } from '../src/utils/chatDisplayTail.ts'

const testDir = path.dirname(fileURLToPath(import.meta.url))

// 背景 bug：工具调用挂起、等 A2UI 面板（mcp-elicitation-render / permission-render）
// 作答时，用户在输入框点「插入(steer)/排队(follow-up)」→ 排队气泡追加到显示列表末尾
// → 尾锚落到排队气泡上 → 面板所在的 assistant 气泡判成非尾部 → MessageBubble 给
// A2UIRenderer 传 disabled=true → 盖上 pointer-events 遮罩 → 面板不可点；而排队消息
// 要等 run 边界才被消费，run 又正卡在等这张表单上 → 死锁，唯一出口是「停止回合」。
// 尾锚必须跳过排队态（pending）气泡。
test('尾锚跳过排队态气泡，落在真正的对话尾部', () => {
    const messages = [{ role: 'user' }, { role: 'assistant' }, { role: 'user', pending: 'steer' }]
    assert.equal(computeDisplayTailIndex(messages), 1)
})

test('多个排队气泡连在末尾 → 仍取其前第一条非排队项', () => {
    assert.equal(computeDisplayTailIndex([{ role: 'assistant' }, { pending: 'steer' }, { pending: 'followUp' }]), 0)
})

test('无排队气泡 → 末项（原语义不变）', () => {
    assert.equal(computeDisplayTailIndex([{ role: 'user' }, { role: 'assistant' }]), 1)
})

test('全是排队气泡 → 退回末项（不产生空尾锚）', () => {
    assert.equal(computeDisplayTailIndex([{ pending: 'steer' }]), 0)
})

test('空列表 → -1（与原 isLast 计算一致）', () => {
    assert.equal(computeDisplayTailIndex([]), -1)
})

test('VirtualMessageList 的 isLast 走该纯函数（防回退）', () => {
    const source = readFileSync(path.resolve(testDir, '../src/components/chat/VirtualMessageList.vue'), 'utf8')
    assert.match(source, /const tailIndex = computeDisplayTailIndex\(props\.messages\)/)
    assert.match(source, /isLast: i === tailIndex/)
})

test('MessageBubble 的交互门控语义未变（非尾部仍置 disabled）', () => {
    const bubble = readFileSync(path.resolve(testDir, '../src/components/chat/MessageBubble.vue'), 'utf8')
    assert.match(bubble, /:disabled="!isLastMessage"/)
})