/**
 * 编辑器保存工作区文件后的 git 刷新通知（fire-and-forget）。
 *
 * 提取自 WorkspaceFileView.save 的内联门控；unstaged diff 视图可编辑后
 * （WorkspaceDiffEditor.save）需要同一段逻辑 → 抽共用纯函数。
 * 与 useWorkspaceGit.refreshWorktreeState 的"磁盘变了就全刷"不同：这里按
 * path 归属精细门控，保存仓库外的 scratch 文件零成本。
 *
 * 零依赖设计：git store 由调用方透入（结构化类型，不 import composable），
 * node --test 可直接加载单测（composables 下的模块依赖链不带 .ts 扩展名）。
 */

/** notifyGitFileSaved 透入的 git store 最小面（useWorkspaceGit 返回值的子集）。 */
export interface GitSaveRefreshStore {
    /** 当前打开 status 的 repo；null = Git tab 未打开过。 */
    statusRepo: string | null
    /** 已加载的 repo 列表（RepoSelector 下拉的 dirty 徽标数据源）。 */
    repos: { value: { path: string }[] }
    loadStatus(agentId: string, repo: string): Promise<unknown>
    loadRepos(agentId: string): Promise<unknown>
}

/** path 是否归属 repo。repo === '.' 表示 workspace 根本身是个 repo（服务端
 *  emit relPath "."）→ 任何 workspace 文件都属于它；严格前缀匹配避免 'foo'
 *  误匹 'foobar'；path === repo 作为防御性分支保留。 */
export function pathBelongsToRepo(path: string, repo: string): boolean {
    return repo === '.' || path === repo || path.startsWith(repo + '/')
}

/** 保存工作区文件后按归属门控刷新 git status / repos。
 *  - status：仅当 path 归属 git.statusRepo 时重拉；statusRepo 为 null 时不主动拉
 *    —— 用户没看 Git tab 就不付出代价。
 *  - repos：仅当 path 归属任一已加载 repo 时重拉。
 *  均 fire-and-forget：save 的语义是"保存成功"，不被刷新阻塞。 */
export function notifyGitFileSaved(args: {
    git: GitSaveRefreshStore
    agentId: string
    path: string
}): void {
    const { git, agentId, path } = args
    const repo = git.statusRepo
    if (repo !== null && pathBelongsToRepo(path, repo)) {
        void git.loadStatus(agentId, repo)
    }
    if (git.repos.value.some(r => pathBelongsToRepo(path, r.path))) {
        void git.loadRepos(agentId)
    }
}
