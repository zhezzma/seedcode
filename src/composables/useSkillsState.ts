import { reactive } from 'vue'

import { apiGet, apiPost, apiPatch, apiDelete } from './api-client'
import { clawHubClient, type ConvexSkill, type ConnectionStatus } from './clawhub-client'

// ==================== Types ====================

export interface SkillsState {
    skillsBusyKey: string | null
    skillMessages: Record<string, string>
    skillEdits: Record<string, string>
    publicSkills: ConvexSkill[]
    publicSkillsLoading: boolean
    connectionStatus: ConnectionStatus
}

// ==================== State ====================
const state = reactive<SkillsState>({
    skillsBusyKey: null,
    skillMessages: {},
    skillEdits: {},
    publicSkills: [],
    publicSkillsLoading: false,
    connectionStatus: 'disconnected',
})

// ==================== Init Callbacks ====================
clawHubClient.setCallbacks({
    onStatusChange: (status) => {
        state.connectionStatus = status
    },
    onPublicSkillsUpdated: (skills) => {
        state.publicSkills = skills
    },
    onReadmeReceived: (_, text) => {
        if (state.skillsBusyKey) {
            state.skillMessages[state.skillsBusyKey] = text
            state.skillsBusyKey = null
        }
    },
    onSearchFinished: (skills) => {
        state.publicSkills = skills
    },
    onLoadingState: (loading) => {
        state.publicSkillsLoading = loading
    }
})

// ==================== Export ====================


// ==================== Actions ====================

const initConvexConnection = () => {
    clawHubClient.init()
}

const fetchPublicSkills = async (options: { sort?: string } = {}) => {
    await clawHubClient.fetchPublicSkills(options)
}

const getSkillReadme = async (versionId: string) => {
    state.skillsBusyKey = versionId
    state.skillMessages[versionId] = ''
    await clawHubClient.getSkillReadme(versionId)
}

const searchSkills = async (query: string) => {
    await clawHubClient.searchSkills(query)
}

const installSkill = async (skillName: string, agentId?: string) => {
    try {
        const body = { name: skillName }
        if (agentId) {
            await apiPost(`/api/skills/${agentId}/install`, body)
        } else {
            await apiPost('/api/skills/global/install', body)
        }
    } catch (err: any) {
        console.error('Failed to install skill:', err)
        throw err
    }
}

const fetchGlobalSkills = async (agentId?: string) => {
    try {
        const query = agentId ? `?agentId=${agentId}` : ''
        const res = await apiGet<{ skills: any[] }>(`/api/skills/global${query}`)
        return res?.skills || []
    } catch (err) {
        console.error('Failed to fetch global skills:', err)
        return []
    }
}

const uninstallGlobalSkill = async (skillId: string) => {
    try {
        await apiDelete(`/api/skills/global/${skillId}`)
    } catch (err) {
        console.error('Failed to uninstall global skill:', err)
        throw err
    }
}

const loadAgentSkills = async (agentId: string) => {
    try {
        const result = await apiGet<{ skills: any[] }>(`/api/skills/${agentId}`)
        return result?.skills || []
    } catch (err: any) {
        console.error(`Failed to load skills for agent ${agentId}:`, err)
        return []
    }
}

const toggleAgentSkill = async (agentId: string, skillId: string, enabled: boolean) => {
    await apiPost(`/api/skills/${agentId}/${skillId}`, { enabled })
}

const uninstallAgentSkill = async (agentId: string, skillId: string) => {
    try {
        await apiDelete(`/api/skills/${agentId}/${skillId}`)
    } catch (err: any) {
        throw err
    }
}

const fetchSystemSkills = async (agentId?: string) => {
    try {
        const query = agentId ? `?agentId=${agentId}` : ''
        const res = await apiGet<{ skills: any[] }>(`/api/skills/system${query}`)
        return res?.skills || []
    } catch (err) {
        console.error('Failed to fetch system skills:', err)
        return []
    }
}

// 扩展技能分组视图：每个注册了技能的扩展 + 其全部技能（根/子目录/vendor）
const fetchExtensionSkills = async (agentId?: string) => {
    try {
        const query = agentId ? `?agentId=${agentId}` : ''
        const res = await apiGet<{ extensions: any[] }>(`/api/skills/extensions${query}`)
        return res?.extensions || []
    } catch (err) {
        console.error('Failed to fetch extension skills:', err)
        return []
    }
}

const getSystemSkillContent = async (skillId: string) => {
    try {
        const res = await apiGet<{ content: string }>(`/api/skills/system/${skillId}`)
        return res?.content || null
    } catch (err) {
        console.error(`Failed to fetch system skill content (${skillId}):`, err)
        return null
    }
}

const getGlobalSkillContent = async (skillId: string) => {
    try {
        const res = await apiGet<{ content: string }>(`/api/skills/global/${skillId}`)
        return res?.content || null
    } catch (err) {
        console.error(`Failed to fetch global skill content (${skillId}):`, err)
        return null
    }
}

const getAgentSkillContent = async (agentId: string, skillId: string) => {
    try {
        const res = await apiGet<{ content: string }>(`/api/skills/${agentId}/${skillId}`)
        return res?.content || null
    } catch (err) {
        console.error(`Failed to fetch agent skill content (${agentId}, ${skillId}):`, err)
        return null
    }
}

const _skillsState = Object.assign(state, {
    initConvexConnection,
    fetchPublicSkills,
    searchSkills,
    getSkillReadme,
    installSkill,
    fetchGlobalSkills,
    fetchSystemSkills,
    fetchExtensionSkills,
    uninstallGlobalSkill,
    loadAgentSkills,
    toggleAgentSkill,
    uninstallAgentSkill,
    getSystemSkillContent,
    getGlobalSkillContent,
    getAgentSkillContent
})

export function useSkillsState() {
    return _skillsState
}

