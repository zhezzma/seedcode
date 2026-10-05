// tests/git-save-refresh.test.ts
// notifyGitFileSaved：编辑器保存工作区文件后的 git 刷新门控（纯函数直测）。
//
// 背景：WorkspaceFileView.save 内联了一段"保存后按归属门控刷新 status/repos"的逻辑，
// unstaged diff 视图可编辑后（WorkspaceDiffEditor.save）需要同一段逻辑 → 抽共用。
//
// 语义（沿用 WorkspaceFileView.save 的既有契约，与 useWorkspaceGit.refreshWorktreeState
// 的"磁盘变了就全刷"不同——这里按 path 归属精细门控）：
// - status：仅当 path 归属当前打开的 repo（statusRepo）才重拉；statusRepo 为 null
//   （Git tab 未打开过）时不拉 —— 用户没看 Git tab 就不付出代价。
// - repos：仅当 path 归属任一已加载 repo 才重拉（RepoSelector dirty 徽标数据源）。
// - 保存仓库外的 scratch 文件零成本。
// - repo === '.' 表示 workspace 根本身是个 repo（服务端 emit relPath "."）→ 任何文件都归属。
// - 严格前缀匹配避免 'foo' 误匹 'foobar'；path === repo 作为防御性分支保留。
import test from 'node:test'
import assert from 'node:assert/strict'
import { notifyGitFileSaved } from '../src/utils/gitSaveRefresh.ts'

interface LoadCall { agentId: string; repo?: string }

function makeGit(opts: {
    statusRepo?: string | null
    repos?: { path: string }[]
} = {}) {
    const statusCalls: LoadCall[] = []
    const reposCalls: LoadCall[] = []
    const git = {
        statusRepo: opts.statusRepo ?? null,
        repos: { value: opts.repos ?? [] },
        loadStatus(agentId: string, repo: string) { statusCalls.push({ agentId, repo }) },
        loadRepos(agentId: string) { reposCalls.push({ agentId }) },
    }
    return { git, statusCalls, reposCalls }
}

test('path 归属 statusRepo → loadStatus(agentId, repo)；repos 未加载 → 不拉 repos', () => {
    const { git, statusCalls, reposCalls } = makeGit({ statusRepo: 'pkg/app' })
    notifyGitFileSaved({ git, agentId: 'a1', path: 'pkg/app/src/a.ts' })
    assert.deepEqual(statusCalls, [{ agentId: 'a1', repo: 'pkg/app' }])
    assert.equal(reposCalls.length, 0)
})

test('statusRepo 为 "." → 任何路径都归属（workspace 根即 repo）', () => {
    const { git, statusCalls } = makeGit({ statusRepo: '.' })
    notifyGitFileSaved({ git, agentId: 'a1', path: 'scratch/notes.md' })
    assert.deepEqual(statusCalls, [{ agentId: 'a1', repo: '.' }])
})

test('严格前缀匹配：repo "foo" 不误匹 "foobar/…"；但 "foo/…" 与 path === repo 命中', () => {
    const miss = makeGit({ statusRepo: 'foo' })
    notifyGitFileSaved({ git: miss.git, agentId: 'a1', path: 'foobar/x.ts' })
    assert.equal(miss.statusCalls.length, 0)

    const nested = makeGit({ statusRepo: 'foo' })
    notifyGitFileSaved({ git: nested.git, agentId: 'a1', path: 'foo/x.ts' })
    assert.equal(nested.statusCalls.length, 1)

    const self = makeGit({ statusRepo: 'foo' })
    notifyGitFileSaved({ git: self.git, agentId: 'a1', path: 'foo' })
    assert.equal(self.statusCalls.length, 1)
})

test('statusRepo 为 null（Git tab 未打开过）→ 不拉 status', () => {
    const { git, statusCalls, reposCalls } = makeGit()
    notifyGitFileSaved({ git, agentId: 'a1', path: 'pkg/app/src/a.ts' })
    assert.equal(statusCalls.length, 0)
    assert.equal(reposCalls.length, 0)
})

test('path 归属任一已加载 repo → loadRepos（dirty 徽标数据源）', () => {
    const { git, reposCalls } = makeGit({ repos: [{ path: 'pkg/app' }, { path: 'docs' }] })
    notifyGitFileSaved({ git, agentId: 'a1', path: 'docs/b.md' })
    assert.deepEqual(reposCalls, [{ agentId: 'a1' }])
})

test('path 不属于任何已加载 repo → 不拉 repos（scratch 文件零成本）', () => {
    const { git, reposCalls, statusCalls } = makeGit({ repos: [{ path: 'pkg/app' }] })
    notifyGitFileSaved({ git, agentId: 'a1', path: 'scratch/notes.md' })
    assert.equal(reposCalls.length, 0)
    assert.equal(statusCalls.length, 0)
})

test('status 与 repos 判定独立：可同时触发，也可各自单独触发', () => {
    const both = makeGit({ statusRepo: 'pkg/app', repos: [{ path: 'pkg/app' }] })
    notifyGitFileSaved({ git: both.git, agentId: 'a1', path: 'pkg/app/a.ts' })
    assert.equal(both.statusCalls.length, 1)
    assert.equal(both.reposCalls.length, 1)

    const onlyRepos = makeGit({ statusRepo: 'other', repos: [{ path: 'pkg/app' }] })
    notifyGitFileSaved({ git: onlyRepos.git, agentId: 'a1', path: 'pkg/app/a.ts' })
    assert.equal(onlyRepos.statusCalls.length, 0)
    assert.equal(onlyRepos.reposCalls.length, 1)
})
