/**
 * 行为级回归测试：思考块标题三点动画（loading-dots）的消失时机。
 *
 * Bug（用户主诉）：单 phase 协议（thinking 与正文在同一条 assistant 消息内，
 * OpenAI 兼容网关最常见）下，思考结束后三点不消失，一直转到整条回复的
 * message_end；"有时正常"的是多 phase 协议（Gemini 等把 thinking 作为独立
 * 消息 phase），其 thinking 的 message_end 会固化消息并置空 chatStream，
 * 三点恰好随思考结束消失——时机对错取决于网关的 phase 划分，故呈间歇性。
 *
 * 根因：__liveBlocks 是「多标记、刻意不清除」的渲染策略标记（交错推理防抖 +
 * 保守定格，见 chat-attach.markLiveStreamBlock 注释），语义是「曾经增长过」；
 * 三点动画直接复用它，把「曾经增长过」误读为「正在思考」。
 *
 * 修复语义：新增「最近活跃块」单标记（__activeBlock，随每个 delta 覆盖转移），
 * 三点动画改用它判定；渲染策略（纯文本直播 vs markdown 定格）保持 __liveBlocks
 * 不动——交错推理场景下 thinking_delta 到达会把活跃标记拉回 thinking 块，
 * 三点恢复（语义正确：思考确实又开始了），且不触发 markdown 重渲抖动。
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

;(globalThis as any).fetch = async (url: string) => {
    const u = new URL(url)
    const body = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
    const sess = (id: string) => body({ ok: true, payload: { id, name: id, modelProvider: 'p0', model: 'm0', thinkingLevel: 'off', agentId: 'clear' } })
    if (u.pathname === '/api/sessions') return body({ ok: true, payload: { sessions: [{ id: 'S1', name: 'S1', modelProvider: 'p0', model: 'm0', thinkingLevel: 'off' }] } })
    if (u.pathname === '/api/sessions/S1/info') return sess('S1')
    if (u.pathname === '/api/chat/S1/messages') return body({ ok: true, payload: { messages: [], isStreaming: false } })
    if (u.pathname === '/api/chat/S1/entries') return body({ ok: true, payload: { leafId: null, entries: [] } })
    return body({ ok: true, payload: {} })
}

const { useChatState } = await import('${'${STATE_SRC}'}')
const { useChatMessages } = await import('${'${MSGS_SRC}'}')
const { useUiSettingsStore } = await import('${'${STORE_SRC}'}')
const { isLiveStreamBlock, isActiveStreamBlock } = await import('${'${ATTACH_SRC}'}')
;(useUiSettingsStore() as any).apiBaseUrl = 'http://mock-api'

const chat = useChatState() as any
const msgs = useChatMessages(chat as any)
const sse = (globalThis as any).__sse
const emit = (conn: string, event: string, data: any) => sse.handlers[conn].onEvent({ event, data })

const streamOf = () => chat.sessionsMap.get('S1').chatStream
const blockOf = (stream: any[] | null, type: string) => (stream || []).find((b: any) => b.type === type) || null
const marks = (stream: any[] | null, b: any) => b && stream
    ? 'live=' + isLiveStreamBlock(stream, b) + ' active=' + isActiveStreamBlock(stream, b)
    : 'absent'

// 行为层 dump：UI（MessageBubble/ThinkingBlock）消费的正是 processedMessages 里的这两个标记
const dumpLastAssistantBlocks = () => {
    const list = msgs.processedMessages.value as any[]
    const last = [...list].reverse().find((m) => m.role === 'assistant')
    return (last?.blocks || []).map((b: any) =>
        b.type === 'thinking' ? 'THINK(' + (b.text || '').slice(0, 12) + ') s=' + !!b.streaming + ' a=' + !!b.active
            : b.type === 'text' ? 'TEXT(' + (b.text || '').slice(0, 12) + ')'
            : b.type.toUpperCase()
    ).join(' | ')
}

await chat.setSessionKey('S1')

// ─── 场景 A：单 phase 主诉——正文开始（text_delta）即思考结束，三点应消失 ───
await chat.sendMessage('讲个笑话')
emit('chat', 'message_start', { message: { role: 'assistant' } })
emit('chat', 'thinking_delta', { contentIndex: 0, delta: '思考中…… ' })
emit('chat', 'thinking_delta', { contentIndex: 0, delta: '想好了' })
let stream = streamOf()
console.log('A_THINKING ' + marks(stream, blockOf(stream, 'thinking')))
console.log('A_THINKING_UI ' + dumpLastAssistantBlocks())
emit('chat', 'text_delta', { contentIndex: 1, delta: '正文开始了' })
stream = streamOf()
console.log('A_AFTER_TEXT_THINKING ' + marks(stream, blockOf(stream, 'thinking')))
console.log('A_AFTER_TEXT_TEXT ' + marks(stream, blockOf(stream, 'text')))
console.log('A_AFTER_TEXT_UI ' + dumpLastAssistantBlocks())

// ─── 场景 B：交错推理——正文之后思考又来了，三点应恢复 ───
emit('chat', 'thinking_delta', { contentIndex: 0, delta: '，再补一句' })
stream = streamOf()
console.log('B_RESUMED_THINKING ' + marks(stream, blockOf(stream, 'thinking')))

// ─── 场景 C：message_end 固化 → 历史块两标记皆无（三点必然消失）───
emit('chat', 'message_end', { message: { role: 'assistant', timestamp: 2 } })
console.log('C_HIST_UI ' + dumpLastAssistantBlocks())

// ─── 场景 D：attach 快照重放——渲染策略标记照旧全补（live=true），
//      活跃标记标最后一个块：尾部是 text → thinking 三点不闪；尾部是 thinking → 三点连续 ───
emit('chat', 'message_start', { message: { role: 'assistant' } })
emit('attach', 'message_state', {
    messages: [],
    streamMessage: { role: 'assistant', content: [
        { type: 'thinking', thinking: '快照思考' },
        { type: 'text', text: '快照正文' },
    ] },
    isStreaming: true,
    pendingQueue: [],
})
stream = streamOf()
console.log('D_TEXT_TAIL_THINKING ' + marks(stream, blockOf(stream, 'thinking')))
emit('chat', 'message_end', { message: { role: 'assistant', timestamp: 3 } })
emit('chat', 'message_start', { message: { role: 'assistant' } })
emit('attach', 'message_state', {
    messages: [],
    streamMessage: { role: 'assistant', content: [
        { type: 'thinking', thinking: '重连时仍在思考' },
    ] },
    isStreaming: true,
    pendingQueue: [],
})
stream = streamOf()
console.log('D2_THINK_TAIL_THINKING ' + marks(stream, blockOf(stream, 'thinking')))
`

const entry = harnessEntry
    .replace(/\$\{STATE_SRC\}/g, srcPath('src/composables/useChatState.ts'))
    .replace(/\$\{MSGS_SRC\}/g, srcPath('src/composables/useChatMessages.ts'))
    .replace(/\$\{STORE_SRC\}/g, srcPath('src/stores/setting.ts'))
    .replace(/\$\{ATTACH_SRC\}/g, srcPath('src/utils/chat-attach.ts'))

async function runHarness(): Promise<Record<string, string>> {
    const r = await build({
        stdin: { contents: entry, resolveDir: repoRoot, sourcefile: 'harness-entry.mts', loader: 'ts' },
        bundle: true,
        format: 'esm',
        platform: 'node',
        external: ['vue', 'pinia'],
        plugins: [stubPluginForTest()],
        write: false,
    })
    const outfile = join(testDir, '.thinking-dots-dismissal.bundle.mjs')
    const { writeFile, rm } = await import('node:fs/promises')
    await writeFile(outfile, r.outputFiles[0].text)
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

test('场景 A：单 phase 正文开始 → 思考块三点消失（active=false），渲染策略不变（streaming=true）', async () => {
    const lines = await runHarness()
    // 思考期间：三点亮（active=true）
    assert.strictEqual(lines.A_THINKING, 'live=true active=true', `思考增长中应 active=true: ${lines.A_THINKING}`)
    assert.ok(lines.A_THINKING_UI.includes('s=true a=true'), `UI 层思考中应 streaming+active: ${lines.A_THINKING_UI}`)
    // 正文开始：三点灭（active=false），渲染策略保持直播（streaming=true，交错推理防抖语义不变）
    assert.strictEqual(lines.A_AFTER_TEXT_THINKING, 'live=true active=false', `正文开始后思考块应 active=false 且 live 不变: ${lines.A_AFTER_TEXT_THINKING}`)
    assert.strictEqual(lines.A_AFTER_TEXT_TEXT, 'live=true active=true', `正文块应为当前活跃块: ${lines.A_AFTER_TEXT_TEXT}`)
    assert.ok(lines.A_AFTER_TEXT_UI.includes('s=true a=false'), `UI 层思考块三点应消失但保持直播渲染: ${lines.A_AFTER_TEXT_UI}`)
})

test('场景 B：交错推理 thinking_delta 回注 → 三点恢复（语义正确：思考确实又开始了）', async () => {
    const lines = await runHarness()
    assert.strictEqual(lines.B_RESUMED_THINKING, 'live=true active=true', `思考恢复增长应 active=true: ${lines.B_RESUMED_THINKING}`)
})

test('场景 C：message_end 固化进历史 → 三点与直播标记皆无', async () => {
    const lines = await runHarness()
    assert.ok(lines.C_HIST_UI.includes('s=false a=false'), `历史思考块应定格: ${lines.C_HIST_UI}`)
})

test('场景 D：attach 重放——尾部 text 时思考三点不闪；尾部 thinking 时三点连续', async () => {
    const lines = await runHarness()
    assert.strictEqual(lines.D_TEXT_TAIL_THINKING, 'live=true active=false', `重放尾部为 text：思考块 live 补齐但非活跃: ${lines.D_TEXT_TAIL_THINKING}`)
    assert.strictEqual(lines.D2_THINK_TAIL_THINKING, 'live=true active=true', `重连时思考仍在增长：活跃标记标尾块保持连续: ${lines.D2_THINK_TAIL_THINKING}`)
})
