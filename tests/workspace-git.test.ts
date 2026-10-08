import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'

const originalFetch = globalThis.fetch
const originalLocalStorage = globalThis.localStorage

function setupStorage() {
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => storage.get(k) ?? null,
            setItem: (k: string, v: string) => { storage.set(k, v) },
            removeItem: (k: string) => { storage.delete(k) },
            clear: () => storage.clear(),
            key: () => null,
            length: 0,
        },
    })
}

function mockRoutes(routes: Record<string, () => unknown>) {
    globalThis.fetch = (async (url: string) => {
        for (const pattern in routes) {
            if (url.includes(pattern)) {
                return new Response(JSON.stringify({ ok: true, payload: routes[pattern]() }), { status: 200 })
            }
        }
        return new Response(JSON.stringify({ ok: false, error: 'not mocked: ' + url }), { status: 500 })
    }) as any
}

async function setupSettings() {
    const { useUiSettingsStore } = await import('../src/stores/setting.ts')
    const settings = useUiSettingsStore()
    settings.apiBaseUrl = 'http://localhost'
    settings.token = 't'
}

test.beforeEach(() => {
    setupStorage()
    setActivePinia(createPinia())
})

test.afterEach(() => {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
})

test('loadRepos 拉仓库列表', async () => {
    await setupSettings()
    mockRoutes({
        '/workspace/repos': () => ({ repos: [
            { name: 'r1', path: 'r1', branch: 'main', head: 'abc', dirty: 0, ahead: 0, behind: 0 },
        ]}),
    })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    await git.loadRepos('coder')
    assert.equal(git.repos.value.length, 1)
})

test('loadStatus 拉某仓库 status', async () => {
    await setupSettings()
    mockRoutes({
        '/workspace/repo/status': () => ({
            branch: 'main', upstream: null, head: 'abc', ahead: 0, behind: 0,
            staged: [{ path: 'a.ts', status: 'M' }],
            unstaged: [],
            untracked: [],
        }),
    })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    await git.loadStatus('coder', 'r1')
    assert.equal(git.status.value?.staged.length, 1)
})

test('loadLog 与 loadMoreLog 翻页累加', async () => {
    await setupSettings()
    let call = 0
    mockRoutes({
        '/workspace/repo/log': () => {
            call++
            // 第一页返回满 50 条 → hasMore=true；第二页返回 1 条
            const count = call === 1 ? 50 : 1
            return {
                commits: Array.from({ length: count }, (_, i) => ({
                    sha: `sha${call}-${i}`,
                    shortSha: `s${call}-${i}`,
                    author: 'a',
                    authorDate: 'd',
                    subject: `commit ${call}-${i}`,
                })),
            }
        },
    })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    await git.loadLog('coder', 'r1')
    assert.equal(git.commits.value.length, 50)
    await git.loadMoreLog('coder', 'r1')
    assert.equal(git.commits.value.length, 51)
})

test('loadCommitFiles 缓存到 commitFiles map', async () => {
    await setupSettings()
    mockRoutes({
        '/repo/commit/files': () => ({ ref: 'sha', files: [{ path: 'a.ts', status: 'M' }] }),
    })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    await git.loadCommitFiles('coder', 'r1', 'sha')
    assert.equal(git.commitFiles.value['sha']?.length, 1)
})

test('formatCommitInfo 生成可复制的完整提交信息', async () => {
    const { formatCommitInfo } = await import('../src/composables/useWorkspaceGit.ts')
    assert.equal(formatCommitInfo({
        sha: 'abcdef1234567890',
        shortSha: 'abcdef1',
        author: 'Alice <alice@example.com>',
        authorDate: '2026-07-02T12:34:56.000Z',
        subject: 'feat: add context menu',
        body: 'line one\nline two',
    }), [
        'Commit: abcdef1234567890',
        'Author: Alice <alice@example.com>',
        'Date: 2026-07-02T12:34:56.000Z',
        'Subject: feat: add context menu',
        'Body: line one\nline two',
    ].join('\n'))
})

test('formatCommitInfo 无正文时不输出 Body 行', async () => {
    const { formatCommitInfo } = await import('../src/composables/useWorkspaceGit.ts')
    assert.equal(formatCommitInfo({
        sha: 'abcdef1234567890',
        shortSha: 'abcdef1',
        author: 'Alice <alice@example.com>',
        authorDate: '2026-07-02T12:34:56.000Z',
        subject: 'init',
        body: '',
    }), [
        'Commit: abcdef1234567890',
        'Author: Alice <alice@example.com>',
        'Date: 2026-07-02T12:34:56.000Z',
        'Subject: init',
    ].join('\n'))
})

test('formatCommitInfo 缺省 body 字段时不输出 Body 行', async () => {
    const { formatCommitInfo } = await import('../src/composables/useWorkspaceGit.ts')
    // body 字段缺省（后端未返回时最常见的形态），与 body: '' 行为一致
    assert.equal(formatCommitInfo({
        sha: 'abcdef1234567890',
        shortSha: 'abcdef1',
        author: 'Alice <alice@example.com>',
        authorDate: '2026-07-02T12:34:56.000Z',
        subject: 'init',
    }), [
        'Commit: abcdef1234567890',
        'Author: Alice <alice@example.com>',
        'Date: 2026-07-02T12:34:56.000Z',
        'Subject: init',
    ].join('\n'))
})

