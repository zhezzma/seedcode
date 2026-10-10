/**
 * 行为级回归测试：自动重命名只触发一次（titleSet 本地同步）。
 *
 * 背景：HomeView 发消息时的自动命名守卫是 `!currentSession?.titleSet`（title
 * 永不为空——首条消息即占位，旧守卫 `!name` 恒真已退役）。守卫读的是本地行，
 * 而本地行的 titleSet 只有 loadSessions 全量刷新才会带下来——
 * triggerSessionRename 成功回执与 patchSession（手动 /name）成功后都只回写
 * name、不置位 titleSet。结果：每条消息的守卫都通过 → 每条消息都触发一次
 * AI 重命名（标题被反复覆盖，含覆盖用户手动名）。
 *
 * 本测试把真实 useSessionsState 用 esbuild 打包进 Node 可执行 bundle（stub 掉
 * tauri/i18n），驱动四类场景断言：
 *   A. triggerSessionRename 成功 → 本地行 titleSet 置 true（守卫就此闭合）；
 *   B. rename 在途（标题 LLM 耗时数秒）时并发双触发 → 只发一次 POST（乐观
 *      置位必须在首次 await 前同步完成，才能关住守卫读窗口）；
 *   C. rename 失败 → titleSet 回滚 false，下一条消息可重试（不卡死）；
 *   D. patchSession（手动 /name）成功 → titleSet 置 true，否则下条消息的
 *      自动命名会覆盖用户手动名。
 * 源码结构钉只能钉"写了哪些行"，钉不住"写进了哪份状态、守卫窗口是否闭合"
 * ——只有行为测试能守住该 bug 类（同 session-row-identity-behavior.test.ts）。
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

const RENAME_DELAY_MS = Number(process.env.HARNESS_RENAME_DELAY_MS || 0)
const RENAME_FAIL = process.env.HARNESS_RENAME_FAIL === '1'
const calls = []
;(globalThis as any).fetch = async (url, init) => {
    const u = new URL(url)
    calls.push((init?.method || 'GET') + ' ' + u.pathname)
    const body = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
    // 冷启动列表：三个会话均为 titleSet=false（新会话语义——仅占位标题）
    if (u.pathname === '/api/sessions') return body({ ok: true, payload: { sessions: [
        { id: 'S1', name: '第一条消息占位', titleSet: false },
        { id: 'S2', name: '第二条消息占位', titleSet: false },
        { id: 'S3', name: '第三条消息占位', titleSet: false },
    ] } })
    // generate-title：标题 LLM 调用（HARNESS_RENAME_DELAY_MS 模拟耗时，RENAME_FAIL 模拟失败）
    if (u.pathname === '/api/sessions/S1/generate-title' || u.pathname === '/api/sessions/S2/generate-title') {
        if (RENAME_FAIL) return body({ ok: false, error: 'AI returned invalid title' }, 500)
        const payload = { sessionId: u.pathname.split('/')[3], name: 'AI标题' }
        if (!RENAME_DELAY_MS) return body({ ok: true, payload })
        return new Promise((resolve) => setTimeout(() => resolve(body({ ok: true, payload })), RENAME_DELAY_MS))
    }
    if (u.pathname === '/api/sessions/S3/name') return body({ ok: true, payload: { message: 'Session renamed' } })
    return body({ ok: true, payload: {} })
}

const { useSessionsState } = await import('${srcPath('src/composables/useSessionsState.ts')}')
const { useUiSettingsStore } = await import('${srcPath('src/stores/setting.ts')}')
;(useUiSettingsStore() as any).apiBaseUrl = 'http://mock-api'

const sessions = useSessionsState() as any
await sessions.loadSessions()

// 场景C（RENAME_FAIL=1）：失败回滚 + 失败后下一条消息重试仍发出
if (RENAME_FAIL) {
    await sessions.triggerSessionRename('S1', '消息一')
    await sessions.triggerSessionRename('S1', '消息二')
    console.log('C posts=' + calls.filter((c) => c.includes('/generate-title')).length + ' titleSet=' + sessions.findSessionLocal('S1')?.titleSet)
} else {
    // 场景A：成功回执置位——守卫就此闭合，后续消息不再触发自动命名
    await sessions.triggerSessionRename('S1', '第一条消息')
    console.log('A titleSet=' + sessions.findSessionLocal('S1')?.titleSet + ' name=' + sessions.findSessionLocal('S1')?.name)

    // 场景B：rename 在途（HARNESS_RENAME_DELAY_MS 延迟返回）时并发双触发（用户连发两条消息）——只发一次 POST
    const postsBeforeB = calls.filter((c) => c.includes('/generate-title')).length
    await Promise.all([
        sessions.triggerSessionRename('S2', '消息一'),
        sessions.triggerSessionRename('S2', '消息二'),
    ])
    console.log('B posts=' + (calls.filter((c) => c.includes('/generate-title')).length - postsBeforeB) + ' titleSet=' + sessions.findSessionLocal('S2')?.titleSet)

    // 场景D：手动重命名（/name）成功后 titleSet 置位——否则下条消息的自动命名覆盖手动名
    await sessions.patchSession('S3', { label: '手动名' })
    console.log('D titleSet=' + sessions.findSessionLocal('S3')?.titleSet + ' name=' + sessions.findSessionLocal('S3')?.name)
}
`

async function runHarness(outDir: string, env: Record<string, string>): Promise<string> {
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

test('triggerSessionRename sets titleSet on success so the auto-rename guard closes (behavior)', async () => {
    const outDir = join(repoRoot, 'node_modules/.cache/seedcode-rename-harness')
    try {
        const out = await runHarness(outDir, { HARNESS_RENAME_DELAY_MS: '60' })

        // A：成功回执必须置位 titleSet（否则每条消息都重新触发自动命名）
        assert.match(out, /A titleSet=true name=AI标题/, 'a successful AI rename must mark the local row titleSet=true')
        // B：rename 在途时的并发双触发只允许发一次 POST（乐观置位必须先于 await 完成）
        assert.match(out, /B posts=1 titleSet=true/, 'a concurrent second message while the rename is in flight must not fire a second generate-title')
        // D：手动 /name 成功后必须置位 titleSet（否则自动命名会覆盖用户手动名）
        assert.match(out, /D titleSet=true name=手动名/, 'a successful manual rename must also mark titleSet=true')
    } finally {
        await rm(outDir, { recursive: true, force: true })
    }
})

test('failed rename rolls titleSet back so the next message can retry (behavior)', async () => {
    const outDir = join(repoRoot, 'node_modules/.cache/seedcode-rename-harness-fail')
    try {
        const out = await runHarness(outDir, { HARNESS_RENAME_FAIL: '1' })
        // C：失败后 titleSet 回滚 false，第二次触发仍发出（重试不被卡死）
        assert.match(out, /C posts=2 titleSet=false/, 'a failed rename must roll back titleSet so the next message retries')
    } finally {
        await rm(outDir, { recursive: true, force: true })
    }
})
