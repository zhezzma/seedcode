/**
 * 群成员表单纯函数核（v7.4.3 从 TeamMemberFields.vue 抽离）。
 * 本文件零运行时依赖（类型 import 全部擦除）——node:test 可直接 import
 * 做行为级测试（row↔source 往返不漂移）。依赖 composable 的加载器与
 * HUB_AGENT_ID re-export 在同目录 team-member.ts（组件消费面不变）。
 */
import type { TeamGroupInlineSource } from '../composables/useSessionsState'

export interface TeamMemberRow {
    name: string
    type: 'inline' | 'agent'
    systemPrompt: string
    agentId: string
    memory: boolean
    /** provider/model（select 值 'provider/model'；空=跟随群默认） */
    model: string
    /** '' = 跟随群默认 */
    thinkingLevel: string
    toolsMode: 'inherit' | 'custom'
    /** custom 模式勾选=可用（全集−勾选=disabledTools） */
    enabledTools: string[]
    skillsMode: 'inherit' | 'none' | 'custom'
    enabledSkills: string[]
    extensionsMode: 'inherit' | 'custom'
    /** 白名单勾选=挂载 */
    selectedExtensions: string[]
    /** 编辑预填的差集残留（全集加载前回显不了勾选态，到后反算）：
     *  enabledTools 为空且本字段在场时投影优先用它（勾选态未初始化） */
    _pendingDisabledTools?: string[]
    _pendingDisabledSkills?: string[]
    /** UI-only 行标识（工厂自增填充；v-for :key 用——splice 删行时 index 键
     *  会错位复用组件实例。不参与任何投影/校验，服务端永不感知） */
    _rowId?: number
}

let rowIdSeq = 0

export const newTeamMemberRow = (): TeamMemberRow => ({
    _rowId: ++rowIdSeq,
    name: '', type: 'inline', systemPrompt: '', agentId: '', memory: false,
    model: '', thinkingLevel: '',
    toolsMode: 'inherit', enabledTools: [],
    skillsMode: 'inherit', enabledSkills: [],
    extensionsMode: 'inherit', selectedExtensions: [],
})

/** MemberDoc（GET /groups/:id 投影）→ 表单行展平：黑名单/白名单反算回勾选态。 */
export const memberDocToRow = (m: {
    name: string
    memory: boolean
    source: {
        type: 'agent' | 'inline'
        agentId?: string
        systemPrompt?: string
        provider?: string
        model?: string
        thinkingLevel?: string
        disabledTools?: string[]
        skills?: { type: string, disabledSkills?: string[] }
        extensions?: string[]
    }
}): TeamMemberRow => {
    const s = m.source
    const row = newTeamMemberRow()
    row.name = m.name
    row.memory = m.memory
    row.type = s.type === 'agent' ? 'agent' : 'inline'
    row.agentId = s.agentId ?? ''
    row.systemPrompt = s.systemPrompt ?? ''
    if (s.provider && s.model) row.model = `${s.provider}/${s.model}`
    row.thinkingLevel = s.thinkingLevel ?? ''
    // disabledTools 在场即 custom：勾选态=全集−disabled，全集组件内加载后反算；
    // 加载前 enabledTools 留空 + _pending 挂差集（投影兜底直传差集）
    row._pendingDisabledTools = s.disabledTools
    if (s.disabledTools !== undefined) row.toolsMode = 'custom'
    row.skillsMode = s.skills?.type === 'none' ? 'none' : s.skills?.type === 'custom' ? 'custom' : 'inherit'
    row._pendingDisabledSkills = s.skills?.disabledSkills
    if (s.extensions !== undefined) {
        row.extensionsMode = 'custom'
        row.selectedExtensions = [...s.extensions]
    }
    return row
}

/** 表单行校验（三处共用：名字必填；agent 型必选引用；inline 型必填人格）。 */
export const teamMemberValid = (m: TeamMemberRow): boolean => {
    if (!m.name.trim()) return false
    if (m.type === 'agent') return Boolean(m.agentId)
    return Boolean(m.systemPrompt.trim())
}

/** inline source 投影：空配置不携带字段（服务端按缺省回退 hub agent 配置——
 *  v7.4 统一配置源）。hubTools/hubSkills = 当前全集（custom 差集计算用）。 */
export const buildInlineSource = (m: TeamMemberRow, hubTools: string[], hubSkills: string[]): TeamGroupInlineSource => {
    const source: TeamGroupInlineSource = { type: 'inline', systemPrompt: m.systemPrompt }
    if (m.model.includes('/')) {
        // 首个 / 分隔（与 useChatState splitModelId 同口径）：modelId 自身可含 /
        //（如 openrouter 形态），lastIndexOf 会把 provider 切错导致往返漂移
        const provider = m.model.slice(0, m.model.indexOf('/'))
        const model = m.model.slice(m.model.indexOf('/') + 1)
        source.provider = provider
        source.model = model
    }
    if (m.thinkingLevel) source.thinkingLevel = m.thinkingLevel
    if (m.toolsMode === 'custom') {
        if (m.enabledTools.length === 0 && m._pendingDisabledTools) {
            source.disabledTools = [...m._pendingDisabledTools]
        } else {
            const enabled = new Set(m.enabledTools)
            source.disabledTools = hubTools.filter((name) => !enabled.has(name))
        }
    }
    if (m.skillsMode === 'none') {
        source.skills = { type: 'none' }
    } else if (m.skillsMode === 'custom') {
        if (m.enabledSkills.length === 0 && m._pendingDisabledSkills) {
            source.skills = { type: 'custom', disabledSkills: [...m._pendingDisabledSkills] }
        } else {
            const enabled = new Set(m.enabledSkills)
            source.skills = { type: 'custom', disabledSkills: hubSkills.filter((id) => !enabled.has(id)) }
        }
    }
    if (m.extensionsMode === 'custom') {
        source.extensions = [...m.selectedExtensions]
    }
    return source
}