test('loadWorkspaceRoot 拉工作区根绝对路径', async () => {
    await setupSettings()
    mockRoutes({
        '/workspace/tree': () => ({ root: '/abs/workspace', path: '', entries: [] }),
    })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    await git.loadWorkspaceRoot('coder')
    assert.equal(git.workspaceRoot.value, '/abs/workspace')
})

test('reset 清空所有状态', async () => {
    await setupSettings()
    mockRoutes({ '/workspace/repos': () => ({ repos: [{ name: 'r', path: 'r', branch: 'm', head: null, dirty: 0, ahead: 0, behind: 0 }] }) })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    await git.loadRepos('coder')
    git.reset()
    assert.equal(git.repos.value.length, 0)
    assert.equal(git.status.value, null)
})

test('getter 名与 state 字段名不冲突（防止 Object.assign 覆盖成 truthy字典）', async () => {
    // 这个回归针对浏览器实测中发现的 P0：
    // _methods 里 `reposLoading: { get value() {...} }` 如果与 state 中 `reposLoading: false`
    // 同名，Object.assign 会用 getter 对象覆盖 boolean，导致 git.reposLoading.value 返回
    // 的其实是 getter 对象本身（冗余结构）、且在 onMounted 检查中 `!git.reposLoading.value`
    // 永远为 false，造成首次 loadRepos 不触发。
    // 这里验证：loadRepos 过程中 reposLoading 是真的 boolean，不是 getter 对象。
    await setupSettings()
    let resolveLoad: ((v: any) => void) | null = null
    globalThis.fetch = (async (url: string) => {
        if (url.includes('/workspace/repos')) {
            return new Promise(resolve => { resolveLoad = resolve })
        }
        return new Response('', { status: 500 })
    }) as any
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()

    // 初始：未加载
    assert.equal(typeof git.reposLoading.value, 'boolean', 'reposLoading.value 必须是 boolean')
    assert.equal(git.reposLoading.value, false)
    assert.equal(typeof git.reposError.value, 'object') // null 是 object，但赋值后是 string

    // 进行中：loading 必须是 true、不是 getter 对象
    const promise = git.loadRepos('coder')
    assert.equal(typeof git.reposLoading.value, 'boolean')
    assert.equal(git.reposLoading.value, true, 'loadRepos 中 reposLoading 应为 true')

    // 完成后回到 false
    resolveLoad!(new Response(JSON.stringify({ ok: true, payload: { repos: [] } }), { status: 200 }))
    await promise
    assert.equal(typeof git.reposLoading.value, 'boolean')
    assert.equal(git.reposLoading.value, false)

    // 同样验证其它几个可能冲突的字段
    assert.equal(typeof git.statusLoading.value, 'boolean')
    assert.equal(typeof git.commitsLoading.value, 'boolean')
    assert.equal(typeof git.commitsHasMore.value, 'boolean')
})

test('reset 后跸 agent 旧 in-flight 请求被丢弃（epoch 防护）', async () => {
    await setupSettings()
    let resolveOldRepos: ((v: any) => void) | null = null
    let callCount = 0
    globalThis.fetch = (async (url: string) => {
        if (url.includes('/workspace/repos')) {
            callCount++
            if (callCount === 1) {
                // 第一次调用（agent A）挂起不 resolve，模拟慢请求
                return new Promise(resolve => { resolveOldRepos = resolve })
            }
            // 第二次调用（agent B）立即返回新数据
            return new Response(JSON.stringify({
                ok: true,
                payload: { repos: [{ name: 'B-repo', path: 'B-repo', branch: 'main', head: null, dirty: 0, ahead: 0, behind: 0 }] },
            }), { status: 200 })
        }
        return new Response('', { status: 500 })
    }) as any

    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()

    // 1) agent A 发起 loadRepos，挂起
    const oldLoad = git.loadRepos('agentA')
    // 2) reset 模拟 agent 切换
    git.reset()
    // 3) agent B 发起 loadRepos，立即完成
    await git.loadRepos('agentB')
    assert.equal(git.repos.value.length, 1)
    assert.equal(git.repos.value[0].name, 'B-repo')

    // 4) 现在 resolve agent A 的旧响应
    resolveOldRepos!(new Response(JSON.stringify({
        ok: true,
        payload: { repos: [{ name: 'A-repo', path: 'A-repo', branch: 'main', head: null, dirty: 0, ahead: 0, behind: 0 }] },
    }), { status: 200 }))
    await oldLoad

    // 验证：B 的数据未被 A 的迟到响应覆盖
    assert.equal(git.repos.value.length, 1)
    assert.equal(git.repos.value[0].name, 'B-repo')
})

