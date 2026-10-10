/**
 * 行为级回归测试：上下文压缩 UX（esbuild 打包真实 useChatState/useChatMessages 驱动）。
 *
 * 端到端事实（本地 18789 服务端实测抓流 /tmp/solpi-e2e/capture3.sse + 落盘 jsonl）：
 * SoL-Pi 在线压缩在 turn_end 边界 abort 当前 run → 同一条 chat SSE 流内
 *   … message_end（工具批封口）→ turn_end
 *   → turn_start → message_start{assistant,content:[],stopReason:"error",
 *      errorMessage:"This operation was aborted"} → message_end(同) → turn_end → agent_end
 *   → compaction_start{reason:"manual"}   ← 26~89s 窗口，期间无任何内容事件
 *   → compaction_end{reason:"manual",result:{summary,tokensBefore,…}}
 *   → agent_start → turn_start
 *   → message_start{custom,customType:"sol-pi-online-context-compact",display:false,
 *      content:"Online context compaction finished…"} → message_end(同)
 *   → 续 turn 正常事件… → agent_settled → done
 * 历史路径（/messages、attach 快照）返回：空内容 abort 条目（stopReason=error +
 * AbortError 文案）+ display:false 的 custom 条目（服务端序列化为 role:"assistant" +
 * display:false）+ 正常消息。
 *
 * 本测试重放上述真实形态（空 abort 帧在 compaction_start 之前），钉住：
 * 1. 压缩窗口内 compacting=true 且 processedMessages 尾部为瞬态压缩行伪消息
 *    （id=context-compacting、无 entryId、不与 streaming-pending 占位叠加）；
 * 2. 空 abort 帧（流式+历史）零痕迹：不产生气泡、不渲染红色错误；
 * 3. display:false 隐藏提醒（流式+历史）不进聊天记录；
 * 4. 半截内容 abort（流式+历史）：内容保留，无 errorMessage/错误块/中断标记；
 * 5. 真错误（非 abort 签名）保持红色错误块；
 * 6. 断连（无 compaction_end）/done 后 compacting 兜底清零；attach 路径同规则；
 * 7. 手动 /compact（chat 命令路径：compaction_start/end + custom_message 回执）、阈值自动压缩（reason:threshold，run 内
 *    自然边界、无 abort 帧）与 SoL-Pi 在线压缩共用同一事件对与同一渲染路径——
 *    三种触发源客户端显示完全一致（统一性验收）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFile, rm, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..')

const srcPath = (p: string) => join(repoRoot, p).replace(/\\/g, '/')

const STUBS: Record<string, string> = {
    tauri: 'export const invoke = async () => ({}); export const listen = async () => () => {}; export default {};',
    i18n: 'export const i18n = { global: { t: (k: string) => k, te: () => true, locale: { value: "zh" } }, t: (k: string) => k }; export default i18n;',
    router: 'const router = { push: async () => {}, replace: async () => {}, afterEach: () => {} }; export default router;',
    'notify-client': 'export const connectBrowserWs = async () => {}; export const disconnectBrowserWs = () => {}; export const getWsUrl = () => ""; export const sendBrowserWs = async () => false;',
    'sse-client': `
const sse = ((globalThis).__sse = { handlers: {}, dones: {} });
function makeConn(name, sessionId, onEvent, onError) {
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    sse.handlers[name] = { sessionId, onEvent, onError };
    sse.dones[name] = resolveDone;
    return { abort: () => {}, done };
}
export function startChatSSE(sessionId, body, onEvent, onError) { return makeConn('chat', sessionId, onEvent, onError); }
export function attachSessionSSE(sessionId, onEvent, onError, options) { return makeConn('attach', sessionId, onEvent, onError); }
export function startRetrySSE(sessionId, body, onEvent, onError) { return makeConn('chat', sessionId, onEvent, onError); }
export function startEditSSE(sessionId, body, onEvent, onError) { return makeConn('chat', sessionId, onEvent, onError); }
`,
}

function stubPluginForTest() {
    return {
        name: 'seedcode-test-stubs',
        setup(b: any) {
            b.onResolve({ filter: /^@tauri-apps\// }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onResolve({ filter: /\/i18n$/ }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onResolve({ filter: /\/router$/ }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onResolve({ filter: /notify-client$/ }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onResolve({ filter: /\/sse-client$/ }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args: any) => {
                const key = args.path.startsWith('@tauri-apps')
                    ? 'tauri'
                    : args.path.endsWith('/i18n') ? 'i18n'
                    : args.path.endsWith('/router') ? 'router'
                    : args.path.endsWith('notify-client') ? 'notify-client'
                    : args.path.endsWith('/sse-client') ? 'sse-client'
                    : 'tauri'
                return { contents: STUBS[key], loader: 'ts', resolveDir: testDir }
            })
        },
    }
}

/** 真实抓流/落盘条目形态（capture3.sse + jsonl 证据），见文件头注释 */
const ABORT_MSG = { role: 'assistant', content: [], api: 'anthropic-messages', provider: 'p0', model: 'm0', stopReason: 'error', errorMessage: 'This operation was aborted', timestamp: 1789480033627 }
const HIDDEN_CUSTOM_LIVE = { role: 'custom', customType: 'sol-pi-online-context-compact', content: 'Online context compaction finished. The parent task is still active. Before continuing work, call update_plan with a fresh plan for the remaining work.', display: false, timestamp: 1789480122492 }
/** /messages 历史路径：custom 条目被 extractMessages 序列化为 role:"assistant" + display:false */
const HIDDEN_CUSTOM_HISTORY = { type: 'custom_message', role: 'assistant', customType: 'sol-pi-online-context-compact', content: 'Online context compaction finished. The parent task is still active.', display: false, timestamp: 3, entryId: 'e-hidden', parentEntryId: 'e-abort-1' }

