import test from 'node:test'
import assert from 'node:assert/strict'

import { extractMessageText, parseSubagentReport } from '../src/utils/subagentReport.ts'

test('parseSubagentReport 解析 completed 报告（name/status/答案全文）', () => {
    const r = parseSubagentReport('[bg-subagent-report] name=reader status=completed\n2, 3, and 5.')
    assert.deepEqual(r, { name: 'reader', status: 'completed', body: '2, 3, and 5.' })
})

test('parseSubagentReport 解析 error 报告（多行答案保留原文）', () => {
    const r = parseSubagentReport('[bg-subagent-report] name=writer status=error\n第一行\n\n第二行')
    assert.equal(r?.name, 'writer')
    assert.equal(r?.status, 'error')
    assert.equal(r?.body, '第一行\n\n第二行')
})

test('parseSubagentReport 兼容 CRLF 行尾（SSE/落盘两种到达路径）', () => {
    const r = parseSubagentReport('[bg-subagent-report] name=reader status=completed\r\n答案')
    assert.deepEqual(r, { name: 'reader', status: 'completed', body: '答案' })
})

test('parseSubagentReport 拒绝非报告文本（普通用户输入不误判）', () => {
    assert.equal(parseSubagentReport('请帮我 [bg-subagent-report] name=x status=completed\n答案'), null)
    assert.equal(parseSubagentReport('[bg-subagent-report] name=x status=aborted\n答案'), null)
    assert.equal(parseSubagentReport(''), null)
    // 头行后无换行（无答案体）也不算合法报告
    assert.equal(parseSubagentReport('[bg-subagent-report] name=x status=completed'), null)
})

test('extractMessageText：string 直取、parts 拼 text 块、空/其他形状 null', () => {
    assert.equal(extractMessageText('hello'), 'hello')
    assert.deepEqual(
        extractMessageText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]),
        'ab',
    )
    assert.equal(extractMessageText([]), null)
    assert.equal(extractMessageText([{ type: 'image', data: 'x' }]), null)
    assert.equal(extractMessageText(42), null)
    assert.equal(extractMessageText(null), null)
})