test('markStatusStale 已删除：close viewer 不会刷 git（契约变更的回归点）', async () => {
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    // 新契约：store 不再暴露 markStatusStale。如果有人加回来，请重新考虑是否倒退了
    // “仅磁盘变更才刷新”这个设计。
    assert.equal(typeof (git as any).markStatusStale, 'undefined')
})

test('save 后在 statusRepo 匹配时重拉 status（新契约：只有磁盘变更才刷新）', async () => {
    await setupSettings()
    let saveCalls = 0
    let statusCalls = 0
    mockRoutes({
        '/workspace/file?': () => { saveCalls++; return { ok: true } },
        '/workspace/repo/status': () => {
            statusCalls++
            return { branch: 'main', upstream: null, head: 'h', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] }
        },
    })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const { saveFile } = await import('../src/composables/workspace-api.ts')
    const git = useWorkspaceGit()
    git.reset()

    // 先 loadStatus 设上 statusRepo='repoA'，模拟用户看过 Git tab
    await git.loadStatus('coder', 'repoA')
    assert.equal(git.statusRepo, 'repoA')
    const statusBefore = statusCalls

    // 模拟 WorkspaceFileView.save 的关键逻辑：save -> 判断归属 -> loadStatus
    // 这里直接封装判断逻辑以隔离 monaco 依赖
    await saveFile('coder', 'repoA/src/a.ts', 'new content')
    assert.equal(saveCalls, 1)

    // 应用属于 repoA 的归属判断逻辑，主动走一次 loadStatus
    const repo = git.statusRepo!
    const path = 'repoA/src/a.ts'
    const belongs = repo === '.' || path === repo || path.startsWith(repo + '/')
    assert.equal(belongs, true)
    if (belongs) await git.loadStatus('coder', repo)

    assert.equal(statusCalls, statusBefore + 1)
})

test('save 归属判断：root repo（"."）/ prefix-collision / 跨仓 覆盖', () => {
    // 这是 WorkspaceFileView.save 里归属判断的纯逻辑回归点。
    // 与实现必须严格一致，避免 'foo' 误匹 'foobar' 之类 bug。
    // 服务端对「workspace 根本身是 repo」emit relPath "."（旧版 '' 已废）。
    const belongs = (repo: string, path: string) =>
        repo === '.' || path === repo || path.startsWith(repo + '/')

    // 1) root repo：workspace 根本身是 repo（relPath "."），任何 workspace 文件都属于它
    assert.equal(belongs('.', 'any/path.ts'), true)
    assert.equal(belongs('.', 'a.ts'), true)

    // 2) 正常嵌套
    assert.equal(belongs('foo', 'foo/a.ts'), true)
    assert.equal(belongs('foo', 'foo/sub/a.ts'), true)

    // 3) prefix collision：foo 仓不能误匹 foobar/* 路径
    assert.equal(belongs('foo', 'foobar/a.ts'), false)
    assert.equal(belongs('foo', 'foobar'), false)

    // 4) 跨仓：bar 仓不能匹 foo/* 路径
    assert.equal(belongs('bar', 'foo/a.ts'), false)
})

test('repoJoin：根仓库（"."）不产生 "./" 前缀，子仓正常拼接', async () => {
    const { repoJoin } = await import('../src/composables/useWorkspaceGit.ts')
    assert.equal(repoJoin('.', 'src/foo.ts'), 'src/foo.ts')
    assert.equal(repoJoin('.', 'a.ts'), 'a.ts')
    assert.equal(repoJoin('sub', 'a.ts'), 'sub/a.ts')
})

// ─────────────────────────────────────────────────────────────────────────────
// Mutation × 下拉菜单同步回归（RepoSelector 数据源是 repos，不是 status）
// 背景：commit / sync / discard 之后只重拉了 status + log，reposData 停在旧值，
// 导致下拉菜单与顶部按钮摘要的 branch / dirty / ahead / behind 全部过期。
// 契约：
//   - commit / sync / discard → 必须重拉 repos（dirty、ahead/behind、head 都会变）
//   - stage / unstage → 不重拉 repos（服务端 dirty = staged+unstaged+untracked
//     去重路径总数，stage 只是同批文件在桶间搬家，总数不变）
// ─────────────────────────────────────────────────────────────────────────────

function setupMutationRoutes() {
    const counts = { repos: 0, status: 0, log: 0, stage: 0, unstage: 0, discard: 0, commit: 0, sync: 0 }
    mockRoutes({
        '/workspace/repos': () => { counts.repos++; return { repos: [
            { name: 'r1', path: 'r1', branch: 'main', head: 'abc', dirty: 0, ahead: 0, behind: 0 },
        ] } },
        '/workspace/repo/status': () => { counts.status++; return {
            branch: 'main', upstream: null, head: 'abc', ahead: 0, behind: 0,
            staged: [], unstaged: [], untracked: [],
        } },
        '/workspace/repo/log': () => { counts.log++; return { commits: [] } },
        '/workspace/repo/stage': () => { counts.stage++; return { ok: true } },
        '/workspace/repo/unstage': () => { counts.unstage++; return { ok: true } },
        '/workspace/repo/discard': () => { counts.discard++; return { ok: true } },
        '/workspace/repo/commit': () => { counts.commit++; return { ok: true, head: 'abc1234', output: '' } },
        '/workspace/repo/sync': () => { counts.sync++; return { ok: true, head: 'abc1234', pulled: '', pushed: false, pushOutput: '' } },
    })
    return counts
}

