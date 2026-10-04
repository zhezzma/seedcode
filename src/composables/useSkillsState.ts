import { reactive } from 'vue'

import { apiGet, apiPost, apiDelete } from './api-client'

// ==================== Types ====================

export interface SkillsState {
    skillsBusyKey: string | null
    skillMessages: Record<string, string>
    skillEdits: Record<string, string>
}

// ==================== State ====================

const state = reactive<SkillsState>({
    skillsBusyKey: null,
    skillMessages: {},
    skillEdits: {},
})

// ==================== Actions ====================

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

const uninstallGlobalSkill = async (agentId: string, skillId: string) => {
    try {
        await apiDelete(`/api/skills/global/${skillId}?agentId=${encodeURIComponent(agentId)}`)
    } catch (err: any) {
        console.error('Failed to uninstall global skill:', err)
        throw err
    }
}

const getGlobalSkillContent = async (agentId: string, skillId: string) => {
    try {
        const res = await apiGet<{ content: string }>(`/api/skills/global/${skillId}?agentId=${encodeURIComponent(agentId)}`)
        return res?.content || null
    } catch (err: any) {
        console.error(`Failed to fetch global skill content (${skillId}):`, err)
        return null
    }
}

const getAgentSkillContent = async (agentId: string, skillId: string) => {
    try {
        const res = await apiGet<{ content: string }>(`/api/skills/${agentId}/${skillId}`)
        return res?.content || null
    } catch (err: any) {
        console.error(`Failed to fetch agent skill content (${agentId}, ${skillId}):`, err)
        return null
    }
}

const _skillsState = Object.assign(state, {
    uninstallGlobalSkill,
    loadAgentSkills,
    toggleAgentSkill,
    uninstallAgentSkill,
    getGlobalSkillContent,
    getAgentSkillContent
})

export function useSkillsState() {
    return _skillsState
}
