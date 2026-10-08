/**
 * Git Tab 的状态管理：
 *   - repos: 工作区下所有 git 仓库摘要
 *   - status: 当前选中仓库的 VSCode 风格三组分组
 *   - commits: 提交历史（支持 load more 翻页）
 *   - commitFiles: 每个 commit 展开后的文件列表（按 ref 缓存）
 *
 * 过期请求保护（三重）：
 *   - **agent 维度**：reset() 递增 `agentEpoch`；每个异步 load 起头时捕获当前 epoch，
 *     await 后比对——不匹配则丢弃响应。这覆盖跨 agent 切换场景。
 *   - **repo 维度**：load 起头时记录 `state.statusRepo / commitsRepo`；await 后比对——
 *     用户在同 agent 内切换仓库时，旧响应不会污染新仓库视图。
 *   - **时序维度（seq）**：同 key 并发请求「后发起者胜」。慢请求（refresh=1 要
 *     走网络 git fetch、多仓 repos 要跑 N 次 git status）先发出后返回时，可能
 *     覆盖已经落地的更新数据（如 discard 重拉的结果）。与树 store 的 entry seq
 *     同构：每次发起自增序号，await 后仅当自己仍是最新发起者才写状态。
 *
 * **归属守护（同步）**：loadRepos / loadStatus / loadLog 起头检查
 * `currentAgentId !== null && !== agentId` 时直接 no-op。旧组件的迟到续体
 * （如保存的收尾刷新）在 agent 切换后调用时，epoch 已是新值拦不住（起头才
 * 捕获 epoch），必须靠归属守护同步拦截。null = 从未 ensureAgent（测试/
 * 首用场景）→ 放行。
 *
 * 字段命名约定（重要）：
 *   - state 内部 boolean / error 字段统一用 `_` 前缀（`_reposLoading` / `_reposError` 等）
 *   - 对外 getter 暴露不带前缀的名字（`reposLoading.value` / `reposError.value` 等）
 *   - 这样 Object.assign(state, _methods) 时 _methods 的 getter 对象不会撞名覆盖 state 的 boolean
 *   - 浏览器实测教训：曾经因为同名导致 `state.reposLoading` 被 getter 对象覆盖，
 *     onMounted 的 `!git.reposLoading.value` 永远 false，loadRepos 第一次永远不触发。
 */
import { reactive } from 'vue'
import {
    fetchRepos, fetchStatus, fetchLog, fetchCommitFiles,
    stageFiles as apiStage, unstageFiles as apiUnstage,
    discardFiles as apiDiscard, commitChanges as apiCommit,
    syncRepo as apiSync,
    fetchTree as apiFetchTree,
    type RepoSummary, type RepoStatus, type CommitMeta, type CommitFile,
    type FileChange,
} from './workspace-api.ts'

const LOG_PAGE_SIZE = 50

interface GitState {
    _reposLoading: boolean
    _reposError: string | null
    reposData: RepoSummary[]

    _statusLoading: boolean
    _statusError: string | null
    statusData: RepoStatus | null
    statusRepo: string | null

    _commitsLoading: boolean
    _commitsError: string | null
    commitsData: CommitMeta[]
    commitsRepo: string | null
    _commitsHasMore: boolean

    commitFilesData: Record<string, CommitFile[]>
    commitFilesLoading: Record<string, boolean>
    /** History 面板中每个 commit 是否展开（显示改动文件列表）。
     *  提升到 store 是为了跨 panel 关闭/重开与 PC v-if 卸载重挂之后还能恢复。 */
    commitExpandedData: Record<string, boolean>

    /** 当前 cache 归属的 agentId。跨 agent 访问时由 ensureAgent 检查并主动清理。
     *  不另外包 getter；**约定仅 ensureAgent 写入**（事实上通过 Object.assign 后外部可读写，
     *  但任何其他写入都会破坏 INV-3（reset 不动 currentAgentId）的完整性。） */
    currentAgentId: string | null

    /** 每 repo 独立记忆的 commit message，在 viewer / tab 切换间保留，agent 切换时重置。 */
    commitMessages: Record<string, string>
    /** 工作区根目录的绝对路径（fetchTree('') 的 root），用于拼 git 文件的绝对路径。 */
    workspaceRootData: string | null
    /** 正在进行中的 mutation（stage / unstage / discard / commit）标记；
     *  UI 按钮 过期间禁用，避免重复点击并发 git 命令。 */
    _mutating: boolean
}