test('commit 后重拉 repos（下拉菜单 branch/dirty/ahead/head 的数据源）', async () => {
    await setupSettings()
    const counts = setupMutationRoutes()
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.currentAgentId = 'coder'
    await git.commit('coder', 'r1', 'msg')
    assert.equal(counts.commit, 1)
    assert.equal(counts.repos, 1, 'commit 必须重拉 repos，否则 RepoSelector 下拉与按钮摘要停在旧值')
    assert.equal(counts.status, 1)
    assert.equal(counts.log, 1)
})

test('sync 后重拉 repos（pull/push 改变 ahead/behind）', async () => {
    await setupSettings()
    const counts = setupMutationRoutes()
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.currentAgentId = 'coder'
    await git.sync('coder', 'r1')
    assert.equal(counts.sync, 1)
    assert.equal(counts.repos, 1, 'sync 必须重拉 repos，否则下拉菜单的 ↑/↓ 徽标过期')
    assert.equal(counts.status, 1)
    assert.equal(counts.log, 1)
})

test('discard 后重拉 repos（revert/删除使 dirty 总数变化）', async () => {
    await setupSettings()
    const counts = setupMutationRoutes()
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.currentAgentId = 'coder'
    await git.discard('coder', 'r1', ['a.ts'])
    assert.equal(counts.discard, 1)
    assert.equal(counts.repos, 1, 'discard 改动 worktree，dirty 总数变化，必须重拉 repos')
    assert.equal(counts.status, 1)
})

test('stage / unstage 不重拉 repos（dirty 是去重路径总数，桶间搬家不变量）', async () => {
    await setupSettings()
    const counts = setupMutationRoutes()
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.currentAgentId = 'coder'
    await git.stage('coder', 'r1', ['a.ts'])
    await git.unstage('coder', 'r1')
    assert.equal(counts.stage, 1)
    assert.equal(counts.unstage, 1)
    assert.equal(counts.repos, 0, 'stage/unstage 不改变 dirty 总数，不该付出 N 个仓库的 git status 代价')
    assert.equal(counts.status, 2)
})

test('refreshWorktreeState：repos 已加载 + statusRepo 已设 → 两者都重拉', async () => {
    await setupSettings()
    const counts = setupMutationRoutes()
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.currentAgentId = 'coder'
    // 模拟用户打开过 Git tab：repos 与 status 都已加载
    await git.loadRepos('coder')
    await git.loadStatus('coder', 'r1')
    const reposBefore = counts.repos
    const statusBefore = counts.status
    await git.refreshWorktreeState('coder')
    assert.equal(counts.repos, reposBefore + 1, 'repos 已加载时 Files tab 改动文件必须同步下拉数据源')
    assert.equal(counts.status, statusBefore + 1, 'statusRepo 已设时 Files tab 改动文件必须同步状态列表')
})

test('refreshWorktreeState：Git tab 未打开过（repos 空 + statusRepo null）→ no-op', async () => {
    await setupSettings()
    const counts = setupMutationRoutes()
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.currentAgentId = 'coder'
    await git.refreshWorktreeState('coder')
    assert.equal(counts.repos, 0, '从未看过 Git tab 时不发无谓请求')
    assert.equal(counts.status, 0)
})

test('refreshWorktreeState：跨 agent 调用被守护（不写别的 agent 的 store）', async () => {
    await setupSettings()
    const counts = setupMutationRoutes()
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.currentAgentId = 'coder'
    await git.loadRepos('coder')
    await git.loadStatus('coder', 'r1')
    const reposBefore = counts.repos
    const statusBefore = counts.status
    // store 归属已被 agentB 接管（真实路径由 ensureAgent 写入；测试直接改归属标记）
    git.currentAgentId = 'agentB'
    await git.refreshWorktreeState('coder')
    assert.equal(counts.repos, reposBefore, '跨 agent 的 refresh 必须被拒绝')
    assert.equal(counts.status, statusBefore, '跨 agent 的 refresh 必须被拒绝')
})

test('_mutating 期间 stage/unstage/discard 抛错（不静默 no-op，与 commit/sync 同契约）', async () => {
    await setupSettings()
    // 用挂起的 stage 请求把 _mutating 钉在 true
    let resolveStage: ((v: Response) => void) | null = null
    globalThis.fetch = (async (url: string) => {
        if (url.includes('/workspace/repo/stage')) {
            return new Promise(resolve => { resolveStage = resolve })
        }
        return new Response(JSON.stringify({ ok: true, payload: { ok: true } }), { status: 200 })
    }) as any
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    const inFlight = git.stage('coder', 'r1', ['a.ts'])
    // 窗口期内再发 mutation：必须 reject（调用方的 catch 会 toast，且 discard 的
    // afterDiscard 副作用钩子依赖「discard 确实发生了」这个前提），不能静默吞。
    await assert.rejects(() => git.discard('coder', 'r1', ['b.ts']), /mutation in progress/)
    await assert.rejects(() => git.stage('coder', 'r1', ['c.ts']), /mutation in progress/)
    await assert.rejects(() => git.unstage('coder', 'r1'), /mutation in progress/)
    resolveStage!(new Response(JSON.stringify({ ok: true, payload: { ok: true } }), { status: 200 }))
    await inFlight
})