const harnessEntry = `
;(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { (globalThis as any).window = { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) } } catch {}
;(globalThis as any).document = { createElement: () => ({ style: {} }), addEventListener: () => {}, removeEventListener: () => {} }

import { createPinia, setActivePinia } from 'pinia'
setActivePinia(createPinia())

const state = { s1HistoryReady: false }
;(globalThis as any).fetch = async (url: string, init?: any) => {
    const u = new URL(url)
    const body = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
    const sess = (id: string) => body({ ok: true, payload: { id, name: id, modelProvider: 'p0', model: 'm0', thinkingLevel: 'off', agentId: 'clear' } })
    if (u.pathname === '/api/sessions') return body({ ok: true, payload: { sessions: [{ id: 'S1', name: 'S1', modelProvider: 'p0', model: 'm0', thinkingLevel: 'off' }, { id: 'S2', name: 'S2', modelProvider: 'p0', model: 'm0', thinkingLevel: 'off' }] } })
    if (u.pathname === '/api/sessions/S1/info') return sess('S1')
    if (u.pathname === '/api/sessions/S2/info') return sess('S2')
    if (u.pathname === '/api/chat/S1/messages') {
        if (!state.s1HistoryReady) return body({ ok: true, payload: { messages: [], isStreaming: false } })
        // done 后全量刷新：真实落盘形态——空 abort 条目 + display:false 条目 + 半截 abort + 真错误 + 正常消息
        return body({ ok: true, payload: { messages: [
            { role: 'user', content: 'run the 8-step task', timestamp: 1, entryId: 'e-user' },
            { role: 'assistant', content: [{ type: 'text', text: 'step 1 done' }], timestamp: 2, entryId: 'e-a1', parentEntryId: 'e-user' },
            { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'This operation was aborted', timestamp: 3, entryId: 'e-abort-1', parentEntryId: 'e-a1' },
            ${'${HIDDEN_CUSTOM_HISTORY_JSON}'},
            { role: 'assistant', content: [{ type: 'text', text: 'half-written summary before stop' }], stopReason: 'error', errorMessage: 'This operation was aborted', timestamp: 4, entryId: 'e-abort-2', parentEntryId: 'e-abort-1' },
            { role: 'assistant', content: [{ type: 'text', text: 'crashed mid answer' }], stopReason: 'error', errorMessage: 'API Error 500: upstream failed', timestamp: 5, entryId: 'e-err', parentEntryId: 'e-abort-2' },
            { role: 'assistant', content: [{ type: 'text', text: 'step 2 done' }], timestamp: 6, entryId: 'e-a2', parentEntryId: 'e-err' },
            // /compact 的 durable 回执（appendCommandReceipt 双写后 /messages 投影带回：
            // custom_message + customType，无 timestamp）——场景 3.5 钉「重拉无感替换」
            { type: 'custom_message', role: 'assistant', customType: 'command-response', content: '会话已压缩', entryId: 'e-compact-receipt', parentEntryId: 'e-a2' },
        ], isStreaming: false } })
    }
    if (u.pathname === '/api/chat/S2/messages') {
        // 冷加载：与 S1 历史同一份形态（loadChatHistory 路径独立于 done 刷新）
        return body({ ok: true, payload: { messages: [
            { role: 'user', content: 'old task', timestamp: 1, entryId: 'f-user' },
            { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'The operation was aborted', timestamp: 2, entryId: 'f-abort', parentEntryId: 'f-user' },
            { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], timestamp: 3, entryId: 'f-a1', parentEntryId: 'f-abort' },
        ], isStreaming: false } })
    }
    if (u.pathname === '/api/chat/S1/usage' || u.pathname === '/api/chat/S2/usage') return body({ ok: true, payload: {} })
    if (u.pathname === '/api/chat/S1/entries' || u.pathname === '/api/chat/S2/entries') return body({ ok: true, payload: { leafId: null, entries: [] } })
    return body({ ok: true, payload: {} })
}

const { useChatState } = await import('${srcPath('src/composables/useChatState.ts')}')
const { useChatMessages } = await import('${srcPath('src/composables/useChatMessages.ts')}')
const { useUiSettingsStore } = await import('${srcPath('src/stores/setting.ts')}')
const { useToast } = await import('${srcPath('src/composables/useToast.ts')}')
;(globalThis as any).__toasts = useToast().toasts.value
;(useUiSettingsStore() as any).apiBaseUrl = 'http://mock-api'
// 每条 entry 独立成泡，便于按条目断言渲染规则
;(useUiSettingsStore() as any).assistantMsgMerge = false

const chat = useChatState() as any
const msgs = useChatMessages(chat as any)

const dump = (list: any[]) => JSON.stringify(list.map((m: any) => ({
    id: m.id, role: m.role, entryId: m.entryId ?? null,
    blocks: m.blocks.map((b: any) => b.type + (b.type === 'text' ? ':' + (b.text || '').slice(0, 40) : '') + (b.type === 'error' ? ':' + b.error : '')),
})))
const texts = (list: any[]) => JSON.stringify(list.flatMap(m => m.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text)))
const errorBlocks = (list: any[]) => list.flatMap(m => m.blocks.filter((b: any) => b.type === 'error'))
const visibleEntryIds = (list: any[]) => list.map(m => m.entryId).filter(Boolean)

await chat.setSessionKey('S1')
console.log('INIT isCompacting=' + chat.isCompacting())

// ===== 场景 1：完整在线压缩生命周期（chat SSE 路径，真实事件序）=====
await chat.sendMessage('run the 8-step task')
const sse = (globalThis as any).__sse
const emit = (event: string, data: any) => sse.handlers.chat.onEvent({ event, data })

// 用户回显（乐观气泡已存在，回显不命中队列 → 无新增）
emit('message_start', { type: 'message_start', message: { role: 'user', content: 'run the 8-step task', timestamp: 1 } })
emit('message_end', { type: 'message_end', message: { role: 'user', content: 'run the 8-step task', timestamp: 1 } })
// 触发压缩边界的 assistant 回合
emit('message_start', { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } })
emit('text_delta', { type: 'text_delta', delta: 'step 1 done' })
emit('message_end', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'step 1 done' }], stopReason: 'toolUse', timestamp: 2 } })
emit('turn_end', { type: 'turn_end' })

const beforeAbortLen = chat.getSessionData('S1').chatMessages.length
// abort 帧（真实形态：空 content + stopReason error + AbortError 文案，在 compaction_start 之前）
emit('turn_start', { type: 'turn_start' })
emit('message_start', { type: 'message_start', message: ${'${ABORT_MSG_JSON}'} })
emit('message_end', { type: 'message_end', message: ${'${ABORT_MSG_JSON}'} })
emit('turn_end', { type: 'turn_end' })
emit('agent_end', { type: 'agent_end' })
{
    const list = msgs.processedMessages.value
    console.log('AFTER_ABORT_FRAME msgsUnchanged=' + (chat.getSessionData('S1').chatMessages.length === beforeAbortLen) + ' errorBlocks=' + errorBlocks(list).length)
}

// 压缩窗口
emit('compaction_start', { type: 'compaction_start', reason: 'manual' })
{
    const list = msgs.processedMessages.value
    const last = list[list.length - 1]
    console.log('WINDOW isCompacting=' + chat.isCompacting() + ' lastId=' + last.id + ' lastBlock=' + (last.blocks[0] ? last.blocks[0].type : 'none') + ' lastEntryId=' + (last.entryId ?? 'none') + ' hasPlaceholder=' + list.some((m: any) => m.id === 'streaming-pending') + ' errorBlocks=' + errorBlocks(list).length)
}
emit('compaction_end', { type: 'compaction_end', reason: 'manual', result: { summary: 's', tokensBefore: 46366, estimatedTokensAfter: 457 } })
{
    const list = msgs.processedMessages.value
    const last = list[list.length - 1]
    console.log('POST_COMPACT isCompacting=' + chat.isCompacting() + ' tailIsPseudo=' + (list.some((m: any) => m.id === 'context-compacting')) + ' lastText=' + JSON.stringify(last.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text)))
}

// 续跑：display:false 的 custom 隐藏提醒（真实形态）
emit('agent_start', { type: 'agent_start' })
emit('turn_start', { type: 'turn_start' })
emit('message_start', { type: 'message_start', message: ${'${HIDDEN_CUSTOM_LIVE_JSON}'} })
emit('message_end', { type: 'message_end', message: ${'${HIDDEN_CUSTOM_LIVE_JSON}'} })
{
    const list = msgs.processedMessages.value
    console.log('HIDDEN_LIVE filtered=' + !JSON.stringify(list).includes('Online context compaction'))
}
// 续跑 assistant 回合
emit('message_start', { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 7 } })
emit('text_delta', { type: 'text_delta', delta: 'step 2 done' })
emit('message_end', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'step 2 done' }], timestamp: 7 } })
emit('agent_settled', { type: 'agent_settled' })

// done：先翻转历史开关再触发（fetch 桩的 async 函数体同步执行，晚了读不到新历史）
state.s1HistoryReady = true
emit('done', { message: 'Complete' })
sse.dones.chat()
await new Promise((r) => setTimeout(r, 80))

console.log('AFTER_DONE isCompacting=' + chat.isCompacting() + ' chatSending=' + chat.chatSending)
{
    const list = msgs.processedMessages.value
    const errs = errorBlocks(list)
    console.log('HISTORY hiddenFiltered=' + !JSON.stringify(list).includes('Online context compaction finished') + ' emptyAbortVisible=' + visibleEntryIds(list).includes('e-abort-1') + ' errorBlocks=' + errs.length + ' errorTexts=' + JSON.stringify(errs.map(b => b.error)))
    const partial = list.find(m => m.entryId === 'e-abort-2')
    console.log('HISTORY_PARTIAL kept=' + !!partial + ' text=' + (partial ? JSON.stringify(partial.blocks.map(b => b.type)) : 'none') + ' hasErrorBlock=' + (partial ? partial.blocks.some(b => b.type === 'error') : 'n/a'))
    const realErr = list.find(m => m.entryId === 'e-err')
    console.log('HISTORY_REALERR hasErrorBlock=' + (realErr ? realErr.blocks.some(b => b.type === 'error') : 'missing'))
    console.log('HISTORY_DUMP=' + dump(list))
}

// ===== 场景 2：半截内容被中断（流式）→ 压缩窗口内断连（无 compaction_end）=====
await chat.sendMessage('another task')
emit('message_start', { type: 'message_start', message: { role: 'user', content: 'another task', timestamp: 10 } })
emit('message_end', { type: 'message_end', message: { role: 'user', content: 'another task', timestamp: 10 } })
emit('message_start', { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 11 } })
emit('text_delta', { type: 'text_delta', delta: 'partial answer' })
// 用户停止时工具可能还在执行：stream 里留下 calling 态的 toolCall block
emit('tool_execution_start', { type: 'tool_execution_start', toolCallId: 'tc-dangling', toolName: 'read', args: { path: 'x' } })
emit('message_end', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }], stopReason: 'error', errorMessage: 'This operation was aborted', timestamp: 11 } })
{
    const sd = chat.getSessionData('S1')
    const last = sd.chatMessages[sd.chatMessages.length - 1]
    const list = msgs.processedMessages.value
    const lastBubble = list[list.length - 1]
    const toolBlock = lastBubble.blocks.find((b: any) => b.type === 'tool')
    console.log('PARTIAL_LIVE kept=' + (last && last.content && last.content[0] && last.content[0].text === 'partial answer') + ' errorMessageKept=' + (last.errorMessage === 'This operation was aborted') + ' lastBubbleBlocks=' + JSON.stringify(lastBubble.blocks.map((b: any) => b.type)) + ' lastBubbleHasError=' + lastBubble.blocks.some((b: any) => b.type === 'error') + ' danglingToolState=' + (toolBlock ? toolBlock.toolState : 'missing'))
}
emit('compaction_start', { type: 'compaction_start', reason: 'manual' })
console.log('DISCONNECT_BEFORE isCompacting=' + chat.isCompacting() + ' pseudoVisible=' + msgs.processedMessages.value.some((m: any) => m.id === 'context-compacting'))
sse.dones.chat()  // 连接结束（done promise resolve → bindSSELifecycle cleanup 兜底）
await new Promise((r) => setTimeout(r, 20))
console.log('DISCONNECT_AFTER isCompacting=' + chat.isCompacting() + ' pseudoVisible=' + msgs.processedMessages.value.some((m: any) => m.id === 'context-compacting'))

// ===== 场景 3：attach 路径（刷新/切回会话时压缩进行中）=====
// 新服务端形态：压缩窗口 isStreaming=false 而 compacting=true（message_state 携带），
// attach 保持订阅并继续下发 compaction_end 与续跑事件
const attachEmit = (event: string, data: any) => sse.handlers.attach.onEvent({ event, data })
attachEmit('message_state', { isStreaming: false, compacting: true })
{
    const list = msgs.processedMessages.value
    console.log('ATTACH isCompacting=' + chat.isCompacting() + ' busy=' + chat.chatSending + ' pseudoVisible=' + list.some((m: any) => m.id === 'context-compacting'))
}
// 旧服务端兼容：无 compacting 字段的 message_state 不动本地压缩态
attachEmit('message_state', { isStreaming: true })
console.log('ATTACH_LEGACY isCompacting=' + chat.isCompacting())
attachEmit('compaction_start', { type: 'compaction_start', reason: 'manual' })
console.log('ATTACH_START isCompacting=' + chat.isCompacting() + ' pseudoVisible=' + msgs.processedMessages.value.some((m: any) => m.id === 'context-compacting'))
attachEmit('compaction_end', { type: 'compaction_end', reason: 'manual' })
console.log('ATTACH_END isCompacting=' + chat.isCompacting() + ' pseudoVisible=' + msgs.processedMessages.value.some((m: any) => m.id === 'context-compacting'))

// ===== 场景 3.5：手动 /compact（统一走 chat 命令路径：streamCommandDeferred）=====
// 服务端流形（回执单轨）：compaction_start → compaction_end → custom_message
//（command-response 回执「会话已压缩」）→ done；无 message_start/command_delta/message_end
{
    await chat.sendMessage('/compact')
    console.log('MANUAL_START busy=' + chat.chatSending + ' isCompacting=' + chat.isCompacting())
    const compactEmit = (event: string, data: any) => sse.handlers.chat.onEvent({ event, data })
    compactEmit('compaction_start', { type: 'compaction_start', reason: 'manual' })
    console.log('MANUAL_WINDOW isCompacting=' + chat.isCompacting() + ' pseudoVisible=' + msgs.processedMessages.value.some((m: any) => m.id === 'context-compacting'))
    compactEmit('compaction_end', { type: 'compaction_end', reason: 'manual' })
    compactEmit('custom_message', { type: 'custom_message', customType: 'command-response', data: '会话已压缩' })
    // 回执独立成泡（custom_message 单轨；无伪 assistant 消息生命周期）
    const receipt = msgs.processedMessages.value.some((m: any) => m.blocks.some((b: any) => b.type === 'text' && b.text === '会话已压缩'))
    compactEmit('done', { message: 'Complete' })
    sse.dones.chat()
    await new Promise((r) => setTimeout(r, 50))
    // done 重拉后由 durable 副本（mock 历史尾部的 custom_message 条目）无感替换，
    // 回执气泡仍在且仍是一条（无闪烁/双泡）
    const receiptAfterDone = msgs.processedMessages.value.filter((m: any) => m.blocks.some((b: any) => b.type === 'text' && b.text === '会话已压缩')).length
    console.log('MANUAL_DONE isCompacting=' + chat.isCompacting() + ' chatSending=' + chat.chatSending + ' receiptBubble=' + receipt + ' receiptAfterDone=' + receiptAfterDone)
}

// 手动 /compact 失败路径：compaction_end 后 error 事件，干净收敛（无残留压缩行）
{
    await chat.sendMessage('/compact')
    const compactEmit = (event: string, data: any) => sse.handlers.chat.onEvent({ event, data })
    compactEmit('compaction_start', { type: 'compaction_start', reason: 'manual' })
    compactEmit('compaction_end', { type: 'compaction_end', reason: 'manual' })
    compactEmit('error', { error: 'Nothing to compact (session too small)' })
    compactEmit('done', { message: 'Error' })
    sse.dones.chat()
    await new Promise((r) => setTimeout(r, 50))
    console.log('MANUAL_FAIL isCompacting=' + chat.isCompacting() + ' chatSending=' + chat.chatSending + ' pseudoVisible=' + msgs.processedMessages.value.some((m: any) => m.id === 'context-compacting') + ' errorToast=' + JSON.stringify(((globalThis as any).__toasts || []).filter((x: any) => x.type === 'error').map((x: any) => x.message)))
}

// ===== 场景 3.6：!! bash-receipt 客户端驻留管线（登记 → done 重拉 → 锚点重挂存活 → reset 清账本）=====
{
    await chat.sendMessage('!!echo secret')
    // 无乐观 user 气泡（!! 语义：排除出上下文，回执由 bash-receipt 独立气泡承载）
    const noOptimistic = !chat.getSessionData('S1').chatMessages.some((m: any) => m.role === 'user' && !m.entryId && m.content === '!!echo secret')
    const receiptEmit = (event: string, data: any) => sse.handlers.chat.onEvent({ event, data })
    receiptEmit('custom_message', { type: 'custom_message', customType: 'bash-receipt', data: '$ !!echo secret\\n退出码: 0\\n\\nsecret' })
    const liveBubble = msgs.processedMessages.value.some((m: any) => m.blocks.some((b: any) => b.type === 'text' && b.text.includes('secret')))
    receiptEmit('done', { message: 'Complete' })
    sse.dones.chat()
    await new Promise((r) => setTimeout(r, 50))
    // done 重拉：mock /messages 不含 bash-receipt（零 durable），回执必须经
    // localReceipts 锚点重挂存活，且仅一条（无闪烁双泡）
    const afterDoneCount = msgs.processedMessages.value.filter((m: any) => m.blocks.some((b: any) => b.type === 'text' && b.text.includes('secret'))).length
    console.log('BASH_RECEIPT noOptimistic=' + noOptimistic + ' liveBubble=' + liveBubble + ' afterDoneCount=' + afterDoneCount)
    // reset 清账本：command_delta 副作用清空消息与回执账本，后续整体替换不复活
    receiptEmit('command_delta', { type: 'command_delta', command: 'reset', data: {} })
    receiptEmit('custom_message', { type: 'custom_message', customType: 'command-response', data: '会话已重置' })
    receiptEmit('done', { message: 'Complete' })
    sse.dones.chat()
    await new Promise((r) => setTimeout(r, 50))
    const goneAfterReset = !msgs.processedMessages.value.some((m: any) => m.blocks.some((b: any) => b.type === 'text' && b.text.includes('secret')))
    console.log('BASH_RECEIPT_RESET gone=' + goneAfterReset)
}

// ===== 场景 3.7：阈值自动压缩（reason:"threshold"，run 内自然边界，无 abort 帧）=====
// 与手动 /compact、SoL-Pi 在线压缩共用同一事件对与同一渲染路径：三种触发源客户端显示一致
const autoEmit = (event: string, data: any) => sse.handlers.chat.onEvent({ event, data })
autoEmit('message_start', { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 20 } })
autoEmit('text_delta', { type: 'text_delta', delta: 'working' })
autoEmit('message_end', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }], stopReason: 'end_turn', timestamp: 20 } })
autoEmit('turn_end', { type: 'turn_end' })
const errsBeforeAuto = msgs.processedMessages.value.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'error')).length
autoEmit('compaction_start', { type: 'compaction_start', reason: 'threshold' })
{
    const list = msgs.processedMessages.value
    const last = list[list.length - 1]
    console.log('AUTO_WINDOW isCompacting=' + chat.isCompacting() + ' lastId=' + last.id + ' lastBlock=' + (last.blocks[0] ? last.blocks[0].type : 'none') + ' newErrorBlocks=' + (list.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'error')).length - errsBeforeAuto))
}
autoEmit('compaction_end', { type: 'compaction_end', reason: 'threshold', result: { summary: 's', tokensBefore: 180000, estimatedTokensAfter: 21000 } })
{
    const list = msgs.processedMessages.value
    console.log('AUTO_END isCompacting=' + chat.isCompacting() + ' pseudoVisible=' + list.some((m: any) => m.id === 'context-compacting'))
}
autoEmit('message_start', { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 21 } })
autoEmit('text_delta', { type: 'text_delta', delta: 'resumed after auto compaction' })
autoEmit('message_end', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'resumed after auto compaction' }], timestamp: 21 } })
console.log('AUTO_RESUME rendered=' + msgs.processedMessages.value.some((m: any) => m.blocks.some((b: any) => b.text === 'resumed after auto compaction')))

// ===== 场景 4：冷加载历史（loadChatHistory 路径）=====
await chat.setSessionKey('S2')
{
    const list = msgs.processedMessages.value
    console.log('COLD emptyAbortVisible=' + visibleEntryIds(list).includes('f-abort') + ' texts=' + texts(list) + ' errorBlocks=' + errorBlocks(list).length)
    console.log('COLD_DUMP=' + dump(list))
}
`

