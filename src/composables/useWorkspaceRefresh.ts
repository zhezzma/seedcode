/**
 * Workspace 面板全量刷新（原面板顶部 🔄 按钮的逻辑；按钮已删，入口改为：
 * 面板右键菜单「刷新」 / Files tab 空白左键 / 文件行菜单「刷新」）。
 *
 * 独立成模块的原因：useWorkspaceTree / useWorkspaceGit / useAgentFiles 都依赖
 * useWorkspacePanel，把本逻辑塞进 useWorkspacePanel 会形成 import 环；
 * 单独一个文件对它们只有单向依赖。
 */
import { ref } from 'vue'
import { useWorkspacePanel } from './useWorkspacePanel'
import { useWorkspaceTree } from './useWorkspaceTree'
import { useWorkspaceGit } from './useWorkspaceGit'
import { useAgentFiles } from './useAgentFiles'

export function useWorkspaceRefresh() {
    const panel = useWorkspacePanel()
    const tree = useWorkspaceTree()
    const git = useWorkspaceGit()
    const agentFiles = useAgentFiles()

    // isRefreshing 仅作 UI 状态（移动端 🔄 转圈）：不去重、不拦截 ——
    // 连点即连发，并发安全由各 store 的 seq「后发者胜」保证（旧响应丢弃）
    const isRefreshing = ref(false)

    /**
     * 全量刷新。spec §6.4:
     * - Files tab 下：保留 expanded 路径，refresh 后并发重拉，避免用户辛苦展开的深层目录折叠回去
     * - Git tab 下：先 await loadRepos 拿最新列表，再决定当前 repo 是否还有效（避免对外部已删除的 repo 拉数据）
     *
     * @param agentId        快照：本次刷新归属的 agent
     * @param getLiveAgentId 调用方持有响应式 agentId 时传入，用于检测刷新中途切 agent
     *                       （loadPath 自带归属守护兜底，这里只是提前止损）
     */
    async function refreshAll(agentId: string, getLiveAgentId?: () => string) {
        isRefreshing.value = true
        const stale = () => !!getLiveAgentId && getLiveAgentId() !== agentId
        try {
            if (panel.activeTab.value === 'files') {
                const expandedPaths = tree.expandedPaths()
                tree.refresh()
                await tree.loadPath(agentId, '')
                if (stale()) return
                await Promise.all(expandedPaths.map(p => tree.loadPath(agentId, p)))
                if (stale()) return
                // 底部 agent 文件区只在展开时才重拉，避免隐式快照过鲜
                if (panel.bottomSections.value.agentFiles) {
                    const agentExpanded = agentFiles.expandedPaths()
                    agentFiles.refresh()
                    await agentFiles.loadPath(agentId, '')
                    await Promise.all(agentExpanded.map(p => agentFiles.loadPath(agentId, p)))
                }
            } else {
                // 手动刷新是用户显式要最新状态：repos 带 refresh=1 让服务端刷各仓 upstream
                await git.loadRepos(agentId, { refresh: true })
                if (stale()) return
                let repo = panel.getRepoForAgent(agentId)
                // 只在没有选择时回退 repos[0]；显式选过的仓库即使不在列表（嵌套仓库）
                // 也保留 —— 与 WorkspaceTabGit.onMounted 同语义。
                if (!repo) {
                    repo = git.repos.value[0]?.path ?? null
                    if (repo) panel.setRepoForAgent(agentId, repo)
                }
                if (repo) {
                    await Promise.all([
                        // 手动刷新显式带 refresh=1：服务端先 git fetch 刷 upstream，
                        // 否则 ↓behind 永远基于本地过期的 remote-tracking ref。
                        git.loadStatus(agentId, repo, { refresh: true }),
                        git.loadLog(agentId, repo),
                    ])
                }
            }
        } finally {
            isRefreshing.value = false
        }
    }

    return { isRefreshing, refreshAll }
}
