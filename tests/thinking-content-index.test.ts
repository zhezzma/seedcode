/**
 * 行为级回归测试：流式 delta 按 contentIndex 路由（思考过程截断正文 / 思考块翻倍 bug）。
 *
 * Bug 链条（openai 兼容网关 + reasoning 交错输出的模型，如 step 系列最易命中）：
 * 1. pi-ai 的 openai-completions 适配层把整条消息的所有 reasoning 增量都路由到
 *    同一个 thinking 块（contentIndex 固定指向它），正文同理指向同一个 text 块；
 * 2. 网关的 reasoning 增量可能交错出现在正文中间：
 *    thinking(ci=0) → text(ci=1,"…SWC") → thinking(ci=0) → text(ci=1,"原生二进制…")；
 * 3. 服务端按 contentIndex 累积落盘 → 历史是正确的 [thinking, text]；
 *    前端若忽略 contentIndex、只按「末尾块同类型才合并」，mid-text 的 thinking
 *    增量会被当成新块插进正文中间 → 正文被劈成两段、思考块翻倍（流式渲染与
 *    落盘历史不一致，message_end 后才被 done 全量刷新"治好"）。
 *
 * 修复语义：
 * - delta 事件携带 contentIndex 时按其定位目标块（新下标首次出现则在末尾新建，
 *   块上打 _ci 标记）；缺省时退回旧的末尾邻接合并（旧服务端兼容）。
 * - _ci 是纯前端流内路由标记：message_end 固化时剥离，不进历史。
 * - attach 快照 streamMessage.content 即 pi partial 消息 content 数组，重放时按
 *   原始数组下标打 _ci（先打标再剥 toolCall，工具卡占位下标不挤占文本/思考块）。
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
;(useUiSettingsStore() as any).apiBaseUrl = 'http://mock-api'

const chat = useChatState() as any
const msgs = useChatMessages(chat as any)
const sse = (globalThis as any).__sse
const emit = (conn: string, event: string, data: any) => sse.handlers[conn].onEvent({ event, data })

const streamOf = () => chat.sessionsMap.get('S1').chatStream || []
const dumpStream = () => streamOf().map((b: any) => {
    const ci = typeof b._ci === 'number' ? '@' + b._ci : ''
    if (b.type === 'text') return 'TEXT' + ci + '(' + (b.text || '') + ')'
    if (b.type === 'thinking') return 'THINK' + ci + '(' + (b.thinking || '') + ')'
    return b.type.toUpperCase() + ci
}).join(' | ')

await chat.setSessionKey('S1')

// ─── 场景 A：reasoning 交错出现在正文中间（contentIndex 指回块 0）───
await chat.sendMessage('查一下')
emit('chat', 'message_start', { message: { role: 'assistant' } })
emit('chat', 'thinking_delta', { contentIndex: 0, delta: '先想一步 ' })
emit('chat', 'text_delta',      { contentIndex: 1, delta: '锁它的是 Next 的 SWC' })
emit('chat', 'thinking_delta', { contentIndex: 0, delta: '再想一步' })
emit('chat', 'text_delta',      { contentIndex: 1, delta: ' 原生二进制——进程还在跑' })
console.log('A_STREAM ' + dumpStream())
emit('chat', 'message_end', { message: { role: 'assistant', timestamp: 2 } })
const solidified = chat.sessionsMap.get('S1').chatMessages.filter((m: any) => m.role === 'assistant')
const contentA = solidified[solidified.length - 1].content
console.log('A_SOLIDIFIED ' + JSON.stringify(contentA))

// ─── 场景 B：attach 快照含 toolCall 占位块（下标挤占），重放后 live 增量按原始下标合并 ───
emit('chat', 'message_start', { message: { role: 'assistant' } })
emit('attach', 'message_state', {
    messages: [],
    streamMessage: { role: 'assistant', content: [
        { type: 'thinking', thinking: '快照思考' },
        { type: 'toolCall', id: 'call-B', name: 'bash', partialArgs: '' },
        { type: 'text', text: '快照正文' },
    ] },
    isStreaming: true,
    pendingQueue: [],
})
console.log('B_REPLAY ' + dumpStream())
emit('chat', 'thinking_delta', { contentIndex: 0, delta: '+续' })
emit('chat', 'text_delta',      { contentIndex: 2, delta: '+续' })
console.log('B_MERGED ' + dumpStream())

// ─── 场景 C：旧服务端无 contentIndex → 退回末尾邻接合并 ───
emit('chat', 'message_end', { message: { role: 'assistant', timestamp: 3 } })
emit('chat', 'message_start', { message: { role: 'assistant' } })
emit('chat', 'thinking_delta', { delta: '旧思考 ' })
emit('chat', 'text_delta', { delta: '旧正文一' })
emit('chat', 'text_delta', { delta: '旧正文二' })
console.log('C_LEGACY ' + dumpStream())
`

const entry = harnessEntry
    .replace(/\$\{STATE_SRC\}/g, srcPath('src/composables/useChatState.ts'))
    .replace(/\$\{MSGS_SRC\}/g, srcPath('src/composables/useChatMessages.ts'))
    .replace(/\$\{STORE_SRC\}/g, srcPath('src/stores/setting.ts'))

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
    const outfile = join(testDir, '.thinking-content-index.bundle.mjs')
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

test('场景 A：mid-text thinking 增量按 contentIndex 回注块 0，正文不被劈开、思考块不翻倍', async () => {
    const lines = await runHarness()
    assert.strictEqual(
        lines.A_STREAM,
        'THINK@0(先想一步 再想一步) | TEXT@1(锁它的是 Next 的 SWC 原生二进制——进程还在跑)',
        `流内应为 [thinking, text] 两块: ${lines.A_STREAM}`,
    )
    // 固化进历史：[thinking, text] 各一块，且不携带 _ci 标记
    assert.ok(lines.A_SOLIDIFIED.startsWith('[{"type":"thinking"'), `首块应为 thinking: ${lines.A_SOLIDIFIED}`)
    assert.ok(!lines.A_SOLIDIFIED.includes('_ci'), `固化内容不得携带 _ci: ${lines.A_SOLIDIFIED}`)
    const content = JSON.parse(lines.A_SOLIDIFIED)
    assert.strictEqual(content.length, 2, `应恰好 thinking+text 两块: ${lines.A_SOLIDIFIED}`)
    assert.strictEqual(content[1].text, '锁它的是 Next 的 SWC 原生二进制——进程还在跑', `正文应完整连续: ${lines.A_SOLIDIFIED}`)
})

test('场景 B：attach 快照 toolCall 占位下标不挤占，重放后增量按原始下标就地合并', async () => {
    const lines = await runHarness()
    // 快照重放：toolCall 被剥掉，但 thinking/text 保留原始下标 0 / 2
    assert.strictEqual(lines.B_REPLAY, 'THINK@0(快照思考) | TEXT@2(快照正文)', `重放应保留原始下标: ${lines.B_REPLAY}`)
    // live 增量按原始下标就地合并，不新增块
    assert.strictEqual(lines.B_MERGED, 'THINK@0(快照思考+续) | TEXT@2(快照正文+续)', `增量应就地合并: ${lines.B_MERGED}`)
})

test('场景 C：无 contentIndex 的旧事件退回末尾邻接合并（兼容不回归）', async () => {
    const lines = await runHarness()
    assert.strictEqual(lines.C_LEGACY, 'THINK(旧思考 ) | TEXT(旧正文一旧正文二)', `旧语义应保持: ${lines.C_LEGACY}`)
})
