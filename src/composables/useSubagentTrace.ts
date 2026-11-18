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
    /** 自定义轨迹源（群聊任务 tab 等非 subagents 扩展场景）：
     *  入参 (subId, offset)，返回 GET 地址；缺省= subagents 侧车路由 */
    traceUrl?: (subId: string, offset: number) => string
    /** false = 隐藏运行配置行（模型/思考档）：目标不经 subagents config
     *  端点管理（群成员的配置在群管理面），避免 GET 404 噪声 */
    managedConfig?: boolean
}

const current = ref<SubagentTraceTarget | null>(null)

const _traceState = {
    current,
    isActive: computed(() => current.value !== null),
    /** 打开轨迹抽屉；subId 可选，用于直接定位到某个子代理 tab */
    open(parentSessionId: string, results: any[], subId?: string, options?: { traceUrl?: SubagentTraceTarget['traceUrl'], managedConfig?: boolean }) {
        current.value = { parentSessionId, results, activeSubId: subId, ...(options ?? {}) }
    },
    close() {
        current.value = null
    },
}

export const useSubagentTrace = () => _traceState