const state = reactive<GitState>({
    _reposLoading: false,
    _reposError: null,
    reposData: [],
    _statusLoading: false,
    _statusError: null,
    statusData: null,
    statusRepo: null,
    _commitsLoading: false,
    _commitsError: null,
    commitsData: [],
    commitsRepo: null,
    _commitsHasMore: true,
    commitFilesData: {},
    commitFilesLoading: {},
    commitExpandedData: {},
    currentAgentId: null,
    commitMessages: {},
    workspaceRootData: null,
    _mutating: false,
})

// agent 级 epoch：每次 reset() 自增；异步 load 通过比对 epoch 丢弃跨 agent 的旧响应
let agentEpoch = 0

// 同 key 并发 load 的「后发起者胜」序号（与树 store 的 entry seq 同构）。
// 跨 agent 由 epoch、跨 repo 由 statusRepo/commitsRepo 兜底，这里只管同 key 并发。
let reposSeq = 0
let statusSeq = 0
let logSeq = 0

/** 提交历史右键“复制提交信息”的纯格式化逻辑；body 为可选字段，缺省时不输出 Body 行。 */
export function formatCommitInfo(commit: CommitMeta): string {
    const lines = [
        `Commit: ${commit.sha}`,
        `Author: ${commit.author}`,
        `Date: ${commit.authorDate}`,
        `Subject: ${commit.subject}`,
    ]
    // 正文为空时不输出 Body 行，避免在单行提交后多一行噪声。
    if (commit.body) lines.push(`Body: ${commit.body}`)
    return lines.join('\n')
}

/** repo 相对路径前缀：根仓库（"."）不产生 "./" 前缀 */
export function repoJoin(repo: string, filePath: string): string {
    return repo === '.' ? filePath : `${repo}/${filePath}`
}

/** discard 对磁盘/树/viewer 的副作用分类（纯函数，供 afterDiscard 消费 + 单测）。
 *
 * 服务端 discard 契约（seedagent workspace.ts，实测验证）：
 * - untracked（'?'）→ 直接删文件
 * - tracked（在 index 里，含 staged-add）→ `git restore --staged --worktree --source=HEAD`
 *   —— 源码明示「让 staged-add 文件也能被还原到不存在状态」：staged 'A'/'R'/'C'
 *   的新路径不在 HEAD 里，discard 后**文件被删除**（不是还原！）。
 *   但这类文件的 unstaged 行 status 是 'M'/'D'，与普通 tracked 无从区分，必须靠
 *   调用方在 discard 前快照的 stagedAdds（staged 组里 HEAD 不存在的路径集合）判别。
 *
 * 分类结果：
 * - deletedPaths：磁盘上文件消失 → viewer 直接关（不重开，重开必 404）；
 *   父目录进 deletedParents（列表少了条目）
 * - revertedPaths：文件被还原但仍在磁盘 → viewer close+nextTick+open 强制重载
 * - deletedParents：磁盘列表发生变化的目录（删除条目 / 恢复条目），树缓存失效单位
 */
export function classifyDiscardEffects(
    changes: FileChange[],
    repo: string,
    stagedAdds: Set<string>,
): { deletedPaths: Set<string>; deletedParents: Set<string>; revertedPaths: Set<string> } {
    const deletedPaths = new Set<string>()
    const deletedParents = new Set<string>()
    const revertedPaths = new Set<string>()
    for (const c of changes) {
        const wsRel = repoJoin(repo, c.path)
        const i = wsRel.lastIndexOf('/')
        const parent = i === -1 ? '' : wsRel.slice(0, i)
        if (c.status === '?' || stagedAdds.has(c.path)) {
            deletedPaths.add(wsRel)
            deletedParents.add(parent)
        } else {
            revertedPaths.add(wsRel)
            // tracked 'D'（工作区已删除）discard = git restore 把文件恢复回磁盘，
            // 父目录列表会**新增**条目：若缓存是在文件被删后拉的，恢复后不失效
            // 会看不到这个文件（幽灵缺失，与删除对称）。
            if (c.status === 'D') {
                deletedParents.add(parent)
            }
        }
    }
    return { deletedPaths, deletedParents, revertedPaths }
}

