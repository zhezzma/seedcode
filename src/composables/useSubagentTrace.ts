/**
 * 子代理轨迹查看器（SubagentTraceDrawer）全局状态。
 *
 * 与 useWorkspaceViewer 同模式：模块级单例状态，ToolInvocation 卡片按钮直接
 * open()，抽屉组件在 HomeView 挂载一次读状态——避免穿 3 层组件 emit 事件链。
 *
 * open() 传入的 results 是 details 快照（每次 emitUpdate 都是新对象），
 * 抽屉的实时性不依赖它：轨迹增量走 ext.subagent_trace 推送线（慢速对账兜底），快照仅用于 Tab 标签与状态徽标。
 */
import { computed, ref } from 'vue'

export interface SubagentTraceTarget {
    /** 主 session id（定位 DATA_DIR/subagents/<sessionId>/） */
    parentSessionId: string
    /** 该次工具调用的子代理结果列表（details.results 快照） */
    results: any[]
    /** 初始激活的 tab（点击某个子代理的查看按钮时定位到它） */
    activeSubId?: string
}

const current = ref<SubagentTraceTarget | null>(null)

const _traceState = {
    current,
    isActive: computed(() => current.value !== null),
    /** 打开轨迹抽屉；subId 可选，用于直接定位到某个子代理 tab */
    open(parentSessionId: string, results: any[], subId?: string) {
        current.value = { parentSessionId, results, activeSubId: subId }
    },
    close() {
        current.value = null
    },
}

export const useSubagentTrace = () => _traceState