test('refreshWorktreeState 跨 agent 守护改用真实写入者 ensureAgent 验证', async () => {
    await setupSettings()
    const counts = setupMutationRoutes()
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.ensureAgent('coder')
    await git.loadRepos('coder')
    await git.loadStatus('coder', 'r1')
    // store 归属切到 agentB（真实路径：ensureAgent），并装入 B 自己的数据 ——
    // 这样「repos 非空 / statusRepo 已设」两个 no-op 门控都不会意外命中，
    // 守护测试只验证归属比对本身。
    git.ensureAgent('agentB')
    await git.loadRepos('agentB')
    await git.loadStatus('agentB', 'r1')
    const reposBefore = counts.repos
    const statusBefore = counts.status
    await git.refreshWorktreeState('coder')
    assert.equal(counts.repos, reposBefore, '跨 agent 的 refresh 必须被拒绝')
    assert.equal(counts.status, statusBefore, '跨 agent 的 refresh 必须被拒绝')
})

test('loadStatus 透传 refresh 选项（手动刷新让服务端先 fetch upstream，↓behind 才会更新）', async () => {
    await setupSettings()
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
        urls.push(String(url))
        return new Response(JSON.stringify({
            ok: true,
            payload: { branch: 'main', upstream: null, head: 'h', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] },
        }), { status: 200 })
    }) as any
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    // store 是模块级单例，前一个测试的 ensureAgent('agentB') 残留归属会触发
    // loadStatus 的同步归属守护（no-op）。显式归属回 coder。
    git.ensureAgent('coder')
    await git.loadStatus('coder', 'r1')
    await git.loadStatus('coder', 'r1', { refresh: true })
    assert.equal(urls.length, 2)
    assert.doesNotMatch(urls[0], /refresh/, '日常轮询不带 refresh（避免每次走网络）')
    assert.match(urls[1], /refresh=1/, '显式 refresh 必须透传到服务端')
})

test('loadRepos 透传 refresh 选项（git 面板挂载/手动刷新才带，工具卡点击链路保持纯本地）', async () => {
    await setupSettings()
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
        urls.push(String(url))
        return new Response(JSON.stringify({ ok: true, payload: { repos: [] } }), { status: 200 })
    }) as any
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.ensureAgent('coder')
    await git.loadRepos('coder')
    await git.loadRepos('coder', { refresh: true })
    assert.equal(urls.length, 2)
    assert.doesNotMatch(urls[0], /refresh/, 'mutation 后重载等隐式入口不带 refresh（不走网络）')
    assert.match(urls[1], /repos\?refresh=1/, '显式 refresh 必须透传到服务端')
})

test('commit 在 agent 切换（epoch 变化）后返回 stale 标记，caller 据此跳过 toast', async () => {
    await setupSettings()
    let resolveCommit: ((v: Response) => void) | null = null
    globalThis.fetch = (async (url: string) => {
        if (url.includes('/workspace/repo/commit')) {
            return new Promise(resolve => { resolveCommit = resolve })
        }
        return new Response(JSON.stringify({ ok: true, payload: { ok: true } }), { status: 200 })
    }) as any
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    const p = git.commit('coder', 'r1', 'msg')
    git.reset()   // 模拟 agent 切换
    resolveCommit!(new Response(JSON.stringify({
        ok: true,
        payload: { ok: true, head: 'abc1234', output: '' },
    }), { status: 200 }))
    const r = await p
    assert.equal(r.head, 'abc1234', '提交确实发生在服务端，head 应返回')
    assert.equal(r.stale, true, '但必须带 stale 标记（在别的 agent 界面弹提交成功会误导归属）')
})

test('sync 在 agent 切换（epoch 变化）后同样返回 stale 标记', async () => {
    await setupSettings()
    let resolveSync: ((v: Response) => void) | null = null
    globalThis.fetch = (async (url: string) => {
        if (url.includes('/workspace/repo/sync')) {
            return new Promise(resolve => { resolveSync = resolve })
        }
        return new Response(JSON.stringify({ ok: true, payload: { ok: true } }), { status: 200 })
    }) as any
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    const p = git.sync('coder', 'r1')
    git.reset()
    resolveSync!(new Response(JSON.stringify({
        ok: true,
        payload: { ok: true, head: 'abc1234', pulled: '', pushed: false, pushOutput: '' },
    }), { status: 200 }))
    const r = await p
    assert.equal(r.pushed, false)
    assert.equal(r.stale, true)
})