const harness = harnessEntry
    .replace('${HIDDEN_CUSTOM_HISTORY_JSON}', () => JSON.stringify(HIDDEN_CUSTOM_HISTORY))
    .replace(/\$\{ABORT_MSG_JSON\}/g, () => JSON.stringify(ABORT_MSG))
    .replace(/\$\{HIDDEN_CUSTOM_LIVE_JSON\}/g, () => JSON.stringify(HIDDEN_CUSTOM_LIVE))

test('compaction UX: 瞬态压缩行 + abort/display:false 中性渲染全生命周期行为', async () => {
    const outDir = join(testDir, '.tmp-compaction-test')
    await rm(outDir, { recursive: true, force: true })
    await mkdir(outDir, { recursive: true })
    const entryFile = join(outDir, 'entry.mjs')
    await writeFile(entryFile, harness, 'utf8')

    await build({
        entryPoints: [entryFile],
        bundle: true,
        format: 'esm',
        platform: 'node',
        external: ['vue', 'pinia'],
        loader: { '.mjs': 'ts' },
        outfile: join(outDir, 'bundle.mjs'),
        plugins: [stubPluginForTest()],
        logLevel: 'silent',
    })

    const res = spawnSync(process.execPath, [join(outDir, 'bundle.mjs')], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, NODE_OPTIONS: '--experimental-vm-modules' },
    })
    if (res.status !== 0) {
        console.error('STDERR:', res.stderr)
        console.error('STDOUT:', res.stdout)
    }
    assert.equal(res.status, 0, 'harness must exit cleanly')

    const out = res.stdout
    if (process.env.COMPACT_DEBUG) console.log(out)
    const line = (tag: string) => out.split('\n').find((l) => l.startsWith(tag + ' '))
    const need = (tag: string) => {
        const l = line(tag)
        assert.ok(l, `output line "${tag}" must exist:\n${out}`)
        return l.trim()
    }

    // 压缩窗口：瞬态尾行伪消息接管展示（挂载位置 = 列表尾部，真机可见性的根因修复）
    assert.equal(need('INIT'), 'INIT isCompacting=false')
    assert.equal(need('AFTER_ABORT_FRAME'), 'AFTER_ABORT_FRAME msgsUnchanged=true errorBlocks=0')
    const win = need('WINDOW')
    assert.match(win, /isCompacting=true/, `window must be compacting: ${win}`)
    assert.match(win, /lastId=context-compacting /, `tail must be transient compacting row: ${win}`)
    assert.match(win, /lastBlock=compacting/, `pseudo message carries compacting block: ${win}`)
    assert.match(win, /lastEntryId=none/, `pseudo message has no entryId: ${win}`)
    assert.match(win, /hasPlaceholder=false/, `no streaming-pending placeholder stacked during window: ${win}`)
    assert.match(win, /errorBlocks=0/, `no error blocks during window: ${win}`)
    // 压缩结束：零痕迹
    const post = need('POST_COMPACT')
    assert.match(post, /isCompacting=false/, `compacting cleared on end: ${post}`)
    assert.match(post, /tailIsPseudo=false/, `pseudo row gone: ${post}`)
    assert.match(post, /lastText=\["step 1 done"\]/, `previous bubble restored as tail: ${post}`)
    // display:false 隐藏提醒（流式路径）
    assert.equal(need('HIDDEN_LIVE'), 'HIDDEN_LIVE filtered=true')
    // done 收尾 + 历史全量刷新
    assert.equal(need('AFTER_DONE'), 'AFTER_DONE isCompacting=false chatSending=false')
    const hist = need('HISTORY')
    assert.match(hist, /hiddenFiltered=true/, `hidden reminder filtered from history: ${hist}`)
    assert.match(hist, /emptyAbortVisible=false/, `empty abort entry invisible: ${hist}`)
    assert.match(hist, /errorBlocks=1 /, `only the real error renders an error block: ${hist}`)
    assert.match(hist, /errorTexts=\["API Error 500: upstream failed"\]/, `error block carries real error only: ${hist}`)
    const partial = need('HISTORY_PARTIAL')
    assert.match(partial, /kept=true/, `partial abort content kept: ${partial}`)
    assert.match(partial, /hasErrorBlock=false/, `partial abort has no error block: ${partial}`)
    assert.equal(need('HISTORY_REALERR'), 'HISTORY_REALERR hasErrorBlock=true')
    // 半截内容中断（流式）：内容固化、无 errorMessage、无错误块
    const pl = need('PARTIAL_LIVE')
    assert.match(pl, /kept=true/, `partial live content kept: ${pl}`)
    assert.match(pl, /errorMessageKept=true/, `errorMessage kept as truth (renderer decides neutrality): ${pl}`)
    assert.match(pl, /lastBubbleBlocks=\["text","tool"\]/, `partial bubble keeps text + dangling tool: ${pl}`)
    assert.match(pl, /lastBubbleHasError=false/, `partial bubble has no error block: ${pl}`)
    assert.match(pl, /danglingToolState=error/, `dangling toolCall converges to terminal state (no eternal spinner): ${pl}`)
    // 断连兜底
    assert.match(need('DISCONNECT_BEFORE'), /isCompacting=true pseudoVisible=true/)
    assert.match(need('DISCONNECT_AFTER'), /isCompacting=false pseudoVisible=false/)
    // attach 路径：压缩窗口快照恢复指示器与 busy；旧服务端字段缺失不动本地态；
    // compaction 事件流继续驱动
    assert.equal(need('ATTACH'), 'ATTACH isCompacting=true busy=true pseudoVisible=true')
    assert.equal(need('ATTACH_LEGACY'), 'ATTACH_LEGACY isCompacting=true')
    assert.match(need('ATTACH_START'), /isCompacting=true pseudoVisible=true/)
    assert.match(need('ATTACH_END'), /isCompacting=false pseudoVisible=false/)
    // 手动 /compact：chat 命令路径（streamCommandDeferred），与其它命令回执同形
    const ms = need('MANUAL_START')
    assert.match(ms, /busy=true/, `manual compact enters busy state: ${ms}`)
    assert.equal(need('MANUAL_WINDOW'), 'MANUAL_WINDOW isCompacting=true pseudoVisible=true')
    assert.equal(need('MANUAL_DONE'), 'MANUAL_DONE isCompacting=false chatSending=false receiptBubble=true receiptAfterDone=1')
    const mf = need('MANUAL_FAIL')
    assert.match(mf, /isCompacting=false chatSending=false pseudoVisible=false/, `failed compact converges: ${mf}`)
    assert.match(mf, /errorToast=\["chat.compactNothingToDo"\]/, `localized too-small toast: ${mf}`)
    // !! 回执驻留管线：无乐观气泡 → live 气泡 → done 重拉后重挂存活且仅一条 → reset 后不复活
    assert.equal(need('BASH_RECEIPT'), 'BASH_RECEIPT noOptimistic=true liveBubble=true afterDoneCount=1')
    assert.equal(need('BASH_RECEIPT_RESET'), 'BASH_RECEIPT_RESET gone=true')
    // 阈值自动压缩：与手动/在线压缩同一渲染路径（统一性验收）
    const aw = need('AUTO_WINDOW')
    assert.match(aw, /isCompacting=true/, `auto window active: ${aw}`)
    assert.match(aw, /lastId=context-compacting lastBlock=compacting/, `auto window tail is transient row: ${aw}`)
    assert.match(aw, /newErrorBlocks=0/, `auto window adds no error blocks: ${aw}`)
    assert.match(need('AUTO_END'), /isCompacting=false pseudoVisible=false/)
    assert.equal(need('AUTO_RESUME'), 'AUTO_RESUME rendered=true')
    // 冷加载历史：空 abort 零痕迹、正常消息保留
    const cold = need('COLD')
    assert.match(cold, /emptyAbortVisible=false/, `cold-load empty abort invisible: ${cold}`)
    assert.match(cold, /texts=\["old task","final answer"\]/, `cold-load normal texts intact: ${cold}`)
    assert.match(cold, /errorBlocks=0/, `cold-load no error blocks: ${cold}`)

    await rm(outDir, { recursive: true, force: true })
})
