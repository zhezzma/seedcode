/**
 * 行为级回归测试：deliverables 面板并入前一条 assistant 气泡（本轮产出物）。
 *
 * 语义钉死：deliverables 是该条 AI 回复的内嵌附件（面板附件语义，同
 * a2ui/question-render）——并入前一条 assistant 气泡，不独立成「第二条 AI
 * 回复」。结构化载荷 {files, summary} 预构造为 deliverables 块，不经
 * convertToBlocks 文本链（对象载荷会渲染成空/JSON 噪声）；脏载荷静默跳过。
 *
 * 驱动方式：esbuild 打包真实 useChatMessages（vue reactive state 直喂），
 * 断言 processedMessages 的气泡数量与 block 归属（同 panel-custom-attach 模式；
 * DeliverablesPanel 为 type-only import，esbuild 打包时消隐无需 stub）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFile, rm, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..')

const STUBS: Record<string, string> = {
    i18n: 'export const i18n = { global: { t: (k: string) => k, te: () => true, locale: { value: "zh" } }, t: (k: string) => k }; export default i18n;',
    pinia: `
import { reactive } from 'vue'
const stores: Record<string, any> = {}
export function defineStore(id: string, setup: any) {
    return () => stores[id] ?? (stores[id] = setup())
}
export function createPinia() { return {} }
export function setActivePinia(_p: any) {}
`,
    'setting-store': 'export const useUiSettingsStore = () => ({ assistantMsgMerge: true })',
}

function stubPlugin() {
    return {
        name: 'deliverables-attach-test-stubs',
        setup(b: any) {
            b.onResolve({ filter: /\/i18n$/ }, (a: any) => ({ path: 'i18n', namespace: 'stub' }))
            b.onResolve({ filter: /^pinia$/ }, (a: any) => ({ path: 'pinia', namespace: 'stub' }))
            b.onResolve({ filter: /stores\/setting$/ }, (a: any) => ({ path: 'setting-store', namespace: 'stub' }))
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args: any) => ({
                contents: STUBS[args.path],
                loader: 'ts',
                resolveDir: testDir,
            }))
        },
    }
}

let runHarnessBuildSeq = 0
async function runHarness(entry: string): Promise<any> {
    ;(globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), addEventListener: () => {}, removeEventListener: () => {} }
    ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    ;(globalThis as any).document ??= { createElement: () => ({ style: {} }), addEventListener: () => {}, removeEventListener: () => {} }
    const dir = join(repoRoot, 'node_modules', '.tmp-deliverables-test')
    await mkdir(dir, { recursive: true })
    const seq = ++runHarnessBuildSeq
    const infile = join(dir, `harness-${seq}.ts`)
    const outfile = join(dir, `harness-${seq}.mjs`)
    await writeFile(infile, entry, 'utf8')
    await build({
        entryPoints: [infile],
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile,
        plugins: [stubPlugin()],
        logLevel: 'silent',
        external: ['vue'],
    })
    const mod = await import(`file://${outfile.replace(/\\/g, '/')}`)
    return mod.run()
}

test('deliverables custom_message（/messages 新形状）并入前一条 AI 气泡，不独立成第二条 AI 回复', async () => {
    const payload = {
        files: [
            { path: 'src/a.ts', abs: 'D:/ws/proj/src/a.ts', repo: '.', change: 'created', status: '??', mode: 'untracked', ref: null, via: 'tool-input', tool: 'write' },
            { path: 'src/b.ts', abs: 'D:/ws/proj/src/b.ts', repo: '.', change: 'modified', status: ' M', mode: 'unstaged', ref: null, via: 'tool-input', tool: 'edit' },
        ],
        summary: { created: 1, modified: 1, renamed: 0, deleted: 0 },
    }
    const result = await runHarness(`
import { reactive } from 'vue'
import { useChatMessages } from '../../src/composables/useChatMessages'

export async function run() {
    const state = reactive({
        sessionKey: 's1',
        chatMessages: [
            { role: 'user', content: [{ type: 'text', text: '改点东西' }], timestamp: 1, entryId: 'e-u' },
            { role: 'assistant', content: [{ type: 'text', text: '已完成' }], timestamp: 2, entryId: 'e-a' },
            { type: 'custom_message', role: 'assistant', customType: 'deliverables', content: ${JSON.stringify(payload)}, timestamp: 3, entryId: 'e-dlv' },
        ],
        chatStream: null,
    })
    const { processedMessages } = useChatMessages(state as any)
    const msgs = processedMessages.value
    const last = msgs[msgs.length - 1]
    return {
        count: msgs.length,
        roles: msgs.map((m: any) => m.role),
        lastBlocks: last.blocks.map((b: any) => b.type),
        lastEntryId: last.lastEntryId,
        files: last.blocks.find((b: any) => b.type === 'deliverables')?.deliverableFiles?.length,
        summary: last.blocks.find((b: any) => b.type === 'deliverables')?.deliverableSummary,
    }
}
`)
    assert.equal(result.count, 2, '应为 2 个气泡（用户 1 + AI 1），产出物面板并入 AI 气泡')
    assert.deepEqual(result.roles, ['user', 'assistant'])
    assert.deepEqual(result.lastBlocks, ['text', 'deliverables'], 'AI 气泡保留原文本 + 产出物格子在后')
    assert.equal(result.lastEntryId, 'e-dlv', '合并气泡 lastEntryId 跟随面板 entry')
    assert.equal(result.files, 2, 'files 载荷完整透传')
    assert.deepEqual(result.summary, { created: 1, modified: 1, renamed: 0, deleted: 0 })
})

test('旧形状 role:custom（live 追加/迁移历史）同样并入 AI 气泡', async () => {
    const payload = {
        files: [
            { path: 'src/gone.ts', abs: 'D:/ws/proj/src/gone.ts', repo: '.', change: 'deleted', status: ' D', mode: 'unstaged', ref: null, via: 'script', tool: null },
        ],
        summary: { created: 0, modified: 0, renamed: 0, deleted: 1 },
    }
    const result = await runHarness(`
import { reactive } from 'vue'
import { useChatMessages } from '../../src/composables/useChatMessages'

export async function run() {
    const state = reactive({
        sessionKey: 's1',
        chatMessages: [
            { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 2, entryId: 'e-a' },
            { role: 'custom', customType: 'deliverables', content: ${JSON.stringify(payload)}, timestamp: 3, entryId: 'e-dlv' },
        ],
        chatStream: null,
    })
    const { processedMessages } = useChatMessages(state as any)
    const msgs = processedMessages.value
    const blocks = msgs[msgs.length - 1].blocks
    return { count: msgs.length, blockTypes: blocks.map((b: any) => b.type), change: blocks.find((b: any) => b.type === 'deliverables')?.deliverableFiles?.[0]?.change }
}
`)
    assert.equal(result.count, 1, '并入后只有一条 AI 气泡')
    assert.deepEqual(result.blockTypes, ['text', 'deliverables'])
    assert.equal(result.change, 'deleted')
})

test('前面无 assistant 气泡时兜底独立成 assistant 气泡（不丢面板）', async () => {
    const payload = {
        files: [
            { path: 'x.ts', abs: 'D:/ws/proj/x.ts', repo: '.', change: 'created', status: null, mode: null, ref: null, via: 'tool-input', tool: 'write' },
        ],
        summary: { created: 1, modified: 0, renamed: 0, deleted: 0 },
    }
    const result = await runHarness(`
import { reactive } from 'vue'
import { useChatMessages } from '../../src/composables/useChatMessages'

export async function run() {
    const state = reactive({
        sessionKey: 's3',
        chatMessages: [
            { type: 'custom_message', role: 'assistant', customType: 'deliverables', content: ${JSON.stringify(payload)}, timestamp: 3, entryId: 'e-dlv' },
        ],
        chatStream: null,
    })
    const { processedMessages } = useChatMessages(state as any)
    const msgs = processedMessages.value
    return { count: msgs.length, blockTypes: msgs[0].blocks.map((b: any) => b.type) }
}
`)
    assert.equal(result.count, 1)
    assert.deepEqual(result.blockTypes, ['deliverables'])
})

test('脏载荷（无 files / 空数组）静默跳过，不产生气泡也不报错', async () => {
    const result = await runHarness(`
import { reactive } from 'vue'
import { useChatMessages } from '../../src/composables/useChatMessages'

export async function run() {
    const state = reactive({
        sessionKey: 's2',
        chatMessages: [
            { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 2, entryId: 'e-a' },
            { role: 'custom', customType: 'deliverables', content: { files: [] }, timestamp: 3, entryId: 'e-1' },
            { role: 'custom', customType: 'deliverables', content: null, timestamp: 4, entryId: 'e-2' },
            { role: 'custom', customType: 'deliverables', content: { summary: {} }, timestamp: 5, entryId: 'e-3' },
        ],
        chatStream: null,
    })
    const { processedMessages } = useChatMessages(state as any)
    const msgs = processedMessages.value
    return { count: msgs.length, blockTypes: msgs[0].blocks.map((b: any) => b.type) }
}
`)
    assert.equal(result.count, 1, '只有原 AI 气泡；deliverables 空载荷不渲染任何附件')
    assert.deepEqual(result.blockTypes, ['text'])
})

test('排队消息的用户回显插在中间，面板仍归入上一轮 AI 气泡（不被分割成独立泡）', async () => {
    const payload = {
        files: [
            { path: 'src/a.ts', abs: 'D:/ws/proj/src/a.ts', repo: '.', change: 'created', status: '??', mode: 'untracked', ref: null, via: 'tool-input', tool: 'write' },
        ],
        summary: { created: 1, modified: 0, renamed: 0, deleted: 0 },
    }
    const result = await runHarness(`
import { reactive } from 'vue'
import { useChatMessages } from '../../src/composables/useChatMessages'

export async function run() {
    const state = reactive({
        sessionKey: 's4',
        chatMessages: [
            { role: 'user', content: [{ type: 'text', text: '改点东西' }], timestamp: 1, entryId: 'e-u1' },
            { role: 'assistant', content: [{ type: 'text', text: '已完成' }], timestamp: 2, entryId: 'e-a1' },
            // followUp 排队消息的回显：run 在 endRun 同 commit 启动，回显先于面板到达
            { role: 'user', content: [{ type: 'text', text: '接着干这个' }], timestamp: 3, entryId: 'e-u2' },
            { type: 'custom_message', role: 'assistant', customType: 'deliverables', content: ${JSON.stringify(payload)}, timestamp: 4, entryId: 'e-dlv' },
        ],
        chatStream: null,
    })
    const { processedMessages } = useChatMessages(state as any)
    const msgs = processedMessages.value
    const ai = msgs.find((m: any) => m.blocks.some((b: any) => b.type === 'deliverables'))
    return {
        count: msgs.length,
        roles: msgs.map((m: any) => m.role),
        aiBlocks: ai?.blocks.map((b: any) => b.type),
        aiText: ai?.blocks.find((b: any) => b.type === 'text')?.text,
    }
}
`)
    assert.deepEqual(result.roles, ['user', 'assistant', 'user'], '3 个气泡：面板并入上一轮 AI，不独立、不串到新回显之后')
    assert.deepEqual(result.aiBlocks, ['text', 'deliverables'], '面板接在所属回复的文本之后')
    assert.equal(result.aiText, '已完成')
})

// ── 清理构建产物 ──
test.after?.(async () => {
    await rm(join(repoRoot, 'node_modules', '.tmp-deliverables-test'), { recursive: true, force: true })
})

// ==================== done 分支迟到回执防抹守卫（源码结构断言） ====================
//
// 服务端现已 done 前排空 run_end 收尾工作（run-end-work 契约，回执先于 done
// 接序送达）；但排空超时放行/乱序边界下仍可能出现「回执已 SSE 追加、而本快照
// 取于其落库之前」——done 分支的全量刷新整体替换会把它抹掉。守卫：替换前保留
// 尾部未被快照覆盖的 custom 消息（按 entryId 判重）。useChatState 为模块级单例
// （依赖 Vue/router），沿用 attach-idle-done-refresh.test.ts 的源码结构断言模式。

test('done 分支的全量刷新带迟到回执防抹守卫（按 entryId 保留尾部 custom 消息）', () => {
    const source = readFileSync(join(repoRoot, 'src/composables/useChatState.ts'), 'utf8')
    const start = source.indexOf('迟到回执防抹守卫')
    assert.ok(start >= 0, '防抹守卫注释缺失：done 分支替换 chatMessages 时应保留尾部 custom 回执')
    const guard = source.slice(start, source.indexOf('服务端已持久化全部', start))
    assert.ok(guard.includes("role === 'custom'"), '守卫应只保留 custom 角色')
    assert.ok(guard.includes('fetchedIds.has'), '守卫应按 entryId 与快照判重（落库后的快照不重复追加）')
    assert.ok(guard.includes('[...result.messages, ...lateReceipts]'), '守卫应把尾部回执追加在快照之后')
})
