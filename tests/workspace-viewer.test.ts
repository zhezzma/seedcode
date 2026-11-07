import test from 'node:test'
import assert from 'node:assert/strict'
import { useWorkspaceViewer } from '../src/composables/useWorkspaceViewer.ts'

test.beforeEach(() => {
    useWorkspaceViewer().close()
})

test('默认无 current', () => {
    const v = useWorkspaceViewer()
    assert.equal(v.current.value, null)
    assert.equal(v.isActive.value, false)
})

test('openFile 设置 current.type=file', () => {
    const v = useWorkspaceViewer()
    v.openFile('/abs/path/file.ts')
    assert.deepEqual(v.current.value, { type: 'file', path: '/abs/path/file.ts' })
    assert.equal(v.isActive.value, true)
})

test('openDiff 设置 current.type=diff', () => {
    const v = useWorkspaceViewer()
    v.openDiff({ repo: 'r', mode: 'unstaged', file: 'a.ts' })
    assert.deepEqual(v.current.value, { type: 'diff', repo: 'r', mode: 'unstaged', file: 'a.ts', ref: undefined })
})

test('openDiff 二进制文件改开文件预览（repo 前缀拼 workspace 相对路径）', () => {
    const v = useWorkspaceViewer()
    v.openDiff({ repo: 'sub', mode: 'unstaged', file: 'assets/logo.png' })
    assert.deepEqual(v.current.value, { type: 'file', path: 'sub/assets/logo.png' })
})

test('openDiff 根仓库（"."）二进制：路径不带 "./" 前缀（repoJoin 同语义）', () => {
    const v = useWorkspaceViewer()
    v.openDiff({ repo: '.', mode: 'commit', ref: 'abc1234', file: 'docs/manual.pdf' })
    assert.deepEqual(v.current.value, { type: 'file', path: 'docs/manual.pdf' })
})

test('openDiff 二进制删除态：维持 diff（文件已不在盘上，预览必 404，diff 可见删除事实）', () => {
    const v = useWorkspaceViewer()
    v.openDiff({ repo: 'sub', mode: 'unstaged', file: 'old-bundle.zip', deleted: true })
    assert.equal(v.current.value?.type, 'diff')
})

test('openDiff 非媒体二进制（pdf/keystore/sqlite…）同样改开预览，不止图/音/视', () => {
    const v = useWorkspaceViewer()
    for (const file of ['spec.pdf', 'release.keystore', 'cache.sqlite', 'model.glb']) {
        v.openDiff({ repo: 'r', mode: 'staged', file })
        assert.deepEqual(v.current.value, { type: 'file', path: `r/${file}` })
    }
})

test('openDiff 文本文件照常 diff（含无扩展名/文本格式排除项 svg/gltf）', () => {
    const v = useWorkspaceViewer()
    for (const file of ['a.ts', 'v.vue', 'icon.svg', 'scene.gltf', 'Makefile']) {
        v.openDiff({ repo: 'r', mode: 'unstaged', file })
        assert.equal(v.current.value?.type, 'diff')
    }
})

test('openAgentFile 设置 current.type=agent-file', () => {
    const v = useWorkspaceViewer()
    v.openAgentFile('AGENTS.md')
    assert.deepEqual(v.current.value, { type: 'agent-file', path: 'AGENTS.md' })
    assert.equal(v.isActive.value, true)
})

test('openAbsolute 设置 current.type=absolute', () => {
    const v = useWorkspaceViewer()
    v.openAbsolute('/abs/path/file.ts')
    assert.deepEqual(v.current.value, { type: 'absolute', path: '/abs/path/file.ts' })
    assert.equal(v.isActive.value, true)
})

test('openText 设置 current.type=text', () => {
    const v = useWorkspaceViewer()
    v.openText('hello world', 'Preview')
    assert.deepEqual(v.current.value, { type: 'text', content: 'hello world', title: 'Preview' })
    assert.equal(v.isActive.value, true)
})

test('openText 透传 language 到 target（代码块全屏按语言高亮）', () => {
    const v = useWorkspaceViewer()
    v.openText('print(1)', 'Preview', 'python')
    assert.deepEqual(v.current.value, { type: 'text', content: 'print(1)', title: 'Preview', language: 'python' })
    assert.equal(v.isActive.value, true)
})

test('openText 不传 language 时 target 不携带 language 字段（保持向后兼容）', () => {
    const v = useWorkspaceViewer()
    v.openText('x')
    assert.deepEqual(v.current.value, { type: 'text', content: 'x', title: undefined })
})

test('close 清空', () => {
    const v = useWorkspaceViewer()
    v.openFile('/a')
    v.close()
    assert.equal(v.current.value, null)
})

test('viewer.close() 不再触发 git status 重拉（spec: 仅保存/mutation 才刷新）', async () => {
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    ;(git as any).statusRepo = 'repoX'
    ;(git as any).statusData = { branch: 'main', upstream: null, head: 'h', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] }

    const v = useWorkspaceViewer()
    v.openFile('/x')
    v.close()

    // 新契约：close 不动 git store。刷新由 WorkspaceFileView.save / stage / unstage / discard / commit 负责。
    assert.equal(git.statusRepo, 'repoX')
    assert.notEqual(git.status.value, null)
})

test('setDirty/dirty: 默认 null，setDirty 写入后可读、close 会清除', () => {
    const v = useWorkspaceViewer()
    assert.equal(v.dirty.value, null)
    v.setDirty('src/a.ts')
    assert.deepEqual(v.dirty.value, { path: 'src/a.ts' })
    v.openFile('src/a.ts')
    // 打开后 dirty 不变，仅 close() 才会重置
    assert.deepEqual(v.dirty.value, { path: 'src/a.ts' })
    v.close()
    assert.equal(v.dirty.value, null)
})

test('setDirty(null) 是明确重置', () => {
    const v = useWorkspaceViewer()
    v.setDirty('a')
    v.setDirty(null)
    assert.equal(v.dirty.value, null)
})
