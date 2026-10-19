/**
 * 行为级回归测试：attach 快照与旧连接遗留 chatStream 的对账（双卡 / 文字错序 bug）。
 *
 * Bug 链条（切走再切回 + 长工具运行场景，画图/子代理/code_review 等最易命中）：
 * 1. 切走会话时 abortSessionSSE 只断本地 SSE，sessionsMap 里的 chatStream 原样保留；
 * 2. 切回时 setSessionKey 走缓存路径（needsLoad=false）→ 直接 attachToSessionIfNeeded，
 *    不重拉 /messages；
 * 3. 服务端在 assistant message_end（落盘，含 toolCall block）之后才执行工具，
 *    故工具运行期间 attach 收到的快照历史已含 [text1, toolCall]；
 * 4. applyAttachMessageState 用快照替换了 chatMessages，但
 *    `chatStream = chatStream || []` 把旧连接遗留的流内容原样保留——
 *    · 遗留 [toolCall卡] + 历史 [text1, toolCall] → 同 id 双卡；
 *      且后续 toolResult 的 message_end 还会把遗留卡固化成第二条永久消息；
 *    · 遗留 [text1]（断开时未收 message_end）渲染在历史 [text1, toolCall] 之后
 *      → 「调用工具前的文字跑到工具卡后面」，同样被固化成重复消息。
 *
 * 修复语义：message_state 对账时旧流一律作废——在飞内容唯一合法来源是
 * streamMessage（快照重建）；运行中工具的卡片活在历史消息里（start 查重跳过
 * push，update/end 历史兜底就地更新）。
 * 防御层：message_end 固化时剔除与历史同 id 的 toolCall block，任何路径遗留的
 * 流内工具卡都不会固化成第二张永久卡。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
export function startCompactSSE(sessionId, body, onEvent, onError) { return makeConn('compact', sessionId, onEvent, onError); }
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

const harnessEntry = `
;(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { (globalThis as any).window = { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) } } catch {}
;(globalThis as any).document = { createElement: () => ({ style: {} }), addEventListener: () => {}, removeEventListener: () => {} }

import { createPinia, setActivePinia } from 'pinia'
setActivePinia(createPinia())

// 服务端视角的可变历史：/messages 与 attach 快照共用，测试中按 run 进度推进
const serverHistory = ((globalThis as any).__history = [
    { role: 'user', content: 'draw it', timestamp: 1, entryId: 'e-user' },
])

;(globalThis as any).fetch = async (url: string, init?: any) => {
    const u = new URL(url)
    const body = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
    const sess = (id: string) => body({ ok: true, payload: { id, name: id, modelProvider: 'p0', model: 'm0', thinkingLevel: 'off', agentId: 'clear' } })
    if (u.pathname === '/api/sessions') return body({ ok: true, payload: { sessions: [{ id: 'S1', name: 'S1', modelProvider: 'p0', model: 'm0', thinkingLevel: 'off' }, { id: 'S2', name: 'S2', modelProvider: 'p0', model: 'm0', thinkingLevel: 'off' }] } })
    if (u.pathname === '/api/sessions/S1/info') return sess('S1')
    if (u.pathname === '/api/sessions/S2/info') return sess('S2')
    if (u.pathname === '/api/chat/S1/messages') return body({ ok: true, payload: { messages: (globalThis as any).__history, isStreaming: false } })
    if (u.pathname === '/api/chat/S1/entries') return body({ ok: true, payload: { leafId: null, entries: [] } })
    return body({ ok: true, payload: {} })
}

const { useChatState } = await import('${'${STATE_SRC}'}')
const { useChatMessages } = await import('${'${MSGS_SRC}'}')
const { useUiSettingsStore } = await import('${'${STORE_SRC}'}')
;(useUiSettingsStore() as any).apiBaseUrl = 'http://mock-api'

const chat = useChatState() as any
const msgs = useChatMessages(chat as any)
const sse = (globalThis as any).__sse
const emit = (conn: string, event: string, data: any) => sse.handlers[conn].onEvent({ event, data })

const countCards = (id: string) => msgs.processedMessages.value
    .flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool' && (!id || b.toolCallId === id))).length
const dumpOrder = () => msgs.processedMessages.value
    .flatMap((m: any) => m.blocks.map((b: any) => b.type === 'tool' ? 'CARD(' + b.toolCallId + ')' : b.type === 'text' ? 'TEXT(' + (b.text || '').slice(0, 12) + ')' : b.type))
    .join(' | ')

await chat.setSessionKey('S1')

// ─── 场景 D：切走时工具卡已入流，切回后快照历史已含同 id block（双卡）───
await chat.sendMessage('draw it')
// 服务端：assistant 文本流 + message_end（落盘，含 toolCall block）
emit('chat', 'text_delta', { delta: '我来画一张图' })
serverHistory.push({ role: 'assistant', content: [
    { type: 'text', text: '我来画一张图' },
    { type: 'toolCall', id: 'call-D', name: 'generate_image', arguments: { prompt: 'cat' } },
], timestamp: 2, entryId: 'e-a1', parentEntryId: 'e-user' })
emit('chat', 'message_end', { message: { role: 'assistant', timestamp: 2 } })
// 工具开跑（长工具），卡入流；随后用户切走（abort 本地 SSE，流残留）再切回
emit('chat', 'tool_execution_start', { toolCallId: 'call-D', toolName: 'generate_image', args: { prompt: 'cat' } })
console.log('D_BEFORE_SWITCH cards=' + countCards('call-D'))
await chat.setSessionKey('S2')
await chat.setSessionKey('S1')
// attach 快照：历史已含落盘 assistant（含 toolCall），streamMessage=null（工具运行中）
emit('attach', 'message_state', { messages: JSON.parse(JSON.stringify(serverHistory)), streamMessage: null, isStreaming: true, pendingQueue: [] })
console.log('D_AFTER_ATTACH cards=' + countCards('call-D') + ' order=' + dumpOrder())
// 工具结束 + toolResult 落盘回显；随后下一轮 assistant 文本
emit('attach', 'tool_execution_end', { toolCallId: 'call-D', toolName: 'generate_image', result: { content: 'done' }, isError: false })
emit('attach', 'message_start', { message: { role: 'toolResult', toolCallId: 'call-D' } })
emit('attach', 'message_end', { message: { role: 'toolResult', toolCallId: 'call-D', toolName: 'generate_image', content: 'done' } })
console.log('D_AFTER_TOOLRESULT cards=' + countCards('call-D') + ' order=' + dumpOrder())
emit('attach', 'message_start', { message: { role: 'assistant' } })
emit('attach', 'text_delta', { delta: '画好了' })
emit('attach', 'message_end', { message: { role: 'assistant', timestamp: 3 } })
emit('attach', 'done', { message: 'Complete' })
console.log('D_FINAL cards=' + countCards('call-D') + ' totalCards=' + countCards('') + ' order=' + dumpOrder())

// ─── 场景 G：切走时文字已入流但未收 message_end，切回后落盘历史已含
//     [text, toolCall]——遗留文字不得渲染在工具卡之后/固化成重复消息 ───
serverHistory.length = 0
serverHistory.push({ role: 'user', content: 'again', timestamp: 10, entryId: 'e-user2' })
await chat.setSessionKey('S2')
await chat.setSessionKey('S1')   // 缓存路径：sessionsMap 已有 S1
await chat.sendMessage('again')
emit('chat', 'text_delta', { delta: '再画一张' })
// 断开窗口内服务端完成 message_end（落盘）+ 工具开跑
serverHistory.push({ role: 'assistant', content: [
    { type: 'text', text: '再画一张' },
    { type: 'toolCall', id: 'call-G', name: 'subagent', arguments: { task: 'go' } },
], timestamp: 11, entryId: 'e-a2', parentEntryId: 'e-user2' })
emit('chat', 'tool_execution_start', { toolCallId: 'call-G', toolName: 'subagent', args: { task: 'go' } })
await chat.setSessionKey('S2')
await chat.setSessionKey('S1')
emit('attach', 'message_state', { messages: JSON.parse(JSON.stringify(serverHistory)), streamMessage: null, isStreaming: true, pendingQueue: [] })
console.log('G_AFTER_ATTACH order=' + dumpOrder())
emit('attach', 'tool_execution_end', { toolCallId: 'call-G', toolName: 'subagent', result: { content: 'ok' }, isError: false })
emit('attach', 'message_start', { message: { role: 'toolResult', toolCallId: 'call-G' } })
emit('attach', 'message_end', { message: { role: 'toolResult', toolCallId: 'call-G', toolName: 'subagent', content: 'ok' } })
console.log('G_FINAL order=' + dumpOrder() + ' textCount=' + msgs.processedMessages.value.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'text' && b.text === '再画一张')).length)
`

const entry = harnessEntry
    .replace(/\$\{STATE_SRC\}/g, srcPath('src/composables/useChatState.ts'))
    .replace(/\$\{MSGS_SRC\}/g, srcPath('src/composables/useChatMessages.ts'))
    .replace(/\$\{STORE_SRC\}/g, srcPath('src/stores/setting.ts'))

async function buildHarness(): Promise<string> {
    const r = await build({
        stdin: {
            contents: entry,
            resolveDir: repoRoot,
            sourcefile: 'harness-entry.mts',
            loader: 'ts',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        external: ['vue', 'pinia'],
        plugins: [stubPluginForTest()],
        write: false,
    })
    return r.outputFiles[0].text
}

async function runHarness(): Promise<Record<string, string>> {
    const code = await buildHarness()
    const outfile = join(testDir, '.attach-stale-stream.bundle.mjs')
    const { writeFile, rm } = await import('node:fs/promises')
    await writeFile(outfile, code)
    try {
        const { execFileSync } = await import('node:child_process')
        const out = execFileSync(process.execPath, [outfile], { encoding: 'utf8', cwd: repoRoot })
        return Object.fromEntries(
            out.split('\n').filter((l) => /^[A-Z0-9_]+ /.test(l)).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]),
        )
    } finally {
        await rm(outfile, { force: true })
    }
}

test('场景 D：切回后快照历史含同 id 工具卡时，遗留流内卡不得双显/固化（行为级）', async () => {
    const lines = await runHarness()
    // 切走前：流内 1 张卡（正常 live）
    assert.ok(lines.D_BEFORE_SWITCH.startsWith('cards=1'), `切走前应 1 张卡: ${lines.D_BEFORE_SWITCH}`)
    // attach 对账后：仍只有 1 张卡（历史卡），流内遗留卡被作废
    assert.ok(lines.D_AFTER_ATTACH.startsWith('cards=1'), `attach 后应只有 1 张卡（修复前为 2）: ${lines.D_AFTER_ATTACH}`)
    // toolResult 的 message_end 不会把遗留卡固化成第二条消息
    assert.ok(lines.D_AFTER_TOOLRESULT.startsWith('cards=1'), `toolResult 后仍应 1 张卡: ${lines.D_AFTER_TOOLRESULT}`)
    // 整轮结束（含 done 触发的 /messages 全量刷新回来前的本地态）：1 张卡，顺序为 文本→卡→文本
    assert.ok(lines.D_FINAL.startsWith('cards=1 totalCards=1'), `最终 1 张卡: ${lines.D_FINAL}`)
    assert.ok(lines.D_FINAL.includes('TEXT(我来画一张图) | CARD(call-D)'), `顺序应为 文本→卡→文本: ${lines.D_FINAL}`)
    assert.ok(lines.D_FINAL.includes('CARD(call-D) | TEXT(画好了)'), `卡后应接后续文本: ${lines.D_FINAL}`)
})

test('场景 G：切走时未固化的文字，切回后不得渲染在工具卡之后/固化成重复消息（行为级）', async () => {
    const lines = await runHarness()
    // attach 后：文字只在卡前出现一次（修复前：遗留文字渲染在 [text, card] 之后）
    assert.ok(lines.G_AFTER_ATTACH.includes('TEXT(再画一张) | CARD(call-G)'), `attach 后顺序应为 文本→卡（修复前卡后多出遗留文本）: ${lines.G_AFTER_ATTACH}`)
    assert.ok(!lines.G_AFTER_ATTACH.includes('TEXT(再画一张) | TEXT'), `文本不得重复: ${lines.G_AFTER_ATTACH}`)
    // toolResult message_end 不得把遗留文字固化成重复消息
    assert.ok(lines.G_FINAL.endsWith('textCount=1'), `最终文本恰 1 份: ${lines.G_FINAL}`)
    assert.ok(lines.G_FINAL.includes('TEXT(再画一张) | CARD(call-G)'), `最终顺序应为 文本→卡: ${lines.G_FINAL}`)
})
