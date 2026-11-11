/**
 * 行为级回归测试：后台子代理 / 音乐状态条单例的「切会话清空」watch 不得随首个调用方组件卸载而失效。
 *
 * Bug（2026-11）：useBackgroundAgents / useMusicGen 懒构建，首个调用方是 HomeView 的 setup，
 * 构建期同步创建的 watch 挂到 HomeView 实例作用域。离开聊天页（设置/智能体等非聊天路由）或
 * 窗口跨 1024px 断点换布局都会卸载 HomeView → 作用域 stop 杀掉 watch，单例对象却留在模块里。
 * 之后左侧切到没有后台子代理/音乐的会话（服务端快照对空列表不发事件），状态条残留上个会话的
 * 条目，刷新才恢复。
 *
 * 真实 Vue 组件生命周期（createRenderer 挂载/卸载）+ 真实 composable；useChatState 换成只含
 * sessionKey 的 reactive 桩（两个单例只读这一个字段，真实模块依赖链过重且与本缺陷无关）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..')

const entry = `
export { useBackgroundAgents } from './src/composables/useBackgroundAgents.ts'
export { useMusicGen } from './src/composables/useMusicGen.ts'
export { emitExtensionEvent } from './src/composables/extension-events.ts'
export { useChatState } from './src/composables/useChatState'
`

const STUBS: Record<string, string> = {
    'chat-state': `import { reactive } from 'vue'
const state = reactive({ sessionKey: '' })
export function useChatState() { return state }`,
    'api-client': 'export const apiPost = async () => ({})',
}

async function loadComposables(): Promise<any> {
    const result = await build({
        stdin: { contents: entry, resolveDir: repoRoot, sourcefile: 'dock-bars-entry.ts', loader: 'ts' },
        bundle: true,
        format: 'esm',
        platform: 'node',
        // 与测试文件共用同一份 Vue 运行时（同一 reactivity 实例）
        external: ['vue'],
        write: false,
        plugins: [{
            name: 'dock-bars-stubs',
            setup(b) {
                b.onResolve({ filter: /\/useChatState$/ }, () => ({ path: 'chat-state', namespace: 'stub' }))
                b.onResolve({ filter: /\/api-client$/ }, () => ({ path: 'api-client', namespace: 'stub' }))
                b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'ts', resolveDir: repoRoot }))
            },
        }],
    })
    // 产物落在 tests/ 下：bare import 'vue' 从这里解析到仓库 node_modules
    const outfile = join(testDir, '.dock-bars-survive-unmount.bundle.mjs')
    await writeFile(outfile, result.outputFiles[0].text)
    try {
        return await import(pathToFileURL(outfile).href)
    } finally {
        await rm(outfile, { force: true })
    }
}

// 最小渲染宿主：只为驱动真实组件 setup/unmount（unmount → instance.scope.stop()）
type HostNode = { children: HostNode[]; parent: HostNode | null }
const hostNode = (): HostNode => ({ children: [], parent: null })
const { createApp } = createRenderer<HostNode, HostNode>({
    createElement: hostNode,
    createText: hostNode,
    createComment: hostNode,
    setText() {},
    setElementText() {},
    patchProp() {},
    insert(child, parent, anchor) {
        if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
        const at = anchor ? parent.children.indexOf(anchor) : -1
        parent.children.splice(at < 0 ? parent.children.length : at, 0, child)
        child.parent = parent
    },
    remove(child) {
        if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
        child.parent = null
    },
    parentNode: (n) => n.parent,
    nextSibling: (n) => (n.parent ? n.parent.children[n.parent.children.indexOf(n) + 1] ?? null : null),
})

test('首个调用方组件卸载后切到无数据的会话：后台子代理/音乐状态条必须清空，不得残留上个会话', async () => {
    const mod = await loadComposables()
    const chat = mod.useChatState()
    chat.sessionKey = 'A'

    // 首个调用方 = 某组件 setup（真实应用里是 HomeView）；show 切换模拟离开聊天页再回来
    const show = ref(true)
    const ChatPage = defineComponent({
        setup() {
            mod.useBackgroundAgents()
            mod.useMusicGen()
            return () => null
        },
    })
    const app = createApp({ render: () => (show.value ? h(ChatPage) : null) })
    app.mount(hostNode())

    const bg = mod.useBackgroundAgents()
    const music = mod.useMusicGen()
    mod.emitExtensionEvent('ext.subagent_state', {
        agents: [{ name: 'w-alpha', subagentId: 'sub1', conversationId: 'c-alpha', status: 'working', lastActivityAt: 1 }],
    }, 'A')
    mod.emitExtensionEvent('ext.music_state', {
        musics: [{ taskId: 'm-alpha', caption: 'A 的曲子', provider: 'stepmusic', status: 'working', lastActivityAt: 1 }],
    }, 'A')
    assert.equal(bg.barVisible.value, true, '前置：A 会话后台子代理条可见')
    assert.equal(music.barVisible.value, true, '前置：A 会话音乐条可见')

    // 离开聊天页（首个调用方卸载）→ 回到聊天页（新实例复用同一单例）
    show.value = false
    await nextTick()
    show.value = true
    await nextTick()

    // 左侧切到 B：B 无后台子代理/音乐，服务端快照不发事件，只能靠切会话 watch 清空
    chat.sessionKey = 'B'
    await nextTick()

    // 两条 bar 合并断言：失败时一次 diff 同时看到两边残留
    assert.deepEqual({
        agents: bg.agents.value.map((a: any) => a.name),
        bgBarVisible: bg.barVisible.value,
        musics: music.musics.value.map((m: any) => m.taskId),
        musicBarVisible: music.barVisible.value,
    }, {
        agents: [],
        bgBarVisible: false,
        musics: [],
        musicBarVisible: false,
    }, 'B 会话不得残留 A 的后台子代理/音乐任务')

    app.unmount()
})
