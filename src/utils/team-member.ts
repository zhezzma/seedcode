/**
 * 群成员表单的门面模块：纯函数核 re-export（本体在 team-member-core.ts——
 * 零运行时依赖、node:test 可直接 import）+ hub 清单共享加载器 + HUB 常量
 * re-export。TeamMemberFields 静态导出面与三处消费方统一从此 import。
 */
export { THINKING_LEVELS } from './thinking-levels'
export {
    newTeamMemberRow, memberDocToRow, teamMemberValid, buildInlineSource,
} from './team-member-core'
export type { TeamMemberRow } from './team-member-core'

import { TEAM_CHAT_HUB_AGENT } from '../composables/useSessionsState'
import { useAgentsState } from '../composables/useAgentsState'
import { useSkillsState } from '../composables/useSkillsState'
import { apiGet } from '../composables/api-client'

/** hub agent id（客户端权威常量 re-export；内部引用与消费处统一同源） */
export const HUB_AGENT_ID = TEAM_CHAT_HUB_AGENT

// ─── hub 清单共享加载器（模块级 in-flight 去重 + 缓存） ─────────────────────
//
// 加载器语义：同一时刻并发调用共享同一 promise（向导 N 行成员 = 1 次请求）；
// 失败不缓存（下次挂载重试）。返回「清单是否成功加载」——空清单与失败对调用
// 方的差别是关键（v7.4.3 评审 C-I3）：失败时调用方必须保留 _pending 差集并
// 保持「未初始化」态，否则空全集回算会把黑名单静默漂移成全放行。

interface HubLoadResult<T> { ok: boolean, items: T[] }

const inflightTools = { promise: null as Promise<HubLoadResult<string>> | null }
const inflightSkills = { promise: null as Promise<HubLoadResult<string>> | null }
const inflightExtensions = { promise: null as Promise<Array<{ id: string, name: string }>> | null }

/** hub 工具全集（名字清单）。失败/空 → ok=false（调用方保留 _pending，C-I3）；
 *  失败不缓存——下次调用重拉（瞬时网络抖动不沉淀为永久空清单） */
export const loadHubToolsOnce = (): Promise<HubLoadResult<string>> => {
    if (!inflightTools.promise) {
        const agentsState = useAgentsState()
        inflightTools.promise = agentsState.loadAgentTools(HUB_AGENT_ID).then(() => {
            const tools = agentsState.agentTools[HUB_AGENT_ID] ?? []
            return { ok: tools.length > 0, items: tools.map((t: { name: string }) => t.name) }
        }).catch(() => {
            inflightTools.promise = null
            return { ok: false, items: [] as string[] }
        })
    }
    return inflightTools.promise
}

/** hub 技能全集（id 清单）。失败不缓存（同 loadHubToolsOnce）。 */
export const loadHubSkillsOnce = (): Promise<HubLoadResult<string>> => {
    if (!inflightSkills.promise) {
        const skillsState = useSkillsState()
        inflightSkills.promise = skillsState.loadAgentSkills(HUB_AGENT_ID).then((skills: Array<{ id: string, name?: string }>) => {
            const items = skills.map((s) => s.id)
            return { ok: items.length > 0, items }
        }).catch(() => {
            inflightSkills.promise = null
            return { ok: false, items: [] as string[] }
        })
    }
    return inflightSkills.promise
}

/** 全局扩展清单（enabled 投影；失败返空数组——扩展面无 _pending 语义）。 */
export const loadExtensionsOnce = (): Promise<Array<{ id: string, name: string }>> => {
    if (!inflightExtensions.promise) {
        inflightExtensions.promise = apiGet<Array<{ id: string, name: string, enabled: boolean }>>('/api/extensions')
            .then((raw) => (raw ?? []).filter((e) => e.enabled).map(({ id, name }) => ({ id, name })))
            .catch(() => [] as Array<{ id: string, name: string }>)
    }
    return inflightExtensions.promise
}
