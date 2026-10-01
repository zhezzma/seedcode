import { reactive, computed } from 'vue'
import { apiGet } from './api-client'

// ==================== Types ====================

/** 服务器返回的单条命令信息 */
export interface CommandInfo {
    name: string
    description?: string
    usage?: string
    source?: 'builtin' | 'extension' | 'prompt' | 'skill' | 'client'
    [key: string]: any
}

/** /api/commands 响应体 */
interface CommandsResponse {
    commands: CommandInfo[]
    total: number
    builtinCount: number
    extensionCount: number
}

// ==================== State ====================

const GLOBAL_COMMAND_SCOPE = '__global__'

/** 服务端内置命令中客户端隐藏的名单：pi-harness 迁移后 Phase 3 桩（调用即 501）。
 *  隐藏而非删除：服务端接回后移除名单即可恢复展示。手输完整命令仍会到达服务端。 */
const HIDDEN_SERVER_COMMANDS = new Set(['share', 'export'])

const state = reactive<{
    commandsByAgentId: Record<string, CommandInfo[]>
    loadedByAgentId: Record<string, boolean>
    loadingByAgentId: Record<string, boolean>
    currentAgentId: string
}>({
    commandsByAgentId: {},
    loadedByAgentId: {},
    loadingByAgentId: {},
    currentAgentId: GLOBAL_COMMAND_SCOPE,
})

const resolveScopeKey = (agentId?: string) => (agentId?.trim() || GLOBAL_COMMAND_SCOPE)

const getCommandsForScope = (agentId?: string): CommandInfo[] => {
    const scopeKey = resolveScopeKey(agentId)
    return state.commandsByAgentId[scopeKey] ?? []
}

const setCurrentAgent = (agentId?: string) => {
    state.currentAgentId = resolveScopeKey(agentId)
}

// ==================== Derived Computeds & Actions（模块级，仅初始化一次）====================

const loadCommands = async (agentId?: string, options?: { force?: boolean }) => {
    const scopeKey = resolveScopeKey(agentId)
    const force = options?.force === true

    setCurrentAgent(agentId)

    if (state.loadingByAgentId[scopeKey]) return
    if (!force && state.loadedByAgentId[scopeKey]) return

    state.loadingByAgentId[scopeKey] = true
    try {
        const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
        const result = await apiGet<CommandsResponse>(`/api/commands${query}`)
        state.commandsByAgentId[scopeKey] = (result?.commands ?? []).filter(
            cmd => !HIDDEN_SERVER_COMMANDS.has(cmd.name)
        )
        state.loadedByAgentId[scopeKey] = true
    } catch (err) {
        console.error('[useCommandState] 获取命令列表失败:', err)
    } finally {
        state.loadingByAgentId[scopeKey] = false
    }
}

const forceReload = async (agentId?: string) => {
    const scopeKey = resolveScopeKey(agentId)
    state.loadedByAgentId[scopeKey] = false
    await loadCommands(agentId, { force: true })
}

const upsertCommand = (command: CommandInfo, agentId?: string) => {
    const scopeKey = resolveScopeKey(agentId)
    const current = [...getCommandsForScope(agentId)]
    const index = current.findIndex(c => c.name === command.name && c.source === command.source)

    if (index >= 0) {
        current[index] = command
    } else {
        current.push(command)
    }

    state.commandsByAgentId[scopeKey] = current
    state.loadedByAgentId[scopeKey] = true
}

const removeCommand = (name: string, agentId?: string, source?: CommandInfo['source']) => {
    const scopeKey = resolveScopeKey(agentId)
    const current = getCommandsForScope(agentId)
    state.commandsByAgentId[scopeKey] = current.filter(cmd => {
        if (cmd.name !== name) return true
        if (source && cmd.source !== source) return true
        return false
    })
}

const updateGlobalPromptCaches = (command: CommandInfo | null, removeName?: string) => {
    for (const scopeKey of Object.keys(state.commandsByAgentId)) {
        const current = state.commandsByAgentId[scopeKey] ?? []
        const withoutTarget = current.filter(cmd => !(cmd.source === 'prompt' && cmd.name === (removeName || command?.name)))
        state.commandsByAgentId[scopeKey] = command ? [...withoutTarget, command] : withoutTarget
    }
}

/** 根据输入前缀过滤命令（输入 `/foo` 则匹配所有以 `foo` 开头的命令） */
const filterCommands = computed(() => (prefix: string) => {
    const lc = prefix.toLowerCase()
    return getCommandsForScope(state.currentAgentId).filter(cmd =>
        cmd.name.toLowerCase().startsWith(lc)
    )
})

const allCommands = computed(() => getCommandsForScope(state.currentAgentId))
const isLoaded = computed(() => state.loadedByAgentId[state.currentAgentId] ?? false)

const _commandState = {
    allCommands,
    isLoaded,
    currentAgentId: computed(() => state.currentAgentId),
    commandsByAgentId: computed(() => state.commandsByAgentId),
    setCurrentAgent,
    getCommandsForScope,
    loadCommands,
    forceReload,
    upsertCommand,
    removeCommand,
    updateGlobalPromptCaches,
    filterCommands,
}

export function useCommandState() {
    return _commandState
}
