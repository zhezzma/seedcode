import { useNotify } from './useNotify'
import { useRoute } from 'vue-router'
import { useUiSettingsStore } from '../stores/setting'
import { useAgentsState } from './useAgentsState'
import { useChatState } from './useChatState'
import { useSessionsState } from './useSessionsState'
import { useCronState } from './useCronState'
import { useModelsState } from './useModelsState'
import { connectServer } from './notify-server-connection'
import { ensureLocalServerLoaded, waitForLocalServerReady, isLocalServerBootFailed } from './local-server'
import { useExecApproval } from './useExecApproval'
import { useCommandState } from './useCommandState'
import { isNewSession } from '../utils/route-helpers'

/**
 * Initializes all domain-specific state composables.
 * By calling these composables, we execute their `ensureInit()` logic
 * which will auto-load data from the HTTP API.
 */
export function useAppInit() {
    const route = useRoute()
    const agentsState = useAgentsState()
    const sessionsState = useSessionsState()
    const { loadModels } = useModelsState()
    const chatState = useChatState()
    const { loadCommands, setCurrentAgent } = useCommandState()
    useCronState()
    useNotify()
    useExecApproval()
    useUiSettingsStore()

    const init = async () => {
        // 本地网关模式下先等内置服务端状态就绪（会把托管地址回填进 settings）：
        // init() 在 App setup 里与路由守卫并发执行，若不等待，首启时 localStorage
        // 里残留的旧远程 apiBaseUrl 会被下面的数据加载抢先使用
        await ensureLocalServerLoaded()
        // 再等内置服务端端口真正监听（node 冷启动 1~5s，Rust 侧 30s 超时转 failed）：
        // 窗口期内不发任何 API 请求，避免连接拒绝报错刷屏；启动画面由 App 门控展示。
        // 初始启动失败时跳过数据加载，由失败界面的「重启服务」（reload 重走本 init）接管
        await waitForLocalServerReady()
        if (isLocalServerBootFailed()) return

        // allSettled 错误隔离：任一加载失败不应阻断其余加载，
        // 更不能让 WS 连接永不建立（原 Promise.all 一损俱损且无重试）
        const results = await Promise.allSettled([
            agentsState.loadAgents(),
            sessionsState.loadSessions(),
            loadModels(),
        ])
        for (const r of results) {
            if (r.status === 'rejected') {
                console.error('[AppInit] 初始数据加载失败:', r.reason)
            }
        }

        // 加载完 agents 后，如果还没有选中的 agent，按优先级兜底：
        // ?agent=<id>（冷刷新/书签直接落在 /new?agent=x 时，路由 watcher 先于本 init
        // 执行，当时列表为空无法命中，这里兜底补选并校验存在性）> 用户上次在欢迎页
        // 明确选择的 agent（settingsStore 持久化，校验存在性）> 第一个 agent。
        if (!chatState.agentsSelectedId && agentsState.agentsList.length > 0) {
            const requestedAgent = isNewSession(route) && typeof route.query.agent === 'string'
                ? route.query.agent
                : ''
            const knownRequested = requestedAgent && agentsState.agentsList.some(a => a.id === requestedAgent)
            const settingsStore = useUiSettingsStore()
            // 记住的选择按激活网关条目隔离：各服务器 agent id 命名空间互不相通。
            // 此处已在 ensureLocalServerLoaded() 之后，bundled 标志已就绪，判定可信
            const rememberedAgent = settingsStore.activeGateway?.lastNewSessionAgentId ?? ''
            const knownRemembered = rememberedAgent && agentsState.agentsList.some(a => a.id === rememberedAgent)
            const targetAgentId = knownRequested
                ? requestedAgent
                : knownRemembered ? rememberedAgent : agentsState.agentsList[0].id
            chatState.selectAgent(targetAgentId)
            setCurrentAgent(targetAgentId)
            await loadCommands(targetAgentId)
        } else {
            setCurrentAgent(chatState.agentsSelectedId || undefined)
            await loadCommands(chatState.agentsSelectedId || undefined)
        }

        connectServer()
    }

    return {
        init
    }
}