test('discard 在 agent 切换/改绑（epoch 变化）后同样返回 stale 标记，caller 跳过 afterDiscard', async () => {
    await setupSettings()
    let resolveDiscard: ((v: Response) => void) | null = null
    let reposPulls = 0
    globalThis.fetch = (async (url: string) => {
        if (url.includes('/workspace/repo/discard')) {
            return new Promise(resolve => { resolveDiscard = resolve })
        }
        if (url.includes('/workspace/repos')) {
            reposPulls++
            return new Response(JSON.stringify({ ok: true, payload: { repos: [] } }), { status: 200 })
        }
        return new Response(JSON.stringify({ ok: true, payload: { ok: true } }), { status: 200 })
    }) as any
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    const p = git.discard('coder', 'r1', ['a.ts'])
    // 模拟同 agent 改绑 workspace（AgentOverview 调 reset，不动 currentAgentId）：
    // afterDiscard 的 currentAgentId 归属复查拦不住这种场景，必须靠 stale 标记
    git.reset()
    resolveDiscard!(new Response(JSON.stringify({ ok: true, payload: { ok: true } }), { status: 200 }))
    const r = await p
    assert.equal(r.stale, true, 'discard 后跳过树失效/viewer 关闭的凭据')
    assert.equal(reposPulls, 0, 'epoch 失配后不得重拉 repos（树/git 已归属新世界）')
})

test('classifyDiscardEffects: untracked 删除 / staged-add 删除 / tracked 还原三分正确', async () => {
    const { classifyDiscardEffects } = await import('../src/composables/useWorkspaceGit.ts')
    const stagedAdds = new Set(['am-file.ts', 'sub/renamed.ts'])
    const r = classifyDiscardEffects([
        { path: 'plain-mod.ts', status: 'M' },        // 普通 MM：还原，文件仍在
        { path: 'am-file.ts', status: 'M' },          // staged 'A' + 工作区又改：服务端删文件！
        { path: 'new.txt', status: '?' },             // untracked：删文件
        { path: 'sub/renamed.ts', status: 'M' },      // staged 'R' 新路径 + 又改：删文件
        { path: 'gone.ts', status: 'D' },             // 工作区已删：还原回磁盘（父目录列表新增）
    ], 'r1', stagedAdds)

    // 删除类（含 staged-add！）：viewer 直接关、父目录失效
    assert.ok(r.deletedPaths.has('r1/am-file.ts'), 'AM 文件必须按删除分类（git 实测 restore --source=HEAD 连目录带文件删除）')
    assert.ok(r.deletedPaths.has('r1/new.txt'))
    assert.ok(r.deletedPaths.has('r1/sub/renamed.ts'), 'staged R 新路径不在 HEAD，discard 同样是删除')
    assert.ok(r.deletedParents.has('r1/sub'))
    // 还原类：文件仍在磁盘，viewer close+nextTick+open 重载
    assert.ok(!r.deletedPaths.has('r1/plain-mod.ts'))
    assert.ok(r.revertedPaths.has('r1/plain-mod.ts'))
    assert.ok(r.revertedPaths.has('r1/gone.ts'))
    // 'D' 恢复：父目录列表新增条目 → 失效
    assert.ok(r.deletedParents.has('r1'))
    // 根仓库（"."）不产生 "./" 前缀
    const root = classifyDiscardEffects([{ path: 'x.ts', status: '?' }], '.', new Set())
    assert.ok(root.deletedPaths.has('x.ts') && root.deletedParents.has(''))
})

// ─────────────────────────────────────────────────────────────────────────────
// 第二轮审核补充回归（归属守护 / seq 后发者胜 / mutation 重拉仓库门控 / loadLog 清空时机）
// ─────────────────────────────────────────────────────────────────────────────

test('load 的同步归属守护：store 已归属别的 agent 时 no-op（不发起 fetch）', async () => {
    await setupSettings()
    const counts = { repos: 0, status: 0, log: 0 }
    mockRoutes({
        '/workspace/repos': () => { counts.repos++; return { repos: [] } },
        '/workspace/repo/status': () => { counts.status++; return { branch: 'main', upstream: null, head: 'h', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] } },
        '/workspace/repo/log': () => { counts.log++; return { commits: [] } },
    })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.ensureAgent('agentA')
    await git.loadRepos('agentA')
    await git.loadStatus('agentA', 'r1')
    await git.loadLog('agentA', 'r1')
    const before = { ...counts }

    // agent 切走后，旧组件的迟到续体（保存收尾等）不得发起任何请求、不得改状态
    git.ensureAgent('agentB')
    const statusRepoBefore = git.statusRepo
    await git.loadRepos('agentA')
    await git.loadStatus('agentA', 'r1')
    await git.loadLog('agentA', 'r1')

    assert.deepEqual(counts, before, '归属不符时 load 必须 no-op（0 次新请求）')
    assert.equal(git.statusRepo, statusRepoBefore, '同步 prologue 也不该写：statusRepo 不得被旧 agent 回写')
    assert.equal(git.statusRepo, null, 'ensureAgent(agentB) 已 reset：statusRepo 应为 null')
})

