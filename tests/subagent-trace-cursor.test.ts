import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTraceDelta } from '../src/utils/subagent-trace-cursor.ts'

// ==================== 子代理轨迹游标三态合并（纯函数行为测试） ====================
//
// applyTraceDelta 的游标核心：推送增量与 HTTP 拉取两路共用的 offset/total/baseOffset
// 判定。语义与既有只读轨迹路由（offset/total 按全部非 header entry 计数）同源。
// 抽取动机：审核 Important #2——三态合并是本轮最易错的新算法，需行为级回归护栏。

test('baseOffset == traceOffset：无缝续接，整批应用（sliceStart 从增量数组头开始）', () => {
    const r = resolveTraceDelta({ total: 5, baseOffset: 2, traceOffset: 2 })
    assert.equal(r.action, 'apply')
    assert.equal(r.sliceStart, 0)
    assert.equal(r.nextOffset, 5)
})

test('baseOffset < traceOffset：重叠续接，切掉已消费段（sliceStart 为增量数组下标）', () => {
    // 推送基点落后于客户端游标（推送发出后客户端又经其他路推进）：
    // 增量覆盖全序 [4,10)，客户端已消费到 7 → 需要增量下标 3 起的尾段
    const r = resolveTraceDelta({ total: 10, baseOffset: 4, traceOffset: 7 })
    assert.equal(r.action, 'apply')
    assert.equal(r.sliceStart, 3)
    assert.equal(r.nextOffset, 10)
})

test('traceOffset == total：无新条目短路（推送可能落后于已拉取状态）', () => {
    assert.equal(resolveTraceDelta({ total: 7, baseOffset: 0, traceOffset: 7 }).action, 'noop')
    assert.equal(resolveTraceDelta({ total: 7, baseOffset: 3, traceOffset: 7 }).action, 'noop')
})

test('traceOffset < baseOffset：缺口（错过事件），回退拉平', () => {
    const r = resolveTraceDelta({ total: 12, baseOffset: 6, traceOffset: 3 })
    assert.equal(r.action, 'resync')
})

test('total 收缩（子会话中途 compaction）：游标倒退异常，回退全量重拉', () => {
    // 旧轮询 traceOffset = res.total 会跟随回落自愈；推送短路方向若吞掉倒退
    // 会永久冻结游标——审核 Minor #4
    const r = resolveTraceDelta({ total: 4, baseOffset: 2, traceOffset: 9 })
    assert.equal(r.action, 'resync')
})

test('恒等：baseOffset=0、traceOffset=0 的首载推送整批应用', () => {
    const r = resolveTraceDelta({ total: 3, baseOffset: 0, traceOffset: 0 })
    assert.equal(r.action, 'apply')
    assert.equal(r.sliceStart, 0)
    assert.equal(r.nextOffset, 3)
})
