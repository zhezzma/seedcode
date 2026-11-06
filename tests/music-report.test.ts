import test from 'node:test'
import assert from 'node:assert/strict'

import { parseMusicReport } from '../src/utils/musicReport.ts'

test('parseMusicReport 解析完成回执（署名行 + 播放链接）', () => {
    const r = parseMusicReport('[音乐生成完成] StepMusic 已生成：A soul and R&B song\n[🔊 播放](/assets/audios/session/snd-1/sound-1.mp3)')
    assert.deepEqual(r, {
        status: 'completed',
        text: 'StepMusic 已生成：A soul and R&B song',
        url: '/assets/audios/session/snd-1/sound-1.mp3',
    })
})

test('parseMusicReport 完成：caption 多行（prompt 截断可含换行）', () => {
    const r = parseMusicReport('[音乐生成完成] StepMusic 已生成：第一行\n第二行\n[🔊 播放](/assets/a.mp3)')
    assert.equal(r?.status, 'completed')
    assert.equal(r?.text, 'StepMusic 已生成：第一行\n第二行')
    assert.equal(r?.url, '/assets/a.mp3')
})

test('parseMusicReport 兼容 CRLF 行尾（注入落盘路径）', () => {
    const r = parseMusicReport('[音乐生成完成] StepMusic 已生成：lo-fi\r\n[🔊 播放](/assets/a.mp3)')
    assert.equal(r?.status, 'completed')
    assert.equal(r?.url, '/assets/a.mp3')
})

test('parseMusicReport 解析失败回执（原因 + taskId 括注）', () => {
    const r = parseMusicReport('[音乐生成失败] 原因：模型生成被安全策略拦截（taskId: upstream-1）')
    assert.deepEqual(r, {
        status: 'error',
        text: '模型生成被安全策略拦截',
        taskId: 'upstream-1',
    })
})

test('parseMusicReport 失败：超时原因含嵌套括号不截断', () => {
    const r = parseMusicReport(
        '[音乐生成失败] 原因：生成超时（已等待 600 秒，上限 10 分钟；任务可能仍在进行，可用 task_id 向上游排查）（taskId: upstream-slow-1）',
    )
    assert.equal(r?.status, 'error')
    assert.equal(r?.taskId, 'upstream-slow-1')
    assert.equal(r?.text, '生成超时（已等待 600 秒，上限 10 分钟；任务可能仍在进行，可用 task_id 向上游排查）')
})

test('parseMusicReport 拒绝非回执文本（普通用户输入不误判）', () => {
    assert.equal(parseMusicReport('请帮我 [音乐生成完成] 随便说\n[🔊 播放](x)'), null)
    assert.equal(parseMusicReport('[音乐生成失败] 原因：没有 taskId 括注'), null)
    assert.equal(parseMusicReport(''), null)
    assert.equal(parseMusicReport('[音乐生成中断] 其他前缀'), null)
})
