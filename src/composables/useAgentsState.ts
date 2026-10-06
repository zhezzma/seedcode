import { reactive } from 'vue'

import { apiGet, apiPost, apiPatch, apiDelete, apiUpload, apiPatchMultipart } from './api-client'

// ==================== Types ====================
// 与服务端 AgentConfig（HarnessSettings 对齐）的对象 Partial 形态一致；
// 旧 API 的 compaction:boolean / retry:number 联合已删（服务端加载期归一）
export interface CompactionSettings {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
    backgroundTokens?: number;
}

export interface RetrySettings {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    /** agent 级重试退避上限（pi 默认 60000ms） */
    maxAgentDelayMs?: number;
}

/** 进度提交频率（pi DEFAULT_PROGRESS_POLICY 默认 100/100） */
export interface ProgressSettings {
    partialIntervalMs?: number;
    outputIntervalMs?: number;
}

export interface AgentInfo {
    id: string
    name?: string
    description?: string
    agentDir?: string
    workspaceDir?: string
    workspaceDirRaw?: string | null
    avatar?: string
    defaultProvider?: string
    defaultModel?: string
    defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    modelScope?: "session" | "branch"
    steeringMode?: "all" | "one-at-a-time"
    followUpMode?: "all" | "one-at-a-time"
    /** 工具执行模式（pi-durable ToolExecutionMode，缺省 parallel） */
    toolExecution?: "parallel" | "sequential"
    compaction?: CompactionSettings
    retry?: RetrySettings
    progress?: ProgressSettings
    sessionId?: string
    createdAt?: string
    skills?: string[]
}

export interface AgentTool {
    name: string
    description?: string
    parameters?: any
    active: boolean
    denied: boolean
}

export interface AgentsState {
    agentsList: AgentInfo[],
    // Agent tools state
    agentTools: Record<string, AgentTool[]>
    agentToolsBusy: Record<string, boolean>
}

// ==================== State ====================
const state = reactive<AgentsState>({
    agentsList: [],
    agentTools: {},
    agentToolsBusy: {},
})

// ==================== Actions ====================

const loadAgents = async () => {
    const agents = await apiGet<AgentInfo[]>('/api/agents')
    state.agentsList = agents || []
}

const createAgent = async (params: FormData | any) => {
    let res
    if (params instanceof FormData) {
        res = await apiUpload<AgentInfo>('/api/agents', params)
    } else {
        res = await apiPost<AgentInfo>('/api/agents', params)
    }
    if (res) {
        state.agentsList.push(res)
    }
    return res
}

const updateAgent = async (params: FormData | ({ agentId: string } & Record<string, any>)) => {
    let res
    if (params instanceof FormData) {
        const agentId = params.get('id') as string
        if (!agentId) throw new Error("Agent ID is required")
        res = await apiPatchMultipart<AgentInfo>(`/api/agents/${agentId}`, params)
    } else {
        const { agentId, ...body } = params
        res = await apiPatch<AgentInfo>(`/api/agents/${agentId}`, body)
    }
    if (res) {
        const index = state.agentsList.findIndex(a => a.id === res.id)
        if (index !== -1) {
            state.agentsList[index] = res
        }
    }
    return res
}

const deleteAgent = async (params: { agentId: string; deleteFiles?: boolean }) => {
    const res = await apiDelete(`/api/agents/${params.agentId}`)
    state.agentsList = state.agentsList.filter(a => a.id !== params.agentId)
    return res
}

const loadAgentTools = async (agentId: string) => {
    state.agentToolsBusy[agentId] = true
    try {
        const res = await apiGet<{
            tools: { name: string, description?: string, parameters?: any }[],
            activeToolNames: string[]
        }>(`/api/agents/${agentId}/tools`)

        if (res) {
            state.agentTools[agentId] = res.tools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
                active: res.activeToolNames.includes(t.name),
                denied: !res.activeToolNames.includes(t.name)
            }))
        }
    } catch (err: any) {
        console.error(`Failed to load tools for agent ${agentId}:`, err)
    } finally {
        state.agentToolsBusy[agentId] = false
    }
}

const toggleAgentTool = async (agentId: string, toolName: string, enable: boolean) => {
    try {
        const tools = state.agentTools[agentId]
        if (tools) {
            const tool = tools.find(t => t.name === toolName)
            if (tool) {
                tool.denied = !enable
                tool.active = enable
            }
        }
        const body = enable ? { enable: [toolName] } : { disable: [toolName] }
        await apiPatch<{ disabledTools: string[] }>(`/api/agents/${agentId}/tools`, body)
        await loadAgentTools(agentId)
    } catch (err: any) {
        console.error(`Failed to toggle tool ${toolName} for agent ${agentId}:`, err)
        await loadAgentTools(agentId)
    }
}

const _agentsState = Object.assign(state, {
    loadAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    loadAgentTools,
    toggleAgentTool,
})

export function useAgentsState() {
    return _agentsState
}