test('同 repo 并发 loadStatus：后发起者胜（慢的旧响应不覆盖新数据）', async () => {
    await setupSettings()
    let statusCalls = 0
    const pendings: Array<(v: Response) => void> = []
    globalThis.fetch = (async (url: string) => {
        if (url.includes('/workspace/repo/status')) {
            statusCalls++
            const n = statusCalls
            if (n === 1) {
                // 第一次（慢，旧意图）：挂起
                return new Promise(resolve => { pendings.push(resolve) })
            }
            // 第二次（快，新意图：discard 后重拉）：立即返回新数据
            return new Response(JSON.stringify({
                ok: true,
                payload: { branch: 'main', upstream: null, head: 'new', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] },
            }), { status: 200 })
        }
        return new Response('', { status: 500 })
    }) as any

    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.ensureAgent('coder')

    const slowOld = git.loadStatus('coder', 'r1')     // refresh=1 这类慢请求
    await git.loadStatus('coder', 'r1')               // discard 重拉（快）先落地
    assert.equal(git.status.value?.head, 'new', '新意图的数据应已落地')

    // 慢的旧响应后到：不得覆盖
    pendings[0]!(new Response(JSON.stringify({
        ok: true,
        payload: { branch: 'main', upstream: null, head: 'old', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] },
    }), { status: 200 }))
    await slowOld
    assert.equal(git.status.value?.head, 'new', '慢的旧响应必须被 seq 丢弃，不得回退到旧数据')
})

test('同 key 并发 loadRepos：后发起者胜（tab 重挂载的后发请求不丢数据）', async () => {
    await setupSettings()
    let reposCalls = 0
    const pendings: Array<(v: Response) => void> = []
    const repoList = (name: string) => new Response(JSON.stringify({
        ok: true,
        payload: { repos: [{ name, path: name, branch: 'main', head: null, dirty: 0, ahead: 0, behind: 0 }] },
    }), { status: 200 })
    globalThis.fetch = (async (url: string) => {
        if (url.includes('/workspace/repos')) {
            reposCalls++
            if (reposCalls === 1) {
                return new Promise(resolve => { pendings.push(resolve) })
            }
            return repoList('new-data')
        }
        return new Response('', { status: 500 })
    }) as any

    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.ensureAgent('coder')

    const slowOld = git.loadRepos('coder')
    await git.loadRepos('coder')
    assert.equal(git.repos.value[0]?.name, 'new-data')

    pendings[0]!(repoList('old-data'))
    await slowOld
    assert.equal(git.repos.value[0]?.name, 'new-data', '慢的旧 repos 响应不得覆盖新数据')
})

test('mutation 在飞期间切仓库：statusRepo 不被旧仓库回写（错位会导致错仓 stage/commit）', async () => {
    await setupSettings()
    const counts = { repos: 0, status: 0, discard: 0 }
    mockRoutes({
        '/workspace/repos': () => { counts.repos++; return { repos: [] } },
        '/workspace/repo/status': () => {
            counts.status++
            return { branch: 'main', upstream: null, head: 'h', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] }
        },
        '/workspace/repo/discard': () => {
            counts.discard++
            return { ok: true }
        },
    })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.ensureAgent('coder')
    // 用户先在 r1 上看过 status（statusRepo='r1'），然后发起 discard(r1)
    await git.loadStatus('coder', 'r1')
    const before = { ...counts }

    const p = git.discard('coder', 'r1', ['a.ts'])
    // discard 在飞：用户在 RepoSelector 切到 r2（onPickRepo → loadAll）
    await git.loadStatus('coder', 'r2')
    assert.equal(git.statusRepo, 'r2')
    await p

    assert.equal(counts.discard, before.discard + 1)
    assert.equal(counts.repos, before.repos + 1, 'repos 是 workspace 级，重拉不受仓库门控影响')
    assert.equal(counts.status, before.status + 1, 'r2 的 loadStatus 之外不得再为 r1 重拉 status')
    assert.equal(git.statusRepo, 'r2', 'statusRepo 不得被旧仓库回写（否则状态列表/选择器错位）')
})

test('commit 在飞期间切仓库：log/status 都不回拉旧仓库，repos 照拉', async () => {
    await setupSettings()
    const counts = { repos: 0, status: 0, log: 0, commit: 0 }
    mockRoutes({
        '/workspace/repos': () => { counts.repos++; return { repos: [] } },
        '/workspace/repo/status': () => { counts.status++; return { branch: 'main', upstream: null, head: 'h', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] } },
        '/workspace/repo/log': () => { counts.log++; return { commits: [] } },
        '/workspace/repo/commit': () => { counts.commit++; return { ok: true, head: 'abc1234', output: '' } },
    })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.ensureAgent('coder')
    await git.loadStatus('coder', 'r1')
    await git.loadLog('coder', 'r1')
    const before = { ...counts }

    const p = git.commit('coder', 'r1', 'msg')
    // commit 在飞：用户在 RepoSelector 切到 r2。真实路径 onPickRepo → loadAll 是
    // Promise.all 同时发起（同一 tick 置位 statusRepo/commitsRepo），测试必须
    // 同构：逐个 await 会制造「status 已切、log 未切」的中间态，真实代码不存在。
    const switching = Promise.all([
        git.loadStatus('coder', 'r2'),
        git.loadLog('coder', 'r2'),
    ])
    await p
    await switching

    assert.equal(counts.commit, before.commit + 1)
    assert.equal(counts.repos, before.repos + 1, 'repos 照拉（ahead/head 变了）')
    assert.equal(counts.status, before.status + 1, '只有 r2 的一次 loadStatus，r1 不得回拉')
    assert.equal(counts.log, before.log + 1, '只有 r2 的一次 loadLog，r1 不得回拉')
    assert.equal(git.statusRepo, 'r2')
    assert.equal(git.commitsRepo, 'r2')
})

