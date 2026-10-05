// tests/workspace-diff-editor-edit.test.ts
// WorkspaceDiffEditor 未暂存 diff 可编辑（VSCode 风格）的 wiring 结构断言。
// monaco 组件无法在 node --test 下实例化 → 源码断言（与 workspace-component-source.test.ts
// 同模式）；门控纯逻辑的行为单测在 git-save-refresh.test.ts。
//
// 契约：
// - 仅 mode=unstaged/untracked（右侧是工作区文件）且非 binary/truncated 时可编辑；
//   staged/commit 右侧是 index/commit 内容，保持只读。
// - original 侧永远只读；modified 侧可打字，diff 高亮实时更新（monaco 原生）。
// - truncated 强制只读（写入截断内容 = 丢数据，与 WorkspaceFileView 同安全约束）。
// - save → saveFile 写回工作区文件 → 三联快照防过期 → 归属守门后 notifyGitFileSaved。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const read = (p: string) => readFileSync(path.join(repoRoot, p), 'utf8')

test('DiffEditor: 可编辑门控 = unstaged/untracked + 非 binary + 非 truncated', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    // unstaged（工作区 vs index/HEAD）与 untracked（工作区新文件）的右侧都是工作区文件
    assert.match(src, /props\.mode === 'unstaged'[\s\S]*?props\.mode === 'untracked'/,
        'editable must cover unstaged AND untracked modes only')
    // staged / commit 不得出现在 editable 判定里（右侧不是工作区文件）
    assert.doesNotMatch(src, /editable[\s\S]{0,200}(mode === 'staged'|mode === 'commit')/,
        'staged/commit must stay read-only (right side is not the worktree file)')
    // truncated 内容写入 = 丢数据：可编辑门控必须排除 truncated
    assert.match(src, /editable[\s\S]{0,300}truncated/,
        'editable must exclude truncated files')
})

test('DiffEditor: readOnly 随 editable 切换，original 侧恒只读', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    assert.doesNotMatch(src, /readOnly: true,/,
        'hard-coded readOnly: true must go (gated by editable instead)')
    assert.match(src, /readOnly: !editable/, 'readOnly must be gated by editable')
    assert.match(src, /originalEditable: false/, 'original side must stay read-only')
})

test('DiffEditor: dirty 追踪（modified 侧 vs load 时的 after baseline）', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    // model 级监听（onDidChangeContent，随 load 重建 attach、随 model dispose 失效）
    assert.match(src, /modifiedModel\.onDidChangeContent\(/, 'must track modified model changes')
    assert.match(src, /baselineAfter/, 'must keep an after-baseline for dirty compare')
})

test('DiffEditor: save 写回工作区文件（saveFile，workspace 相对路径）+ 快照防过期写入', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    assert.match(src, /import[\s\S]*?saveFile[\s\S]*?from '.*workspace-api'/,
        'must import saveFile from workspace-api')
    // props.file 是 repo 内相对路径；saveFile 要 workspace 相对路径 ——
    // 嵌套仓库必须拼 repo 前缀（dirtyPath 即该拼法），否则根仓库以外的保存全部落错
    assert.match(src, /await saveFile\(agentAtStart, wsPathAtStart/, 'save must write via saveFile with workspace-relative path')
    assert.match(src, /dirtyPath[\s\S]{0,80}props\.repo[\s\S]{0,80}props\.file/,
        'workspace path must join repo prefix + file')
    // save 网络往返期间可能切文件/agent：落地前必须校验 props 未变才更新 baseline
    assert.match(src, /agentAtStart === props\.agentId[\s\S]*?wsPathAtStart === dirtyPath\.value/,
        'save tail must verify props unchanged (stale-write guard)')
})

test('DiffEditor: save 成功后按归属守门刷新 git（notifyGitFileSaved）', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    assert.match(src, /import[\s\S]*?notifyGitFileSaved[\s\S]*?from '.*gitSaveRefresh'/,
        'must import notifyGitFileSaved from utils/gitSaveRefresh')
    // save 网络往返期间可能已切 agent（ensureAgent → reset 过）：
    // 组件层必须先校验 store 归属，否则旧 agent 的刷新会写进新 agent 的 store
    assert.match(src, /git\.currentAgentId === agentAtStart[\s\S]{0,200}notifyGitFileSaved\(/,
        'git refresh must be gated by store ownership before notifyGitFileSaved')
})

test('DiffEditor: Ctrl/Cmd+S 绑 modified 侧编辑器', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    assert.match(src, /getModifiedEditor\(\)[\s\S]*?addCommand[\s\S]*?KeyS/,
        'Ctrl+S must be bound on the modified editor')
})

