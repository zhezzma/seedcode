/**
 * 行为级回归测试：自动命名标题源 = 占位标题（会话第一条消息直取）。
 *
 * 背景：HomeView 发消息时曾把「触发命名的那条消息」传给 generate-title——守卫
 * !titleSet 下通常是首条，但首次命名失败回滚重试 / 命令首条延迟触发等场景下，
 * 传入的是后续消息，标题不再描述会话的起点。修复：titleSet=false 时占位标题
 * name 本身就是会话第一条消息（创建时由 firstMessage 播种 / run_end 按首条
 * user 消息派生），triggerSessionRename 直取 target.name 传给服务器，不扫转录。
 *
 * 本测试把真实 useSessionsState 用 esbuild 打包进 Node 可执行 bundle（stub 掉
 * tauri/i18n），断言三类场景：
 *   A. 单参触发 → POST body 的 text = 行上的占位标题（首条消息），不是调用方
 *      传入的任何文本（该参数已删）；
 *   B. 无占位（name 空，无可传的首条消息）→ 不触发不置位（等 run_end 回填后
 *      下条消息可再触发）；
 *   C. 失败回滚后重试 → 仍用占位标题。
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
    return body({ ok: true, payload: {} })
}

const { useSessionsState } = await import('${srcPath('src/composables/useSessionsState.ts')}')
const { useUiSettingsStore } = await import('${srcPath('src/stores/setting.ts')}')
;(useUiSettingsStore() as any).apiBaseUrl = 'http://mock-api'

const sessions = useSessionsState() as any
await sessions.loadSessions()

// 场景A：单参触发 → POST body 的 text = 占位标题（会话第一条消息直取）
await sessions.triggerSessionRename('S1')
const postA = calls.find((c) => c.includes('/generate-title')) || ''
console.log('A ' + postA + ' titleSet=' + sessions.findSessionLocal('S1')?.titleSet + ' name=' + sessions.findSessionLocal('S1')?.name)

// 场景B：无占位（name 空）→ 不触发不置位
await sessions.triggerSessionRename('S2')
const postsB = calls.filter((c) => c.includes('/generate-title')).length
console.log('B posts=' + (postsB - 1) + ' titleSet=' + sessions.findSessionLocal('S2')?.titleSet)

// 场景C（RENAME_FAIL=1）：失败回滚 → 重试仍用占位标题
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

test('triggerSessionRename posts the placeholder title (session first message), not a caller-passed text (behavior)', async () => {
    const outDir = join(repoRoot, 'node_modules/.cache/seedcode-rename-placeholder-harness')
    try {
        const out = await runHarness(outDir)

        // A：POST body 的 text 必须是行上的占位标题（会话第一条消息直取，无调用方文本）
        assert.match(out, /A POST \/api\/sessions\/S1\/generate-title \{"text":"第一条消息占位"\}/,
            'the generate-title POST must carry the placeholder title (the session first message)')
        assert.match(out, /A .* titleSet=true name=AI标题/, 'a successful AI rename must mark the local row titleSet=true')
        // B：无占位（无可传的首条消息）不触发、不置位
        assert.match(out, /B posts=0 titleSet=false/, 'a session without a placeholder must not fire generate-title')
    } finally {
        await rm(outDir, { recursive: true, force: true })
    }
})

test('failed rename rolls titleSet back and the retry still posts the placeholder title (behavior)', async () => {
    const outDir = join(repoRoot, 'node_modules/.cache/seedcode-rename-placeholder-fail')
    try {
        const out = await runHarness(outDir, { HARNESS_RENAME_FAIL: '1' })
        // C：失败回滚后重试仍发占位标题（重试不被卡死，标题源不漂移）
        assert.match(out, /C posts=2 texts=\{"text":"第三条消息占位"\}\|\{"text":"第三条消息占位"\}/,
            'the retry after a failed rename must still carry the placeholder title')
    } finally {
        await rm(outDir, { recursive: true, force: true })
    }
})

test('HomeView wires the auto-rename call without a text argument', async () => {
    const home = await readFile(srcPath('src/views/HomeView.vue'), 'utf8')
    // 单参调用：标题源在 triggerSessionRename 内直取占位标题
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
