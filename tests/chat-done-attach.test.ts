// done 后 busy 兜底 attach 的 wiring 锚（源码形状断言，同 goal-memory-wiring 模式：
// useChatState 依赖 vue 响应性单例，node --test 无法直接实例化）。
//
// 背景 bug：/goal start|restart|resume 的任务 run 由服务端 startRun 另开，命令流
// （streamCommand）只发回执不订阅 run 事件——run 的流式回复/轮数推进/扩展状态推送
// 对客户端全部不可见，直到手动刷新（用户视角「敲完命令只剩 Command executed，
// 像停止了」）。防线 = done 的全量重拉发现会话仍 busy（isStreaming=true）即
// attachToSessionIfNeeded：快照线补回扩展状态、推送线接上后续轮次。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const source = readFileSync(path.resolve(__dirname, '../src/composables/useChatState.ts'), 'utf8')

function doneRefreshBody(): string {
    const start = source.indexOf(`apiGet<{ messages: ChatMessage[]; isStreaming?: boolean }>`)
    assert.ok(start > -1, 'done 的全量重拉（含 isStreaming 类型）丢失')
    // 结尾锚 = 重拉链的 catch 行（旧锚 fetchSessionUsage 已随 /usage 端点删除而移除）；
    // 重拉已重构收进 refreshSettledMessages（done/扩展通知等多处共用），锚不受影响
    const end = source.indexOf("}).catch(() => { /* 静默失败不影响使用 */ })", start)
    assert.ok(end > start, '重拉块结尾锚丢失')
    return source.slice(start, end)
}

test('done 重拉后：isStreaming → attachToSessionIfNeeded（服务端发起的 run 必须有流附着）', () => {
    const body = doneRefreshBody()
    assert.match(body, /if \(result\?\.isStreaming\) \{\s*attachToSessionIfNeeded\(targetKey\)/)
})

test('attach 兜底判定不得影响 skipSettledRefresh 分支（空闲 done 不触发 attach）', () => {
    // skip 分支在重拉之前 break：done case 内两个路径各自独立。attach 兜底已随
    // 重拉重构收进 refreshSettledMessages（isStreaming 才 attach，见上一测试），
    // done case 只管早退与委托——锚定「skip 的 break 先于重拉调用」即锚定空闲
    // done 不触发 attach
    const doneStart = source.indexOf("case 'done':")
    const doneCase = source.slice(doneStart, source.indexOf('default:', doneStart))
    const skipIdx = doneCase.indexOf('skipSettledRefresh')
    const refreshIdx = doneCase.indexOf('refreshSettledMessages(targetKey)')
    assert.ok(skipIdx > -1, 'skipSettledRefresh 分支丢失')
    assert.ok(refreshIdx > -1, 'done 的 settled 重拉调用丢失')
    // skip 分支的 break 必须出现在重拉调用之前（各管各的路径）
    const breakAfterSkip = doneCase.indexOf('break', skipIdx)
    assert.ok(breakAfterSkip < refreshIdx, 'skipSettledRefresh 分支必须先于 settled 重拉早退')
})
