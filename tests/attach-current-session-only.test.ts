/**
 * 回归：attachToSessionIfNeeded 只为「当前会话」建 attach 流。
 *
 * Bug（2026-11，状态条丢失）：attach 快照线只在建流时发一次（服务端
 * chat.ts collect 一遍扩展现态），而切换会话的 watch 会清空音乐/后台
 * 子代理/goal 状态。此前 attachToSessionIfNeeded 不区分目标会话是否为
 * 当前会话，两条路径会给非当前会话建流并占住 sseConnections 注册表：
 *   1. WS 报告（ext.subagent_report / ext.music_report）→ refreshSettledMessages
 *      发现 isStreaming → attach（用户已切走的会话）
 *   2. 快速切换：setSessionKey(B) 未加载分支 → loadChatHistory(B) 在
 *      await 后才调 attach——期间用户已切到 C
 * 占坑流自己的快照被 composable 键守卫拒收（targetKey !== sessionKey），
 * 切回时本函数却命中注册表跳过重挂——快照永不再来，切回后三条 bar
 * （音乐/后台子代理/goal）全部丢失，直到下一次推送/再切一轮/刷新。
 *
 * 修复：函数入口守卫 targetKey !== state.sessionKey 直接返回。非当前会话
 * 的消息仍由 refreshSettledMessages 静默重拉（前半段不受影响），切回时由
 * setSessionKey 走本函数正常 attach 拿全量快照。
 *
 * 行为级复现与修复验证见 /tmp/seedcode-bar-repro/harness/（driver-ws.ts、
 * driver-rapid.ts：修复前 3/3 FAIL，加守卫后全场景恢复、对照组不变）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/composables/useChatState.ts'), 'utf8')

test('attachToSessionIfNeeded 入口守卫：目标不是当前会话直接返回（不得占坑）', () => {
    const start = source.indexOf('export function attachToSessionIfNeeded')
    assert.ok(start >= 0, 'attachToSessionIfNeeded 应存在且被导出')
    const end = source.indexOf('\n    const sessionData = getSessionData(targetKey)', start)
    assert.ok(end > start, '函数体切片终点应有效（indexOf 不得返回 -1）')
    const head = source.slice(start, end)

    // 守卫必须在建立连接之前：命中 state.sessionKey 比较即返回
    assert.match(head, /if \(targetKey !== state\.sessionKey\)/, '入口应比较 targetKey 与 state.sessionKey')
    assert.match(head, /return/, '非当前会话应直接 return')

    // 守卫先于 shouldAttachSession（注册表检查）：非当前会话连「查注册表」
    // 都不必——无论注册表有没有它的连接，都不能为非当前会话建流
    const guardIdx = head.indexOf('targetKey !== state.sessionKey')
    const registryIdx = head.indexOf('shouldAttachSession')
    assert.ok(guardIdx >= 0 && registryIdx > guardIdx, '会话守卫必须在 shouldAttachSession 注册表检查之前')
})

test('回归锚：refreshSettledMessages 的 busy 附着调用点保留（当前会话语义不变）', () => {
    // WS 报告/done 收敛的重拉发现 isStreaming 仍要发起附着——只是附着入口
    // 现在自带「仅当前会话」守卫。删除这个调用点会让 goal 续跑等服务端
    // 发起的 run 对客户端不可见（另一回归），故锚定它存在。
    const fnStart = source.indexOf('const refreshSettledMessages = (targetKey: string): void =>')
    const fnEnd = source.indexOf('}).catch(', fnStart)
    assert.ok(fnStart >= 0 && fnEnd > fnStart, 'refreshSettledMessages 切片应有效')
    const fn = source.slice(fnStart, fnEnd)
    assert.match(fn, /if \(result\?\.isStreaming\) \{\s*attachToSessionIfNeeded\(targetKey\)/, 'isStreaming 分支应调用 attachToSessionIfNeeded')
})

test('回归锚：setSessionKey 在赋值 sessionKey 之后才 attach（守卫不被误伤）', () => {
    // attachToSessionIfNeeded 的守卫读 state.sessionKey——setSessionKey 必须
    // 先赋值再附着，否则正常切换路径会被自己的守卫拦掉（bar 全丢的反向事故）
    const start = source.indexOf('const setSessionKey = async (key: string) =>')
    const end = source.indexOf('\nconst ', start + 10)
    assert.ok(start >= 0, 'setSessionKey 应存在')
    const fn = source.slice(start, end === -1 ? undefined : end)
    const assignIdx = fn.indexOf('state.sessionKey = key')
    const attachIdx = fn.indexOf('attachToSessionIfNeeded(key)')
    assert.ok(assignIdx >= 0, 'setSessionKey 应赋值 state.sessionKey = key')
    assert.ok(attachIdx > assignIdx, 'attach 必须在 state.sessionKey = key 之后（守卫依赖已赋值）')
})
