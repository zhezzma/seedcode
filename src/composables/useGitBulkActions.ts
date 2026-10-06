/**
 * Git 分组级批量动作（stage all / unstage all / discard all）的共享工厂。
 *
 * 入口有两处，行为必须完全一致：
 * - Git tab 分组头部按钮（WorkspaceTabGit）
 * - 面板空白处右键菜单（WorkspacePanel，Git tab 下）
 *
 * 仿 useWorkspaceRefresh 模式：组件各自实例化、以 getter 透入响应式归属
 * （agentId / 选中仓库调时读取），git / tree / viewer 底层是模块级单例。
 * discard 的磁盘副作用（树缓存失效 / viewer 重载关闭）也集中在这里：
 * 任何入口丢弃改动都不能留下幽灵树缓存或过期 viewer buffer。
 */
import { computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWorkspaceGit, repoJoin, classifyDiscardEffects } from './useWorkspaceGit'
import { useWorkspaceTree } from './useWorkspaceTree'
import { useWorkspaceViewer } from './useWorkspaceViewer'
import { useToast } from './useToast'
import { useConfirm } from './useConfirm'
import { runDiscardAllFlow } from './useGitFileActions'
import type { FileChange } from './workspace-api'

export interface GitBulkActionsArgs {
    /** 归属 agent 的 getter（组件持响应式 props，调时取最新值）。 */
    agentId: () => string
    /** 当前选中仓库 getter；null = 未选仓库，所有动作 no-op。 */
    repo: () => string | null
}