// 使用 getter 对象而非 computed：
// reactive(state) 上 Object.assign computed 会被 Vue 在 set 时 auto-unwrap，
// 导致 panel.repos.value 为 undefined。getter 保证渲染调用者仍能跟踪 reactive 依赖。
//
// **关键**：getter 名字必须与 state 字段名不同，否则 Object.assign 会用 getter 对象
// 覆盖 state 的原始字段（见文件头注释中的"字段命名约定"）。
/** 归属守护的公共判定：store 已归属别的 agent（旧组件的迟到续体）→ 不放行。
 *  null = 从未 ensureAgent（测试/首用）→ 放行。 */
function ownedBy(agentId: string): boolean {
    return state.currentAgentId === null || state.currentAgentId === agentId
}

const _methods = {
    repos: { get value() { return state.reposData } },
    reposLoading: { get value() { return state._reposLoading } },
    reposError: { get value() { return state._reposError } },

    status: { get value() { return state.statusData } },
    statusLoading: { get value() { return state._statusLoading } },
    statusError: { get value() { return state._statusError } },

    commits: { get value() { return state.commitsData } },
    commitsLoading: { get value() { return state._commitsLoading } },
    commitsError: { get value() { return state._commitsError } },
    commitsHasMore: { get value() { return state._commitsHasMore } },

    commitFiles: { get value() { return state.commitFilesData } },
    commitExpanded: { get value() { return state.commitExpandedData } },

    /** 工作区根目录绝对路径（供 git 文件拼接绝对路径用）。 */
    workspaceRoot: { get value() { return state.workspaceRootData } },

    /** 切换指定 commit 的展开状态。返回切换后是否为展开（调用方据此决定是否要 loadCommitFiles）。 */
    toggleCommitExpanded(sha: string): boolean {
        const next = !state.commitExpandedData[sha]
        state.commitExpandedData[sha] = next
        return next
    },

    mutating: { get value() { return state._mutating } },

    /** 获取指定 repo 的 commit message（不存在返回空串）。 */
    getCommitMessage(repo: string): string {
        return state.commitMessages[repo] ?? ''
    },
    /** 写入指定 repo 的 commit message。 */
    setCommitMessage(repo: string, msg: string) {
        state.commitMessages[repo] = msg
    },

    reset() {
        agentEpoch++
        state.reposData = []
        state._reposError = null
        state._reposLoading = false
        state.statusData = null
        state._statusError = null
        state._statusLoading = false
        state.statusRepo = null
        state.commitsData = []
        state._commitsError = null
        state._commitsLoading = false
        state.commitsRepo = null
        state._commitsHasMore = true
        state.commitFilesData = {}
        state.commitFilesLoading = {}
        state.commitExpandedData = {}
        state.commitMessages = {}
        state.workspaceRootData = null
        state._mutating = false
    },

    /** 按 agentId 守护 store 数据归属：不匹配则 reset 并记录新 agentId。
     *  调用点：WorkspacePanel setup 同步调用 + agentId watch 回调。
     *  这里是唯一会写 currentAgentId 的地方：reset() 不动它，避免外部调用 reset 后状态脱同步。 */
    ensureAgent(agentId: string) {
        if (state.currentAgentId === agentId) return
        this.reset()
        state.currentAgentId = agentId
    },

    async loadRepos(agentId: string, opts?: { refresh?: boolean }) {
        if (!ownedBy(agentId)) return
        const myEpoch = agentEpoch
        const mySeq = ++reposSeq
        state._reposLoading = true
        state._reposError = null
        try {
            const r = await fetchRepos(agentId, opts)
            if (myEpoch !== agentEpoch || mySeq !== reposSeq) return
            state.reposData = r.repos
        } catch (err: any) {
            if (myEpoch !== agentEpoch || mySeq !== reposSeq) return
            state._reposError = err?.message || String(err)
        } finally {
            if (myEpoch === agentEpoch && mySeq === reposSeq) state._reposLoading = false
        }
    },

    /** status 是选中仓库的最新事实（含 refresh=1 刷过的真实远程 behind/ahead），
     *  回填 /repos 摘要对应条目：RepoSelector 徽章即时跟上（提交/暂存后的 dirty、
     *  刷新后的 behind 都不用等下一次 loadRepos）。 */
    syncRepoSummary(repo: string, r: RepoStatus) {
        const entry = state.reposData.find((e) => e.path === repo)
        if (!entry) return
        entry.branch = r.branch
        entry.head = r.head
        entry.ahead = r.ahead
        entry.behind = r.behind
        // 与服务端 /repos 的 dirty 语义一致：去重后的变更路径数
        entry.dirty = new Set([...r.staged, ...r.unstaged, ...r.untracked].map((fc) => fc.path)).size
    },

    async loadStatus(agentId: string, repo: string, opts?: { refresh?: boolean }) {
        if (!ownedBy(agentId)) return
        const myEpoch = agentEpoch
        const mySeq = ++statusSeq
        state._statusLoading = true
        state._statusError = null
        state.statusRepo = repo
        try {
            const r = await fetchStatus(agentId, repo, opts)
            if (myEpoch !== agentEpoch || mySeq !== statusSeq) return
            // 同 agent 内仓库切换的过期保护
            if (state.statusRepo === repo) {
                state.statusData = r
                // 回填 /repos 摘要：下拉徽章即时跟上最新事实（含 mutation 后的不带 refresh 重载）
                this.syncRepoSummary(repo, r)
            }
        } catch (err: any) {
            if (myEpoch !== agentEpoch || mySeq !== statusSeq) return
            if (state.statusRepo === repo) state._statusError = err?.message || String(err)
        } finally {
            if (myEpoch === agentEpoch && mySeq === statusSeq && state.statusRepo === repo) state._statusLoading = false
        }
    },

    async loadLog(agentId: string, repo: string) {
        if (!ownedBy(agentId)) return
        const myEpoch = agentEpoch
        const mySeq = ++logSeq
        state._commitsLoading = true
        state._commitsError = null
        // 仅在切仓库时清空列表：同仓库后台重拉（tab 重挂载）保留旧数据避免 History
        // 闪空；切仓库时旧数据对新视图无意义，清空让 loading 态可见（与 statusData
        // 的保留策略对齐——status 本来就不清）。
        if (state.commitsRepo !== repo) {
            state.commitsData = []
            state._commitsHasMore = true
        }
        state.commitsRepo = repo
        try {
            const r = await fetchLog(agentId, repo, { limit: LOG_PAGE_SIZE, skip: 0 })
            if (myEpoch !== agentEpoch || mySeq !== logSeq) return
            if (state.commitsRepo === repo) {
                state.commitsData = r.commits
                state._commitsHasMore = r.commits.length === LOG_PAGE_SIZE
            }
        } catch (err: any) {
            if (myEpoch !== agentEpoch || mySeq !== logSeq) return
            if (state.commitsRepo === repo) state._commitsError = err?.message || String(err)
        } finally {
            if (myEpoch === agentEpoch && mySeq === logSeq && state.commitsRepo === repo) state._commitsLoading = false
        }
    },

    async loadMoreLog(agentId: string, repo: string) {
        if (!ownedBy(agentId)) return
        if (!state._commitsHasMore || state._commitsLoading) return
        if (state.commitsRepo !== repo) return
        const myEpoch = agentEpoch
        // 翻页同样参与 logSeq：翻页在飞时 commit/sync 会触发 loadLog 重拉（第一页
        // 换血），旧翻页响应后到若仍 append，会在新列表边界拼出重复条目。后发起者
        // 胜——重拉作废在飞翻页；反向（loadLog 在飞）由 _commitsLoading 早退互斥。
        const mySeq = ++logSeq
        state._commitsLoading = true
        try {
            const r = await fetchLog(agentId, repo, { limit: LOG_PAGE_SIZE, skip: state.commitsData.length })
            if (myEpoch !== agentEpoch || mySeq !== logSeq) return
            if (state.commitsRepo === repo) {
                state.commitsData = [...state.commitsData, ...r.commits]
                state._commitsHasMore = r.commits.length === LOG_PAGE_SIZE
            }
        } catch (err: any) {
            if (myEpoch !== agentEpoch || mySeq !== logSeq) return
            if (state.commitsRepo === repo) state._commitsError = err?.message || String(err)
        } finally {
            if (myEpoch === agentEpoch && mySeq === logSeq && state.commitsRepo === repo) state._commitsLoading = false
        }
    },

    async loadCommitFiles(agentId: string, repo: string, ref: string): Promise<CommitFile[]> {
        if (state.commitFilesData[ref]) return state.commitFilesData[ref]
        if (state.commitFilesLoading[ref]) return []
        // 归属守护：迟到续体不在新 owner 的 store 上登记 loading（finally 被 epoch
        // 守卫跳过后会永久卡在 true，同 ref 再也拉不了）
        if (!ownedBy(agentId)) return []
        const myEpoch = agentEpoch
        state.commitFilesLoading[ref] = true
        try {
            const r = await fetchCommitFiles(agentId, repo, ref)
            if (myEpoch !== agentEpoch) return []
            state.commitFilesData[ref] = r.files
            return r.files
        } catch {
            return []
        } finally {
            if (myEpoch === agentEpoch) state.commitFilesLoading[ref] = false
        }
    },

    isCommitFilesLoading(ref: string): boolean {
        return state.commitFilesLoading[ref] === true
    },

    /** 拉工作区根目录绝对路径（fetchTree('') 的 root）。跨 agent epoch 护栏与其它 load 一致。 */
    async loadWorkspaceRoot(agentId: string) {
        if (state.workspaceRootData) return
        if (!ownedBy(agentId)) return
        const myEpoch = agentEpoch
        try {
            const r = await apiFetchTree(agentId, '')
            if (myEpoch !== agentEpoch) return
            state.workspaceRootData = r.root
        } catch {
            // 拿不到 root 时保持 null：复制绝对路径会退回相对路径（buildAbsolutePath 的缺省分支）
        }
    },

    // ── Mutation：stage / unstage / discard / commit ──
    // 所有 mutation 退出后重拉 status；commit / sync 额外重拉 log；
    // discard / commit / sync 额外重拉 repos（RepoSelector 下拉菜单的数据源）。
    // stage / unstage 特意不拉 repos：服务端 dirty = staged+unstaged+untracked 的
    // 去重路径总数，stage 只是把同批文件在桶间搬家，总数不变（省 N 仓 git status）。
    // 错误上抛让调用者决定怎么处理（toast / 保留输入等）。
    // _mutating 冲突一律 throw（不静默 return）：行级按钮没有 disabled 态，
    // 静默吞操作会让用户以为成功；调用方的 catch 会 toast，且 discard 的
    // afterDiscard 副作用钩子依赖「discard 确实发生了」这个前提。
    //
    // Epoch 护栏：跟 loadStatus 同样的模式 — 起手记 myEpoch，api await 后比对；
    // 不匹配（agent 中途切换 → reset() 走过）则不会再走后续重拉，避免把旧 agent
    // 的 status 写进新 agent 的 reactive state（两个 agent 同名 repo 同路径时会发生）。
    //
    // **重拉仓库门控**：RepoSelector 在 mutation 在飞期间不禁用，用户可能已切到
    // 别的仓库。此时若仍用起手捕获的旧仓库重拉，loadStatus 起头的同步赋值会把
    // statusRepo 拉回旧仓库，新仓库的在飞响应被 repo 守卫丢弃 → 最终态变成
    // 「选择器/历史 = 新仓库、状态列表 = 旧仓库」的错位：canCommit 的 stagedCount
    // 与 onCommit 的 repo 各属一仓，可能对错误仓库提交/暂存。用户已切走时不打扰
    // （null = 从未看过 status，重拉无妨）；切回旧仓库时 onPickRepo → loadAll
    // 自然拉到最新。
    async stage(agentId: string, repo: string, files?: string[]): Promise<void> {
        if (state._mutating) throw new Error('mutation in progress')
        const myEpoch = agentEpoch
        state._mutating = true
        try {
            await apiStage(agentId, repo, files)
            if (myEpoch !== agentEpoch) return
            if (state.statusRepo === null || state.statusRepo === repo) {
                await _gitState.loadStatus(agentId, repo)
            }
        } finally {
            if (myEpoch === agentEpoch) state._mutating = false
        }
    },
    async unstage(agentId: string, repo: string, files?: string[]): Promise<void> {
        if (state._mutating) throw new Error('mutation in progress')
        const myEpoch = agentEpoch
        state._mutating = true
        try {
            await apiUnstage(agentId, repo, files)
            if (myEpoch !== agentEpoch) return
            if (state.statusRepo === null || state.statusRepo === repo) {
                await _gitState.loadStatus(agentId, repo)
            }
        } finally {
            if (myEpoch === agentEpoch) state._mutating = false
        }
    },
    async discard(agentId: string, repo: string, files?: string[]): Promise<{ stale?: boolean }> {
        if (state._mutating) throw new Error('mutation in progress')
        const myEpoch = agentEpoch
        state._mutating = true
        try {
            await apiDiscard(agentId, repo, files)
            // 与 commit / sync 同契约：epoch 失配说明中途发生了 reset（切 agent 或同
            // agent 改绑 workspace——reset 不动 currentAgentId，组件层的归属复查拦不住
            // 改绑场景）。此时树缓存 / viewer 已指向新世界，caller 的 afterDiscard
            //（失效目录 / 关 viewer）必须凭 stale 跳过，不能按旧 workspace 的路径表执行。
            if (myEpoch !== agentEpoch) return { stale: true }
            // discard 真改 worktree（tracked 还原 / untracked 删除）→ dirty 总数变化 → repos 同步
            const jobs: Promise<unknown>[] = [_gitState.loadRepos(agentId)]
            if (state.statusRepo === null || state.statusRepo === repo) {
                jobs.push(_gitState.loadStatus(agentId, repo))
            }
            await Promise.all(jobs)
            return {}
        } finally {
            if (myEpoch === agentEpoch) state._mutating = false
        }
    },
    async commit(agentId: string, repo: string, message: string): Promise<{ head: string | null; stale?: boolean }> {
        if (state._mutating) throw new Error('mutation in progress')
        const myEpoch = agentEpoch
        state._mutating = true
        try {
            const r = await apiCommit(agentId, repo, message)
            // commit 在服务端已成功，返回 head 让 caller toast。但 agent 变了不要写 reactive state，
            // stale=true 让 caller 跳过 toast（在别的 agent 界面弹旧 agent 的提交成功会误导归属）。
            if (myEpoch !== agentEpoch) return { head: r.head, stale: true }
            // 提交成功：清 message + 重拉 status + log + repos。
            // repos 是 RepoSelector 下拉菜单 / 顶部摘要的数据源：提交后 dirty 减少、
            // ahead+1、head 前移，不重拉的话下拉菜单永远停在提交前的旧值。
            delete state.commitMessages[repo]
            const jobs: Promise<unknown>[] = [_gitState.loadRepos(agentId)]
            if (state.statusRepo === null || state.statusRepo === repo) {
                jobs.push(_gitState.loadStatus(agentId, repo))
            }
            if (state.commitsRepo === null || state.commitsRepo === repo) {
                jobs.push(_gitState.loadLog(agentId, repo))
            }
            await Promise.all(jobs)
            return { head: r.head }
        } finally {
            if (myEpoch === agentEpoch) state._mutating = false
        }
    },
    /** workspace 磁盘被 Git tab 之外的方式改动后（Files tab 新建/删除/改名/上传、
     *  编辑器保存）的通知入口：按「Git tab 是否打开过」决定重拉范围——
     *  repos 非空才拉 repos、statusRepo 已设才拉 status，没看过 Git tab 就零成本。
     *  跨 agent 访问直接 no-op（store 已归属别的 agent）。fire-and-forget 语义。 */
    async refreshWorktreeState(agentId: string): Promise<void> {
        if (state.currentAgentId !== agentId) return
        const jobs: Promise<unknown>[] = []
        if (state.reposData.length > 0) jobs.push(_gitState.loadRepos(agentId))
        if (state.statusRepo !== null) jobs.push(_gitState.loadStatus(agentId, state.statusRepo))
        await Promise.all(jobs)
    },

    async sync(agentId: string, repo: string): Promise<{ head: string | null; pushed: boolean; stale?: boolean }> {
        if (state._mutating) throw new Error('mutation in progress')
        const myEpoch = agentEpoch
        state._mutating = true
        try {
            const r = await apiSync(agentId, repo)
            if (myEpoch !== agentEpoch) return { head: r.head, pushed: r.pushed, stale: true }
            // 同步可能改变 HEAD（pull 合并远程）、历史与 ahead/behind → 重拉 status + log + repos
            // （不拉 repos 的话下拉菜单的 ↑/↓ 徽标与 branch 摘要停在同步前）
            const jobs: Promise<unknown>[] = [_gitState.loadRepos(agentId)]
            if (state.statusRepo === null || state.statusRepo === repo) {
                jobs.push(_gitState.loadStatus(agentId, repo))
            }
            if (state.commitsRepo === null || state.commitsRepo === repo) {
                jobs.push(_gitState.loadLog(agentId, repo))
            }
            await Promise.all(jobs)
            return { head: r.head, pushed: r.pushed }
        } finally {
            if (myEpoch === agentEpoch) state._mutating = false
        }
    },
}

// 状态与接口合并；getter 对象不是 ref，Vue 不会对其 unwrap。
// 不会冲突的字段（`statusRepo` / `commitsRepo` / `reposData` / `statusData` / `commitsData` /
// `commitFilesData` / `commitFilesLoading` / `commitExpandedData` / `currentAgentId`）保持原名直接通过 _gitState 访问。
const _gitState = Object.assign(state, _methods)

export const useWorkspaceGit = () => _gitState
