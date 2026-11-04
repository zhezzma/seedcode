import { reactive, computed } from 'vue'
import { apiGet } from './api-client'
import { filterByCommandQuery } from '../utils/command-name-match.ts'

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
    currentAgentId: '',
})

const resolveScopeKey = (agentId?: string) => (agentId?.trim() || '')

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

    // 服务端契约：/api/commands 的 agentId 必填（缺失 400 / 未注册 404）。
    // 无 agent 语境（未选择代理，scope key 为空串）不发请求：服务端命令本就
    // 按 agent 视角下发，此时该作用域仅剩客户端本地命令（CLIENT_COMMANDS 在
    // / 补全层另行合并；updateGlobalPromptCaches 写入的 prompt 缓存也保留）。
    // 该作用域缓存只可能由本地写入，无需清空，标记已加载避免反复空转。
    const trimmedAgentId = agentId?.trim() ?? ''
    if (!trimmedAgentId) {
        state.loadedByAgentId[scopeKey] = true
        return
    }

    state.loadingByAgentId[scopeKey] = true
    try {
        const result = await apiGet<CommandsResponse>(`/api/commands?agentId=${encodeURIComponent(trimmedAgentId)}`)
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

/** 根据输入过滤命令：全名前缀（/skill:wait）或 `:` 后名字段子串（/wait、/what 都能
 *  命中 skill:wait-what，不必手打命名空间）；匹配规则见 utils/command-name-match */
const filterCommands = computed(() => (query: string) =>
    filterByCommandQuery(getCommandsForScope(state.currentAgentId), query)
)

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