export function useGitBulkActions(args: GitBulkActionsArgs) {
    const git = useWorkspaceGit()
    const tree = useWorkspaceTree()
    const viewer = useWorkspaceViewer()
    const toast = useToast()
    const { confirm } = useConfirm()
    const { t } = useI18n()

    // ── 合并 unstaged + untracked：VSCode 风格，"工作区改动" 包含 tracked 修改 + 未跟踪。
    //    服务端仕然分两个数组（状态字符 ? vs M/A/D 区分）；UI 为合并显示。
    const unstagedAndUntracked = computed<FileChange[]>(() => {
        const s = git.status.value
        if (!s) return []
        return [...s.unstaged, ...s.untracked]
    })

    /** discard 前快照 staged 里 HEAD 中不存在的路径（'A' 新增 / 'R'/'C' 的新路径）。
     *  服务端对 tracked 一律 `restore --staged --worktree --source=HEAD`（源码明示
     *  「让 staged-add 文件也能被还原到不存在状态」，git 实测 AM 文件 discard 后
     *  连目录带文件被删）：这些文件 discard = 被删除，树/viewer 必须按删除处理，
     *  否则树缓存留幽灵条目、viewer 重开进 404。
     *  必须在 git.discard 之前取：discard 完成后 status 已重拉，staged 里的 'A' 行
     *  已消失，届时无从判别。 */
    function stagedAddsSnapshot(): Set<string> {
        const staged = git.status.value?.staged ?? []
        return new Set(
            staged
                .filter(c => c.status === 'A' || c.status === 'R' || c.status === 'C')
                .map(c => c.path),
        )
    }

    // ── discard 的磁盘副作用同步 ──
    // discard 不只改 git 状态：untracked 被删（Files tab 树缓存过期）、tracked 被还原
    // （viewer 若开着该文件，编辑器 buffer 已落后磁盘，继续保存会把刚丢弃的改动写回去）。
    // status / repos 的重拉由 store 的 discard() 自己负责，这里只处理树与 viewer。
    // repo 与 stagedAdds 由调用方闭包传入（与 git.discard 用的是同一时点）：await 期间
    // 用户可能切了仓库，args.repo() 的新值已不是被 discard 的仓库，用它算前缀会
    // 失效错目录 / 关错 viewer；stagedAdds 则必须在 discard 前快照——discard
    // 完成后 status 已重拉，staged 里的 'A' 行已消失。
    async function afterDiscard(changes: FileChange[], repo: string, stagedAdds: Set<string>) {
        // discard 的 await 期间可能已切 agent：此时树缓存/store 已归属新 agent，
        // 旧 agent 的路径失效与重拉会污染它们（viewer 是全局单槽，同理不能动）。
        if (git.currentAgentId !== args.agentId()) return
        if (!repo) return
        const { deletedPaths, deletedParents, revertedPaths } = classifyDiscardEffects(changes, repo, stagedAdds)
        // 树：失效受影响目录**及其祖先链**上已缓存（展开过）的目录并重拉，避免为没看过的
        // 目录付请求成本。
        // 为什么祖先也要失效：目录自身的缓存可能恰在它从磁盘消失期间被清掉（Files tab
        // 删除目录 → invalidatePrefix），此时持有过期列表（「该目录不存在」旧世界）的是
        // 最近已缓存祖先；restore 重建目录（git 实测：rm -rf 后 restore 连目录带文件
        // 重建）后不重拉祖先 → 幽灵缺失目录，直到手动刷新。
        for (const p of deletedParents) {
            for (let dir = p; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
                if (tree.entriesAt(dir) !== null || tree.isLoading(dir)) {
                    tree.invalidate(dir)
                    void tree.loadPath(args.agentId(), dir)
                }
                if (dir === '') break
            }
        }
        const cur = viewer.current.value
        if (cur?.type !== 'file') {
            // diff 型 viewer 对着被丢弃文件：untracked/unstaged diff 会停在旧内容，
            // 重开强制重拉（commit diff 不受 discard 影响；deleted 的 diff 重拉只会报错，直接关）。
            if (cur?.type === 'diff' && cur.mode !== 'commit' && cur.repo === repo) {
                const wsFile = repoJoin(repo, cur.file)
                if (deletedPaths.has(wsFile)) {
                    // 磁盘文件已删：dirty buffer 是唯一副本（同 file 分支），静默丢弃不可接受
                    if (viewer.dirty.value?.path === wsFile) {
                        const ok = await confirm(t('workspace.unsavedChanges'), t('common.confirm'))
                        if (!ok) return
                    }
                    viewer.close()
                } else if (revertedPaths.has(wsFile) && viewer.dirty.value?.path !== wsFile) {
                    // 无未保存改动才 close+reopen 强制重拉；dirty 时 buffer 权威高于磁盘
                    // （同 file 分支语义），是否覆盖 revert 后的文件由用户保存时决定。
                    viewer.close()
                    await nextTick()
                    viewer.openDiff({ repo: cur.repo, mode: cur.mode, file: cur.file, ref: cur.ref })
                }
            }
            return
        }
        // viewer 正看着被删的 untracked 文件 → 关闭（与 FileTreeNode.onDeleted 同语义：
        // 有未保存改动先确认——磁盘文件已删，buffer 是唯一副本，静默丢弃不可接受）
        if (deletedPaths.has(cur.path)) {
            if (viewer.dirty.value?.path === cur.path) {
                const ok = await confirm(t('workspace.unsavedChanges'), t('common.confirm'))
                if (!ok) return
            }
            viewer.close()
            return
        }
        // 看着被还原的 tracked 文件且无未保存改动 → close+open 强制重载。
        // 必须隔一个 nextTick：同 tick 内 close+open 两次 mutation 会被 Vue 批处理成一次
        // patch，v-if 从 true（旧对象）到 true（新对象）会保留组件实例 —— 不卸载、path
        // prop 不变、watcher 不触发，重拉完全不生效（运行时实验实证过）。
        // 有未保存改动时不动：用户的 buffer 权威高于磁盘，是否覆盖由用户保存时决定。
        // 代价是聊天区闪现一帧；若在意可改 nonce key 方案（openFile 带 force 序号）。
        if (revertedPaths.has(cur.path) && viewer.dirty.value?.path !== cur.path) {
            viewer.close()
            await nextTick()
            viewer.openFile(cur.path)
        }
    }

    // ── 分组级动作（stage all / unstage all / discard all） ──
    async function stageAll() {
        const repo = args.repo()
        const files = unstagedAndUntracked.value.map(c => c.path)
        if (!repo || files.length === 0) return
        try { await git.stage(args.agentId(), repo, files) }
        catch (e: any) { toast.error(`${t('workspace.git.stage')}: ${e?.message || e}`) }
    }

    async function unstageAll() {
        const repo = args.repo()
        const status = git.status.value
        if (!repo || !status || status.staged.length === 0) return
        try { await git.unstage(args.agentId(), repo) /* all */ }
        catch (e: any) { toast.error(`${t('workspace.git.unstage')}: ${e?.message || e}`) }
    }

    async function discardAll() {
        const repo = args.repo()
        const list = unstagedAndUntracked.value
        if (!repo || list.length === 0) return
        // 文案划分：全是 untracked 走删除文案提示，其他走「丢弃修改」提示。
        // 混合场景仍走「丢弃修改」（不会误导：该提示不说 untracked 会被保留）。
        const allUntracked = list.every(c => c.status === '?')
        await runDiscardAllFlow({
            count: list.length,
            kind: allUntracked ? 'untracked' : 'mixed',
            // 服务端内部会逐个分辨 tracked / untracked 走不同逻辑。
            onConfirmed: async () => {
                const stagedAdds = stagedAddsSnapshot()
                const r = await git.discard(args.agentId(), repo, list.map(c => c.path))
                if (r.stale) return
                await afterDiscard(list, repo, stagedAdds)
            },
        })
    }

    return { unstagedAndUntracked, stagedAddsSnapshot, afterDiscard, stageAll, unstageAll, discardAll }
}
