/**
 * 行为级回归测试：自动命名标题源 = 服务端转录首条 user 消息（客户端零传参）。
 *
 * 背景：标题源曾两度漂移——最初把「触发命名的那条消息」传给 generate-title
 * （重试/命令首条延迟触发场景下标题不描述会话起点）；后改为客户端直取占位
 * 标题 name 传回服务器，但占位标题只存首条消息前 100 字符，长消息被截断。
 * 现为服务端权威：generate-title 接口自行从转录取首条 user 消息全文，
 * 客户端不传任何文本。
 *
 * 本测试把真实 useSessionsState 用 esbuild 打包进 Node 可执行 bundle（stub 掉
 * tauri/i18n），断言三类场景：
 *   A. 单参触发 → POST 无 body（不携带占位标题/任何客户端文本）；
 *   B. 无占位（name 空）→ 仍触发（本地 name 不再是守卫），由服务端 400
 *      （转录无 user 消息）拒绝后回滚 titleSet，下条消息可重试；
 *   C. 失败回滚后重试 → 仍无 body。
 * 并静态钉住 HomeView 调用点为单参（不再传触发时消息）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFile, rm, mkdir, readFile } from 'node:fs/promises'
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
}

function stubPluginForTest() {
    return {
        name: 'seedcode-test-stubs',
        setup(b: any) {
            b.onResolve({ filter: /^@tauri-apps\// }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onResolve({ filter: /\/i18n$/ }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onResolve({ filter: /\/router$/ }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onResolve({ filter: /notify-client$/ }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args: any) => {
                const key = args.path.startsWith('@tauri-apps')
                    ? 'tauri'
                    : args.path.endsWith('/i18n') ? 'i18n'
                    : args.path.endsWith('/router') ? 'router'
                    : args.path.endsWith('notify-client') ? 'notify-client'
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

const RENAME_FAIL = process.env.HARNESS_RENAME_FAIL === '1'
const calls = []
;(globalThis as any).fetch = async (url, init) => {
    const u = new URL(url)
    let reqBody = null
    try { reqBody = JSON.parse(init?.body || 'null') } catch {}
    calls.push((init?.method || 'GET') + ' ' + u.pathname + ' ' + JSON.stringify(reqBody ?? null))
    const body = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
    // 冷启动列表：S1/S3 有占位标题（titleSet=false——首条消息即占位），S2 无占位
    if (u.pathname === '/api/sessions') return body({ ok: true, payload: { sessions: [
        { id: 'S1', name: '第一条消息占位', titleSet: false },
        { id: 'S2', titleSet: false },
        { id: 'S3', name: '第三条消息占位', titleSet: false },
    ] } })
    // generate-title：标题 LLM 调用（RENAME_FAIL 模拟失败）；回显收到的 body 供断言
    if (u.pathname === '/api/sessions/S1/generate-title' || u.pathname === '/api/sessions/S3/generate-title') {
        if (RENAME_FAIL) return body({ ok: false, error: 'AI returned invalid title' }, 500)
        return body({ ok: true, payload: { sessionId: u.pathname.split('/')[3], name: 'AI标题', receivedText: reqBody?.text ?? null } })
    }
    // S2（无占位）：服务端权威拒绝——转录无 user 消息 → 400
    if (u.pathname === '/api/sessions/S2/generate-title') {
        return body({ ok: false, error: 'Session has no user message' }, 400)
    }
    return body({ ok: true, payload: {} })
}

const { useSessionsState } = await import('${srcPath('src/composables/useSessionsState.ts')}')
const { useUiSettingsStore } = await import('${srcPath('src/stores/setting.ts')}')
;(useUiSettingsStore() as any).apiBaseUrl = 'http://mock-api'

const sessions = useSessionsState() as any
await sessions.loadSessions()

// 场景A：单参触发 → POST 无 body（标题源在服务端转录，客户端零传参）
await sessions.triggerSessionRename('S1')
const postA = calls.find((c) => c.includes('/generate-title')) || ''
console.log('A ' + postA + ' titleSet=' + sessions.findSessionLocal('S1')?.titleSet + ' name=' + sessions.findSessionLocal('S1')?.name)

// 场景B：无占位（name 空）→ 仍触发，服务端 400 拒绝后回滚（本地 name 不是守卫）
await sessions.triggerSessionRename('S2')
const postsB = calls.filter((c) => c.includes('S2/generate-title')).length
console.log('B posts=' + postsB + ' titleSet=' + sessions.findSessionLocal('S2')?.titleSet)

// 场景C（RENAME_FAIL=1）：失败回滚 → 重试仍无 body
if (RENAME_FAIL) {
    await sessions.triggerSessionRename('S3')
    await sessions.triggerSessionRename('S3')
    const s3Posts = calls.filter((c) => c.includes('S3/generate-title'))
    console.log('C posts=' + s3Posts.length + ' texts=' + s3Posts.map((c) => c.split(' ').pop()).join('|'))
}
`

async function runHarness(outDir: string, env: Record<string, string> = {}): Promise<string> {
    await mkdir(outDir, { recursive: true })
    const entryPath = join(outDir, 'harness-entry.ts')
    await writeFile(entryPath, harnessEntry, 'utf8')
    await build({
        entryPoints: [entryPath],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: join(outDir, 'harness.mjs'),
        external: ['vue', 'pinia'],
        logLevel: 'silent',
        plugins: [stubPluginForTest()],
    })
    // 产物必须落在仓库内（node_modules 下），否则 external 的 vue/pinia 从 Temp 解析不到
    const proc = spawnSync(process.execPath, [join(outDir, 'harness.mjs')], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, ...env },
    })
    const out = proc.stdout || ''
    if (proc.status !== 0) {
        throw new Error(`harness exited ${proc.status}\nstdout: ${out}\nstderr: ${proc.stderr}`)
    }
    return out
}

test('triggerSessionRename posts without a client text body (behavior)', async () => {
    const outDir = join(repoRoot, 'node_modules/.cache/seedcode-rename-placeholder-harness')
    try {
        const out = await runHarness(outDir)

        // A：POST 不得携带 body（标题源在服务端转录，客户端零传参）
        assert.match(out, /A POST \/api\/sessions\/S1\/generate-title null/,
            'the generate-title POST must not carry any client-provided text body')
        assert.match(out, /A .* titleSet=true name=AI标题/, 'a successful AI rename must mark the local row titleSet=true')
        // B：无占位仍触发（服务端权威判断），400 拒绝后回滚 titleSet
        assert.match(out, /B posts=1 titleSet=false/, 'a session without a placeholder must still fire generate-title and roll back on the server 400')
    } finally {
        await rm(outDir, { recursive: true, force: true })
    }
})

test('failed rename rolls titleSet back and the retry still posts without a body (behavior)', async () => {
    const outDir = join(repoRoot, 'node_modules/.cache/seedcode-rename-placeholder-fail')
    try {
        const out = await runHarness(outDir, { HARNESS_RENAME_FAIL: '1' })
        // C：失败回滚后重试仍发无 body 请求（重试不被卡死，客户端不传标题源）
        assert.match(out, /C posts=2 texts=null\|null/,
            'the retry after a failed rename must still post without a body')
    } finally {
        await rm(outDir, { recursive: true, force: true })
    }
})

test('HomeView wires the auto-rename call without a text argument', async () => {
    const home = await readFile(srcPath('src/views/HomeView.vue'), 'utf8')
    // 单参调用：标题源在服务端转录首条 user 消息，客户端不传文本
    assert.match(
        home,
        /triggerSessionRename\(targetSessionKey\)/,
        'the auto-rename call must not pass a text argument',
    )
    // 不再把触发时消息/转录扫描结果作为标题源传入
    assert.doesNotMatch(
        home,
        /triggerSessionRename\(targetSessionKey,\s*(originalUserText|chatState\.getFirstUserText)/,
        'no caller-passed title source is allowed',
    )
    // 直取方案的转录扫描助手已删（无死代码）
    const chatState = await readFile(srcPath('src/composables/useChatState.ts'), 'utf8')
    assert.doesNotMatch(chatState, /getFirstUserText/, 'the transcript-scan helper must be removed')
})

test('triggerSessionRename fires generate-title silently (expected 400 must not toast)', async () => {
    // apiPost 必须支持 silent（mirror apiGet）：去 !name 守卫后，服务端 400
    // （转录尚未落库的竞态 / 空会话）是预期路径，静默回滚下条消息重试，
    // 不得弹全局错误 toast
    const apiClient = await readFile(srcPath('src/composables/api-client.ts'), 'utf8')
    assert.match(
        apiClient,
        /export async function apiPost<T = any>\(path: string, body\?: any, silent = false\)/,
        'apiPost must accept a silent flag mirroring apiGet',
    )

    const src = await readFile(srcPath('src/composables/useSessionsState.ts'), 'utf8')
    const fn = src.match(/const triggerSessionRename = async \(targetKey: string\) => \{[\s\S]*?\n\}/)?.[0] ?? ''
    assert.ok(fn, 'triggerSessionRename source must be found')
    assert.match(
        fn,
        /undefined,[\s\S]{0,200}?\btrue\b/s,
        'triggerSessionRename must call apiPost with silent=true (no toast on expected 400)',
    )
})

test('HomeView wires retry/edit to the same single-arg auto-rename', async () => {
    const home = await readFile(srcPath('src/views/HomeView.vue'), 'utf8')
    const retryFn = home.match(/const retryMessage = async \(msg: DisplayMessage\) => \{[\s\S]*?\n\}/)?.[0] ?? ''
    const editFn = home.match(/const editMessage = async \(msg: DisplayMessage, newText: string\) => \{[\s\S]*?\n\}/)?.[0] ?? ''
    assert.ok(retryFn, 'retryMessage source must be found')
    assert.ok(editFn, 'editMessage source must be found')

    // retry：派发后补触发（单参，占位标题为标题源）；无新文本，不做命令判断
    assert.match(retryFn, /triggerSessionRename\(chatState\.sessionKey\)/,
        'retryMessage must trigger the single-arg auto-rename after dispatching')
    assert.doesNotMatch(retryFn, /triggerSessionRename\([^)]*,/, 'retry must not pass a text argument')

    // edit：新文本是命令则跳过；非命令以单参触发
    assert.match(editFn, /!isCommandInvocation\(newText/,
        'editMessage must skip command invocations like handleSend does')
    assert.match(editFn, /triggerSessionRename\(chatState\.sessionKey\)/,
        'editMessage must trigger the single-arg auto-rename after dispatching')
    assert.doesNotMatch(editFn, /triggerSessionRename\([^)]*newText/,
        'edit must not pass the edited text as title source')
})
