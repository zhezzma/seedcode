/**
 * 行为级回归测试：tool_execution_start 查重（重连/attach 场景双卡 bug）。
 *
 * Bug 链条：pi 在 assistant message_end（消息落盘）之后才执行工具并发
 * tool_execution_start。重连场景（切走会话回来 / 刷新页面 / attach 间隙）下，
 * 历史（/messages、attach 快照）来自服务端落盘数据——已含同 id 的 toolCall
 * block；而 start 分支此前无条件 push 到 chatStream，产生同 id 双卡（历史卡
 * 永远转圈 calling + stream 卡正常跑完），直到 done 全量刷新才消失。
 *
 * 修复语义：start 与 update/end 同规则——stream 按 id 查重、历史按 id 查重，
 * 命中则跳过 push（后续 update/end 经各自的历史兜底就地更新该 block）。
 * 正常 live 流不受影响：message_end 固化的是本地 stream（服务端只转发
 * text/thinking delta，本地 stream 无 toolCall block），start 到达时历史无同
 * id 卡，照常建卡。
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

// 服务端落盘形态的历史：assistant 消息 content 含 toolCall block（pi 落盘语义），
// block 无 toolState 字段（前端渲染默认 calling）
const HISTORY = [
    { role: 'user', content: 'spawn it', timestamp: 1, entryId: 'e-user' },
    {
        role: 'assistant',
        content: [
            { type: 'text', text: 'let me spawn the subagent' },
            { type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { agent: 'worker', mode: 'single', task: 'do it' } },
        ],
        timestamp: 2, entryId: 'e-a1', parentEntryId: 'e-user',
    },
]

const harnessEntry = `
;(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { (globalThis as any).window = { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) } } catch {}
;(globalThis as any).document = { createElement: () => ({ style: {} }), addEventListener: () => {}, removeEventListener: () => {} }

import { createPinia, setActivePinia } from 'pinia'
setActivePinia(createPinia())

;(globalThis as any).fetch = async (url: string, init?: any) => {
    const u = new URL(url)
    const body = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
    const sess = (id: string) => body({ ok: true, payload: { id, name: id, modelProvider: 'p0', model: 'm0', thinkingLevel: 'off', agentId: 'clear' } })
    if (u.pathname === '/api/sessions') return body({ ok: true, payload: { sessions: [{ id: 'S1', name: 'S1', modelProvider: 'p0', model: 'm0', thinkingLevel: 'off' }] } })
    if (u.pathname === '/api/sessions/S1/info') return sess('S1')
    if (u.pathname === '/api/chat/S1/messages') return body({ ok: true, payload: { messages: ${'${HISTORY_JSON}'}, isStreaming: false } })
    if (u.pathname === '/api/chat/S1/entries') return body({ ok: true, payload: { leafId: null, entries: [] } })
    return body({ ok: true, payload: {} })
}

const { useChatState } = await import('${'${STATE_SRC}'}')
const { useChatMessages } = await import('${'${MSGS_SRC}'}')
const { useUiSettingsStore } = await import('${'${STORE_SRC}'}')
;(useUiSettingsStore() as any).apiBaseUrl = 'http://mock-api'
;(useUiSettingsStore() as any).assistantMsgMerge = false

const chat = useChatState() as any
const msgs = useChatMessages(chat as any)
await chat.setSessionKey('S1')

// 重连后继续同一 run：sendMessage 仅用于建立 chat SSE（事件路由与 attach 流等价，
// handleSSEEvent 一视同仁）；此处直接 emit 重放/live 的工具事件
await chat.sendMessage('continue')
const sse = (globalThis as any).__sse
const emit = (event: string, data: any) => sse.handlers.chat.onEvent({ event, data })

// 场景 A：重连重放——start 的 toolCallId 已存在于历史（落盘 assistant 消息）
emit('tool_execution_start', { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'subagent', args: { agent: 'worker', mode: 'single', task: 'do it' } })
{
    const list = msgs.processedMessages.value
    const toolCards = list.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool'))
    console.log('AFTER_REPLAY_START toolCards=' + toolCards.length + ' streamToolBlocks=' + (chat.getSessionData('S1').chatStream || []).filter((b: any) => b.type === 'toolCall').length)
}

// 后续 update/end 应落到既有 block（无论历史还是 stream），不新增卡
emit('tool_execution_update', { type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'subagent', partialResult: { content: 'running...' } })
{
    const list = msgs.processedMessages.value
    const toolCards = list.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool'))
    console.log('AFTER_UPDATE toolCards=' + toolCards.length + ' anyResult=' + toolCards.some((b: any) => (b.toolResult || '').includes('running')))
}
emit('tool_execution_end', { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'subagent', result: { content: 'done' }, isError: false })
{
    const list = msgs.processedMessages.value
    const toolCards = list.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool'))
    console.log('AFTER_END toolCards=' + toolCards.length + ' states=' + toolCards.map((b: any) => b.toolState).join(','))
}

// 场景 B：正常 live 流——新 id 的 start 必须照常建卡（防过度修复）
emit('tool_execution_start', { type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'bash', args: { cmd: 'ls' } })
{
    const list = msgs.processedMessages.value
    const toolCards = list.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool'))
    const call2 = toolCards.filter((b: any) => b.toolCallId === 'call-2')
    console.log('AFTER_LIVE_START totalCards=' + toolCards.length + ' call2Cards=' + call2.length + ' call2State=' + (call2[0]?.toolState || 'none'))
}
`

const entry = harnessEntry
    .replace(/\$\{STATE_SRC\}/g, srcPath('src/composables/useChatState.ts'))
    .replace(/\$\{MSGS_SRC\}/g, srcPath('src/composables/useChatMessages.ts'))
    .replace(/\$\{STORE_SRC\}/g, srcPath('src/stores/setting.ts'))
    .replace(/\$\{HISTORY_JSON\}/g, JSON.stringify(HISTORY))

// 把 harness entry 作为虚拟入口打包（stdin 模式，无需落盘入口文件）
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

test('重连场景：历史已含同 id toolCall 时 start 不重复建卡，update/end 就地更新（行为级）', async () => {
    const code = await buildHarness()
    const outfile = join(testDir, '.tool-start-dedupe.bundle.mjs')
    const { writeFile, rm } = await import('node:fs/promises')
    await writeFile(outfile, code)
    try {
        const { execFileSync } = await import('node:child_process')
        const out = execFileSync(process.execPath, [outfile], { encoding: 'utf8', cwd: repoRoot })
        const lines = Object.fromEntries(
            out.split('\n').filter((l) => /^[A-Z_]+ /.test(l)).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]),
        )
        // 场景 A：重放 start 不产生第二张卡
        assert.equal(lines.AFTER_REPLAY_START, 'toolCards=1 streamToolBlocks=0',
            `重放 start 后应只有 1 张卡且 chatStream 无 toolCall，实际: ${lines.AFTER_REPLAY_START}`)
        // update 落到既有 block
        assert.equal(lines.AFTER_UPDATE, 'toolCards=1 anyResult=true',
            `update 后仍 1 张卡且结果就地更新，实际: ${lines.AFTER_UPDATE}`)
        // end 落到既有 block 且终态 success
        assert.equal(lines.AFTER_END, 'toolCards=1 states=success',
            `end 后仍 1 张卡且终态 success，实际: ${lines.AFTER_END}`)
        // 场景 B：正常 live start（新 id）照常建卡
        assert.equal(lines.AFTER_LIVE_START, 'totalCards=2 call2Cards=1 call2State=calling',
            `新 id start 应正常建卡（共 2 张：历史 call-1 + 新 call-2），实际: ${lines.AFTER_LIVE_START}`)
    } finally {
        await rm(outfile, { force: true })
    }
})
