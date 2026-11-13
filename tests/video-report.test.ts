import test from 'node:test'
import assert from 'node:assert/strict'

import { parseVideoReport } from '../src/utils/videoReport.ts'

test('parseVideoReport 解析完成回执（署名行 + 播放链接）', () => {
    const r = parseVideoReport('[视频生成完成] MiniMax-H3 已生成：海边\n[🎬 播放](/assets/videos/session/s/video-1.mp4)')
    assert.deepEqual(r, {
        status: 'completed',
        text: 'MiniMax-H3 已生成：海边',
        url: '/assets/videos/session/s/video-1.mp4',
    })
})

test('parseVideoReport 完成：caption 多行（prompt 截断可含换行）', () => {
    const r = parseVideoReport('[视频生成完成] MiniMax-H3 已生成：第一行\n第二行\n[🎬 播放](/assets/videos/session/s/v.mp4)')
    assert.equal(r?.status, 'completed')
    assert.equal(r?.text, 'MiniMax-H3 已生成：第一行\n第二行')
    assert.equal(r?.url, '/assets/videos/session/s/v.mp4')
})

test('parseVideoReport 兼容 CRLF 行尾（注入落盘路径）', () => {
    const r = parseVideoReport('[视频生成完成] MiniMax-H3 已生成：海边日落\r\n[🎬 播放](/assets/a.mp4)')
    assert.equal(r?.status, 'completed')
    assert.equal(r?.url, '/assets/a.mp4')
})

test('parseVideoReport 解析失败回执（原因 + taskId 括注）', () => {
    const r = parseVideoReport('[视频生成失败] 原因：video description contains sensitive content（1026）（taskId: upstream-1）')
    assert.deepEqual(r, {
        status: 'error',
        text: 'video description contains sensitive content（1026）',
        taskId: 'upstream-1',
    })
})

test('parseVideoReport 失败：嵌套括号原因（下载重试耗尽文案）不截断', () => {
    const r = parseVideoReport(
        '[视频生成失败] 原因：视频已生成但下载失败（已重试 10 次；最近错误：fetch failed）（taskId: upstream-budget-1）',
    )
    assert.equal(r?.status, 'error')
    assert.equal(r?.taskId, 'upstream-budget-1')
    assert.equal(r?.text, '视频已生成但下载失败（已重试 10 次；最近错误：fetch failed）')
})

test('parseVideoReport 拒绝非回执文本（普通用户输入不误判）', () => {
    assert.equal(parseVideoReport('请帮我 [视频生成完成] 随便说\n[🎬 播放](x)'), null)
    assert.equal(parseVideoReport('[视频生成失败] 原因：没有 taskId 括注'), null)
    assert.equal(parseVideoReport(''), null)
    assert.equal(parseVideoReport('[视频生成中断] 其他前缀'), null)
})

test('parseVideoReport 拒绝音乐回执文本（前缀不同不混淆）', () => {
    assert.equal(parseVideoReport('[音乐生成完成] StepMusic 已生成：lo-fi\n[🔊 播放](/assets/audios/session/s/sound-1.mp3)'), null)
    assert.equal(parseVideoReport('[音乐生成失败] 原因：生成超时（taskId: upstream-1）'), null)
})