test('DiffEditor: expose isDirty/isSaving/save/isEditable/isReadOnly 给父组件', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    assert.match(src, /defineExpose\(\{[\s\S]*?isDirty[\s\S]*?isSaving[\s\S]*?save[\s\S]*?isEditable[\s\S]*?isReadOnly/,
        'parent needs isDirty/isSaving/save/isEditable/isReadOnly (Save button + dirty confirm)')
})

test('DiffEditor: dirty 状态接入全局 viewer 单槽（切换/关闭确认 + 卸载清理）', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    assert.match(src, /viewer\.setDirty\(/, 'must sync dirty into global viewer slot')
    assert.match(src, /onBeforeUnmount[\s\S]*?viewer\.setDirty\(null\)/,
        'must clear global dirty slot on unmount')
})

// ── WorkspaceViewer 侧接线（diff 可编辑后，头部 Save / 快捷键 / dirty 确认不再只认 file 模式）──

function diffActionsBlock(src: string): string {
    const m = src.match(/<template v-else-if="target\?\.type === 'diff'">([\s\S]*?)<\/template>/)
    assert.ok(m, 'diff actions template block must exist')
    return m[1]
}

test('Viewer: diff 模式工具栏提供 Save 按钮（仅可编辑时显示，dirty 高亮 / saving 态）', () => {
    const src = read('src/components/workspace/WorkspaceViewer.vue')
    const block = diffActionsBlock(src)
    assert.match(block, /diffIsEditable/, 'Save button must be gated by diffIsEditable')
    assert.match(block, /onClickSaveDiff/, 'Save button must call onClickSaveDiff')
    assert.match(block, /diffIsDirty/, 'Save button must highlight when dirty')
    assert.match(block, /diffIsSaving/, 'Save button must show saving state')
})

test('Viewer: 全局 Ctrl+S 纳入可编辑的 diff（不再只认 file 模式）', () => {
    const src = read('src/components/workspace/WorkspaceViewer.vue')
    const fn = src.match(/async function onSaveShortcut[\s\S]*?\n}/)
    assert.ok(fn, 'onSaveShortcut must exist')
    // 可编辑 diff 也要走 viewer 级 Ctrl+S（焦点不在 editor 时 monaco command 不生效）
    assert.match(fn[0], /isFileMode[\s\S]*?diffIsEditable/,
        'shortcut must fire for file mode OR editable diff')
})

test('Viewer: Esc/返回的丢弃确认与 isSaving 落地轮询纳入 diff', () => {
    const src = read('src/components/workspace/WorkspaceViewer.vue')
    // confirmDiscardIfDirty：file 分支之外必须有 diff 分支
    const fn = src.match(/async function confirmDiscardIfDirty[\s\S]*?\n}/)
    assert.ok(fn, 'confirmDiscardIfDirty must exist')
    assert.match(fn[0], /diffIsDirty/, 'discard confirm must cover diff dirty')
    // close 轮询：等保存落地（file 与 diff 两处 ref）
    const close = src.match(/async function close\([\s\S]*?\n}/)
    assert.ok(close, 'close must exist')
    assert.match(close[0], /diffViewRef[\s\S]*?isSaving/,
        'close must wait for diff save to settle too')
})

test('Viewer: 面包屑 dirty 圆点纳入 diff 模式', () => {
    const src = read('src/components/workspace/WorkspaceViewer.vue')
    assert.match(src, /(isFileMode && fileIsDirty)[\s\S]{0,120}diffIsDirty/,
        'breadcrumb dirty dot must cover editable diff too')
})

// ── 审核 Important 修复：脏 diff buffer 的静默销毁面 ──

test('DiffEditor: 切文件时同步重置 dirty（fetch 窗口内不得错挂到新路径）', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    // props watcher 在 load() 之前必须同步清 isDirty/baseline：否则旧文件的 dirty
    // 在 fetch await 窗口内以新路径写进全局 dirty 槽（fetch 失败时永久残留）。
    // WorkspaceFileView.vue:329 修过一模一样的 bug（同款防护）。
    const watcher = src.match(/watch\(\s*\(\) => \[props\.agentId, props\.repo[\s\S]*?\n\)/)
    assert.ok(watcher, 'props watcher must exist')
    assert.match(watcher[0], /isDirty\.value = false/, 'props watcher must reset isDirty synchronously')
    assert.match(watcher[0], /baselineAfter = ''/, 'props watcher must reset baseline')
    // dirty 重置必须先于 load() 调用（同步段 vs 异步体）
    const resetIdx = watcher[0].indexOf('isDirty.value = false')
    const loadIdx = watcher[0].indexOf('load()')
    assert.ok(resetIdx !== -1 && loadIdx !== -1 && resetIdx < loadIdx,
        'dirty reset must happen before load() fires')
})

test('GitTab: 换 diff/file 目标前拦截脏 buffer（confirmIfDirty，同 Files tab）', () => {
    const src = read('src/components/workspace/WorkspaceTabGit.vue')
    assert.match(src, /async function confirmIfDirty/, 'must define confirmIfDirty (same as WorkspaceTabFiles)')
    for (const fn of ['openDiff', 'openUnstagedDiff', 'openFile', 'openCommitFile', 'openCommitDiff']) {
        const m = src.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n}`))
        assert.ok(m, `${fn} must exist`)
        assert.match(m[0], /confirmIfDirty/,
            `${fn} must confirm before silently discarding a dirty diff buffer`)
    }
})

test('GitTab: discard 后 diff 分支尊重 dirty buffer（deleted 确认 / reverted 不重拉）', () => {
    const src = read('src/components/workspace/WorkspaceTabGit.vue')
    const block = src.match(/cur\?\.type === 'diff'[\s\S]*?\n    }/)
    assert.ok(block, 'afterDiscard diff branch must exist')
    // deleted：dirty buffer 是唯一副本（同 file 分支），丢弃前必须确认
    assert.match(block[0], /deletedPaths\.has\(wsFile\)[\s\S]*?viewer\.dirty[\s\S]*?confirm/,
        'deleted diff with dirty buffer must confirm before close')
    // reverted：dirty 时不得 close+reopen（buffer 权威高于磁盘，同 file 分支语义）
    const revert = block[0].match(/revertedPaths\.has\(wsFile\)[\s\S]*?openDiff/)
    assert.ok(revert, 'reverted branch must exist')
    assert.match(revert[0], /dirty[\s\S]*?wsFile/,
        'reverted diff must skip reload when buffer is dirty')
})
