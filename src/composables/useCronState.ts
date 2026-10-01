import { reactive } from 'vue'

import type { DeliveryTarget } from '../utils/delivery-targets'
import type { TaskExecutionTarget } from '../utils/cron-execution-target'
import type { SessionSearchCandidate } from '../utils/cron-session-search'
import { apiGet, apiPost, apiPatch, apiDelete } from './api-client'

// ==================== Types ====================
export interface TaskJob {
    id: string
    name: string
    description: string
    executionTarget: TaskExecutionTarget
    enabled: boolean
    scheduleKind: 'at' | 'every' | 'cron'
    scheduleAt: string
    everyAmount: string
    everyUnit: 'minutes' | 'hours' | 'days'
    cron: string
    cronExpr: string
    cronTz: string
    payloadText: string
    timeoutSeconds: string
    deliveryTargets: DeliveryTarget[]
    lastRun?: string
    createdAt: string
}

export interface CronRunLogEntry {
    logTimestamp: string
    status: string
    start: string
    durationMs: number
    agentId: string
    executionTarget?: TaskExecutionTarget
    kind: string
    cron: string
    prompt: string
    sessionId: string
    result: string
    error?: string
}

export interface CronFormState {
    name: string
    description: string
    executionTarget: TaskExecutionTarget
    enabled: boolean
    scheduleKind: 'at' | 'every' | 'cron'
    scheduleAt: string
    everyAmount: string
    everyUnit: 'minutes' | 'hours' | 'days'
    cronExpr: string
    cronTz: string
    payloadText: string
    timeoutSeconds: string
    deliveryTargets: DeliveryTarget[]
}

export interface CronState {
    cronJobs: TaskJob[]
    // Loading / busy / error 直接放进 state，避免与 reactive 合并时 Ref 被自动解包
    cronLoading: boolean
    cronBusy: boolean
    cronSaving: boolean
    cronError: string | null
}

// ==================== State ====================

const state = reactive<CronState>({
    cronJobs: [],
    cronLoading: false,
    cronBusy: false,
    cronSaving: false,
    cronError: null,
})

// ==================== Actions ====================

const loadCron = async () => {
    state.cronLoading = true
    state.cronError = null
    try {
        const result = await apiGet<{ crons: TaskJob[] }>('/api/extensions/scheduler')
        state.cronJobs = result?.crons || []
    } catch (err: any) {
        state.cronError = err?.message || String(err)
    } finally {
        state.cronLoading = false
    }
}

const addCronJob = async (form: CronFormState) => {
    state.cronSaving = true
    state.cronError = null
    try {
        const newJob = await apiPost<TaskJob>('/api/extensions/scheduler', { ...form })
        state.cronJobs.push(newJob)
    } catch (err: any) {
        state.cronError = String(err)
        throw err
    } finally {
        state.cronSaving = false
    }
}

const toggleCronJob = async (job: TaskJob, enabled: boolean) => {
    state.cronBusy = true
    state.cronError = null
    try {
        const endpoint = enabled ? 'enable' : 'disable'
        await apiPost(`/api/extensions/scheduler/${job.id}/${endpoint}`)
        const idx = state.cronJobs.findIndex(j => j.id === job.id)
        if (idx !== -1) {
            state.cronJobs[idx].enabled = enabled
        }
    } catch (err: any) {
        state.cronError = String(err)
    } finally {
        state.cronBusy = false
    }
}

const removeCronJob = async (job: TaskJob) => {
    state.cronBusy = true
    state.cronError = null
    try {
        await apiDelete(`/api/extensions/scheduler/${job.id}`)
        state.cronJobs = state.cronJobs.filter(j => j.id !== job.id)
    } catch (err: any) {
        state.cronError = String(err)
    } finally {
        state.cronBusy = false
    }
}

const updateCronJob = async (id: string, form: CronFormState) => {
    if (state.cronSaving) return
    state.cronSaving = true
    state.cronError = null
    try {
        const updatedJob = await apiPatch<TaskJob>(`/api/extensions/scheduler/${id}`, { ...form })
        const idx = state.cronJobs.findIndex(j => j.id === id)
        if (idx !== -1) {
            state.cronJobs[idx] = updatedJob
        }
    } catch (err: any) {
        state.cronError = String(err)
        throw err
    } finally {
        state.cronSaving = false
    }
}

const runCronJob = async (job: TaskJob) => {
    state.cronBusy = true
    try {
        await apiPost(`/api/extensions/scheduler/${job.id}/run`)
    } catch (err: any) {
        state.cronError = String(err)
        throw err
    } finally {
        state.cronBusy = false
    }
}

const loadCronRuns = async (jobId: string): Promise<CronRunLogEntry[]> => {
    try {
        const result = await apiGet<{ logs: CronRunLogEntry[] }>(`/api/extensions/scheduler/${jobId}/logs`)
        return result?.logs || []
    } catch (err: any) {
        console.error('Failed to load cron logs', err)
        return []
    }
}

const searchSessions = async (query: string, limit = 10): Promise<SessionSearchCandidate[]> => {
    try {
        const result = await apiGet<{ sessions: SessionSearchCandidate[] }>(`/api/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}`)
        return result?.sessions || []
    } catch (err) {
        console.error('Failed to search sessions', err)
        return []
    }
}

// ==================== Export ====================

const _cronState = Object.assign(state, {
    loadCron,
    addCronJob,
    toggleCronJob,
    removeCronJob,
    updateCronJob,
    runCronJob,
    loadCronRuns,
    searchSessions,
})

export function useCronState() {
    return _cronState
}
