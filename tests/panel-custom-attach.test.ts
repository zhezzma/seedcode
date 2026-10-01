/**
 * 行为级回归测试：展示类 custom 消息（面板/图片卡）并入前一条 assistant 气泡。
 *
 * 背景（2026-10-01 通道归位）：服务端面板改走 type:"custom" 条目，经 /messages
 * 白名单投影（type:'custom_message'）与 SSE custom_message 增量事件到达客户端；
 * 旧引擎/迁移历史为 role:'custom' 消息。此前两种形状都被渲染成独立 AI 气泡
 * （「两个连续 AI 回复」）。语义钉死：custom 展示消息 = 当前 AI 回复的内嵌
 * 展示附件——并入前一条 assistant 气泡（无条件，不受 assistantMsgMerge 开关
 * 控制，与工具卡同语义）；前面无 assistant 时兜底独立成 assistant 气泡。
 *
 * 驱动方式：esbuild 打包真实 useChatMessages（vue reactive state 直喂），
 * 断言 processedMessages 的气泡数量与 block 归属。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFile, rm, mkdir } from 'node:fs/promises'
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
        name: 'panel-attach-test-stubs',
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
    // Node 环境兜底（a2uiClient/useA2UISurfaces 引用 window/localStorage）
    ;(globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), addEventListener: () => {}, removeEventListener: () => {} }
    ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    ;(globalThis as any).document ??= { createElement: () => ({ style: {} }), addEventListener: () => {}, removeEventListener: () => {} }
    const dir = join(repoRoot, 'node_modules', '.tmp-panel-attach-test')
    await mkdir(dir, { recursive: true })
    // 每次构建唯一文件名：同 URL 的 ESM import 会命中模块缓存，串台上一用例的 bundle
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

const PANEL_A2UI = `<a2ui>\n{"version":"v1.0","createSurface":{"surfaceId":"surf-1","catalogId":"dev.seedcode/basic"}}\n{"version":"v1.0","updateComponents":{"surfaceId":"surf-1","components":[{"id":"root","component":"Column","children":["q1"]},{"id":"q1","component":"Text","text":"选哪个？"}]}}\n</a2ui>`

test('custom_message（/messages 新形状）并入前一条 assistant 气泡，不独立成第二条 AI 回复', async () => {
    const result = await runHarness(`
import { reactive } from 'vue'
import { useChatMessages } from '../../src/composables/useChatMessages'

export async function run() {
    const state = reactive({
        sessionKey: 's1',
        chatMessages: [
            { role: 'user', content: [{ type: 'text', text: '给我一个提问' }], timestamp: 1, entryId: 'e-u' },
            { role: 'assistant', content: [{ type: 'text', text: '好的，我来问你' }], timestamp: 2, entryId: 'e-a' },
            { type: 'custom_message', role: 'assistant', customType: 'question-render', content: ${JSON.stringify(PANEL_A2UI)}, timestamp: 3, entryId: 'e-panel' },
        ],
        chatStream: null,
    })
    const { processedMessages } = useChatMessages(state as any)
    const msgs = processedMessages.value
    return {
        count: msgs.length,
        roles: msgs.map((m: any) => m.role),
        lastBlocks: msgs[msgs.length - 1].blocks.map((b: any) => b.type),
        lastEntryId: msgs[msgs.length - 1].lastEntryId,
    }
}
`)
    assert.equal(result.count, 2, '应为 2 个气泡（用户 1 + AI 1），面板并入 AI 气泡')
    assert.deepEqual(result.roles, ['user', 'assistant'])
    assert.ok(result.lastBlocks.includes('text'), 'AI 气泡应保留原文本 block')
    assert.ok(result.lastBlocks.includes('a2ui'), '面板 a2ui block 应并入同一条 AI 气泡')
    assert.equal(result.lastEntryId, 'e-panel', '合并气泡的 lastEntryId 应跟随面板 entry')
})

test('旧形状 role:custom（迁移历史/live 追加）同样并入前一条 assistant 气泡', async () => {
    const result = await runHarness(`
import { reactive } from 'vue'
import { useChatMessages } from '../../src/composables/useChatMessages'

export async function run() {
    const state = reactive({
        sessionKey: 's1',
        chatMessages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1, entryId: 'e-u' },
            { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2, entryId: 'e-a' },
            { role: 'custom', customType: 'questionnaire-render', content: ${JSON.stringify(PANEL_A2UI)}, timestamp: 3, entryId: 'e-q' },
        ],
        chatStream: null,
    })
    const { processedMessages } = useChatMessages(state as any)
    const msgs = processedMessages.value
    return { count: msgs.length, lastBlocks: msgs[msgs.length - 1].blocks.map((b: any) => b.type) }
}
`)
    assert.equal(result.count, 2)
    assert.ok(result.lastBlocks.includes('a2ui'), '旧形状面板同样并入 AI 气泡')
})

test('前面无 assistant 气泡时兜底独立成 assistant 气泡（不丢面板）', async () => {
    const result = await runHarness(`
import { reactive } from 'vue'
import { useChatMessages } from '../../src/composables/useChatMessages'

export async function run() {
    const state = reactive({
        sessionKey: 's1',
        chatMessages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1, entryId: 'e-u' },
            { role: 'custom', customType: 'question-render', content: ${JSON.stringify(PANEL_A2UI)}, timestamp: 2, entryId: 'e-panel' },
        ],
        chatStream: null,
    })
    const { processedMessages } = useChatMessages(state as any)
    const msgs = processedMessages.value
    return { count: msgs.length, roles: msgs.map((m: any) => m.role), lastHasA2ui: msgs[msgs.length - 1].blocks.some((b: any) => b.type === 'a2ui') }
}
`)
    assert.equal(result.count, 2)
    assert.deepEqual(result.roles, ['user', 'assistant'])
    assert.ok(result.lastHasA2ui, '兜底气泡应渲染面板')
})

test('排队中的 /a2ui-event 面板提交渲染为动作 chip，不裸显 JSON 文本', async () => {
    const result = await runHarness(`
import { reactive } from 'vue'
import { useChatMessages } from '../../src/composables/useChatMessages'

export async function run() {
    const state = reactive({
        sessionKey: 's1',
        chatMessages: [
            { role: 'user', content: [{ type: 'text', text: '给我一个提问' }], timestamp: 1, entryId: 'e-u' },
            { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 2, entryId: 'e-a' },
        ],
        chatStream: null,
        pendingQueue: [{
            id: 'q1',
            text: '/a2ui-event {"version":"v1.0","action":{"name":"question.submit","surfaceId":"surf-1","context":{"value":"full_plan_b","label":"全修","customAnswer":""}}}',
            mode: 'followUp',
            timestamp: 3,
        }],
    })
    const { processedMessages } = useChatMessages(state as any)
    const msgs = processedMessages.value
    const last = msgs[msgs.length - 1]
    return {
        count: msgs.length,
        lastRole: last.role,
        lastPending: last.pending,
        blockTypes: last.blocks.map((b: any) => b.type),
        eventName: last.blocks[0]?.a2uiEventName,
    }
}
`)
    assert.equal(result.count, 3, '排队条目仍是尾部半透明 user 气泡')
    assert.equal(result.lastRole, 'user')
    assert.equal(result.lastPending, 'followUp')
    assert.deepEqual(result.blockTypes, ['a2ui-action'], '/a2ui-event 应转动作 chip，而非裸文本')
    assert.equal(result.eventName, 'question.submit')
})
