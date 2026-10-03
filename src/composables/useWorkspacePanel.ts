/**
 * Workspace 面板的全局状态：开关、宽度、tab 选中、每个 agent 最近一次选中的仓库。
 *
 * 持久化通过 useUiSettingsStore，重启/刷新后状态保留。
 *
 * 实现说明（factory 模式）：
 * - 每次 useWorkspacePanel() 都创建新一组 computed，绑定到当前 active pinia。
 * - 这与 useToast / useChatInput 的"模块级 Object.assign"不同——后者不依赖 pinia
 *   的 reactive proxy，可以单例；本 composable 必须每次创建以避免跨 setActivePinia
 *   生命周期的依赖陷阱（旧 computed 仍跟踪旧 store 实例）。
 */
import { computed } from 'vue'
import { useUiSettingsStore } from '../stores/setting.ts'

export const PANEL_MIN_WIDTH = 240
export const PANEL_MAX_WIDTH = 1000
export const PANEL_DEFAULT_WIDTH = 360
/** Git tab 提交历史区高度的可拖动下限；上限由 CollapsibleSection 按父容器高度动态 clamp。 */
export const HISTORY_MIN_HEIGHT = 100

function persistPanel(patch: Partial<{
    open: boolean
    width: number
    tab: 'files' | 'git'
    historyHeight: number
    bottomSections: Partial<{ history: boolean; agentFiles: boolean }>
    statusGroups: Partial<{ staged: boolean; unstaged: boolean }>
}>) {
    const store = useUiSettingsStore()
    // 先从 patch 中抽出子对象（Partial），才能合并为完整类型。
    const { bottomSections: bsPatch, statusGroups: sgPatch, ...rest } = patch
    const next = {
        ...store.workspacePanel,
        ...rest,
        bottomSections: bsPatch
            ? { ...store.workspacePanel.bottomSections, ...bsPatch }
            : store.workspacePanel.bottomSections,
        statusGroups: sgPatch
            ? { ...store.workspacePanel.statusGroups, ...sgPatch }
            : store.workspacePanel.statusGroups,
    }
    store.workspacePanel = next
    store.persist()
}

export function useWorkspacePanel() {
    const store = useUiSettingsStore()
    return {
        isOpen: computed(() => store.workspacePanel.open),
        width: computed(() => {
            const w = store.workspacePanel.width
            return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, w))
        }),
        activeTab: computed(() => store.workspacePanel.tab),

        open() { persistPanel({ open: true }) },
        close() { persistPanel({ open: false }) },
        toggle() { persistPanel({ open: !store.workspacePanel.open }) },

        setWidth(w: number) {
            const clamped = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.round(w)))
            persistPanel({ width: clamped })
        },
        resetWidth() { persistPanel({ width: PANEL_DEFAULT_WIDTH }) },

        setTab(tab: 'files' | 'git') { persistPanel({ tab }) },

        // 提交历史区高度：getter clamp 兼底旧持久化数据里的非法值（缺键/null 走默认 240）。
        historyHeight: computed(() => {
            const h = store.workspacePanel.historyHeight
            return Math.max(HISTORY_MIN_HEIGHT, Math.round(typeof h === 'number' ? h : 240))
        }),
        setHistoryHeight(h: number) {
            persistPanel({ historyHeight: Math.max(HISTORY_MIN_HEIGHT, Math.round(h)) })
        },

        setRepoForAgent(agentId: string, repo: string) {
            const repoByAgent = { ...store.workspacePanel.repoByAgent, [agentId]: repo }
            store.workspacePanel = { ...store.workspacePanel, repoByAgent }
            store.persist()
        },
        getRepoForAgent(agentId: string): string | null {
            return store.workspacePanel.repoByAgent[agentId] ?? null
        },
        /** 清除 agent 记住的仓库选择：改绑 workspace 后旧选择指向的是旧 workspace
         *  里的仓库，已无意义，不清会让 Git tab 对着旧路径报错。 */
        clearRepoForAgent(agentId: string) {
            if (!(agentId in store.workspacePanel.repoByAgent)) return
            const repoByAgent = { ...store.workspacePanel.repoByAgent }
            delete repoByAgent[agentId]
            store.workspacePanel = { ...store.workspacePanel, repoByAgent }
            store.persist()
        },

        // 跳出可折叠区域的开关状态与 setter，供 WorkspaceTabFiles / WorkspaceTabGit 使用。
        // 快照为 computed，避免组件直接依赖 store 实例的 reactive proxy。
        bottomSections: computed(() => store.workspacePanel.bottomSections),
        setBottomSection(key: 'history' | 'agentFiles', open: boolean) {
            persistPanel({ bottomSections: { [key]: open } })
        },

        statusGroups: computed(() => store.workspacePanel.statusGroups),
        setStatusGroup(key: 'staged' | 'unstaged', open: boolean) {
            persistPanel({ statusGroups: { [key]: open } })
        },
    }
}
