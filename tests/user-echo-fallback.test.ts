// user 回显三级消费链的 wiring 锚（源码形状断言，同 goal-memory-wiring 模式）。
//
// 背景 bug：goal 续跑链的 turnMessage user 条目（引擎收尾边界原子提交）不在任何
// 本地账本（在途登记/steer 队列/removedEcho）里，回显被 message_start 的 user 分支
// 静默跳过——续跑对话缺 user 侧气泡，且连续 assistant 消息被展示层合并气泡
// （assistantMsgMerge）挤成一个大泡（三个思考过程 + 多轮回复全堆在一起）。
// 防线 = 三级消费链末位的兜底：都不命中 → 追加为正式气泡。本机发送的回显恒被
// inFlightEcho 拦下（乐观气泡已覆盖），无双气泡风险。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const source = readFileSync(path.resolve(__dirname, '../src/composables/useChatState.ts'), 'utf8')

function userEchoBranch(): string {
    const start = source.indexOf("if (echoMsg?.role === 'user')")
    assert.ok(start > -1, 'message_start 的 user 回显分支丢失')
    const end = source.indexOf("// 特殊处理带有完整 content 的初始消息", start)
    assert.ok(end > start, 'user 回显分支结尾锚丢失')
    return source.slice(start, end)
}

test('user 回显三级消费链：队列转正 → removedEcho 补齐 → 兜底追加（goal 续跑条目）', () => {
    const body = userEchoBranch()
    assert.match(body, /consumeQueueHead\(sessionData\.pendingQueue, echoText\)/, '第 1 级：steer/follow-up 队列转正')
    assert.match(body, /consumeRemovedEcho\(sessionData, echoText\)/, '第 2 级：removedEcho 补齐')
    // 兜底分支：前两级都不命中 && 非本机在途回显 → 追加正式气泡
    assert.match(
        body,
        /else if \(echoText && !inFlightEcho\) \{[\s\S]*?role: 'user',[\s\S]*?content: echoMsg\.content/,
        '第 3 级兜底：服务端自发 user 条目（goal 续跑等）追加为正式气泡',
    )
})

test('兜底分支必须以 !inFlightEcho 为前置（本机发送的回显不得双气泡）', () => {
    const body = userEchoBranch()
    const fallbackStart = body.indexOf('else if (echoText && !inFlightEcho)')
    assert.ok(fallbackStart > -1, '兜底分支丢失')
    // 兜底分支内不得缺失 inFlightEcho 前置（正则锚定同一条件表达式）
    const fallbackCondition = body.slice(fallbackStart, fallbackStart + 40)
    assert.match(fallbackCondition, /!inFlightEcho/)
})