test('loadLog 同仓库重拉不清列表（History 不闪空），切仓库清空', async () => {
    await setupSettings()
    let logCalls = 0
    mockRoutes({
        '/workspace/repo/log': () => {
            logCalls++
            return { commits: [{ sha: `s${logCalls}`, author: 'a', authorDate: 'd', subject: 'sub', body: '' }] }
        },
    })
    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.ensureAgent('coder')

    await git.loadLog('coder', 'r1')
    assert.equal(git.commits.value.length, 1)

    // 同仓库后台重拉（挂起中）：旧列表必须保留（tab 重挂载首屏零等待的契约）
    let hangCalls = 0
    let resolveHang: ((v: Response) => void) | null = null
    globalThis.fetch = (async (url: string) => {
        if (url.includes('/workspace/repo/log')) {
            hangCalls++
            if (hangCalls === 1) {
                // 第一次（重拉）：挂起；后续（切仓的第二次）立即返回
                return new Promise(resolve => { resolveHang = resolve })
            }
            return new Response(JSON.stringify({
                ok: true,
                payload: { commits: [{ sha: 's3', author: 'a', authorDate: 'd', subject: 'sub', body: '' }] },
            }), { status: 200 })
        }
        return new Response('', { status: 500 })
    }) as any
    const p = git.loadLog('coder', 'r1')
    assert.equal(git.commits.value.length, 1, '同仓库重拉在飞时不得清空旧列表（History 闪空回归）')
    resolveHang!(new Response(JSON.stringify({
        ok: true,
        payload: { commits: [{ sha: 's2', author: 'a', authorDate: 'd', subject: 'sub', body: '' }] },
    }), { status: 200 }))
    await p
    assert.equal(git.commits.value.length, 1)
    assert.equal(git.commits.value[0].sha, 's2')

    // 切仓库：旧数据对新视图无意义，立即清空（loading 态可见）
    const p2 = git.loadLog('coder', 'r2')
    assert.equal(git.commits.value.length, 0, '切仓库必须立即清空旧列表')
    await p2
})

test('翻页在飞时 log 重拉落地：旧翻页响应不得 append（边界重复防护）', async () => {
    await setupSettings()
    const commit = (sha: string) => ({ sha, author: 'a', authorDate: 'd', subject: 'sub', body: '' })
    const page = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => commit(`${prefix}${String(i + 1).padStart(3, '0')}`))
    let resolvePage: ((v: Response) => void) | null = null
    globalThis.fetch = (async (url: string) => {
        if (url.includes('/workspace/repo/log')) {
            const skip = Number(new URL(url).searchParams.get('skip') ?? '0')
            if (skip === 0) {
                // 重拉第一页：立即返回换血后的新数据
                return new Response(JSON.stringify({ ok: true, payload: { commits: page('new', 50) } }), { status: 200 })
            }
            // 翻页（skip=50）：挂起，模拟慢响应
            return new Promise(resolve => { resolvePage = resolve })
        }
        return new Response('', { status: 500 })
    }) as any

    const { useWorkspaceGit } = await import('../src/composables/useWorkspaceGit.ts')
    const git = useWorkspaceGit()
    git.reset()
    git.ensureAgent('coder')

    // 首屏第一页 50 条（满页 → hasMore=true，可以翻页）
    await git.loadLog('coder', 'r1')
    assert.equal(git.commits.value.length, 50)
    assert.equal(git.commitsHasMore.value, true)

    // 用户点「加载更多」（在飞挂起）→ 恰好 commit 完成，loadLog 重拉第一页落地
    const more = git.loadMoreLog('coder', 'r1')
    assert.equal(git.commitsLoading.value, true)
    await git.loadLog('coder', 'r1')
    assert.equal(git.commits.value.length, 50, '重拉落地后是新第一页')
    assert.equal(git.commits.value[0].sha, 'new001', '列表应已换血为重拉的新数据')

    // 旧翻页响应后到：不得 append 到已换血的列表（边界重复条目）
    resolvePage!(new Response(JSON.stringify({ ok: true, payload: { commits: page('old', 10) } }), { status: 200 }))
    await more
    assert.equal(git.commits.value.length, 50, '被 logSeq 作废的旧翻页响应不得 append（重复条目防护）')
    assert.equal(git.commits.value[0].sha, 'new001')
    assert.equal(git.commits.value[49].sha, 'new050')
    assert.equal(git.commitsLoading.value, false, 'loading 不得被作废请求的 finally 误清/残留')
})
