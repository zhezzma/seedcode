/**
 * 群成员表单纯函数行为测试（v7.4.3）：本体在 utils/team-member-core.ts
 * （零运行时依赖，node:test 直接 import——此前困在 SFC 静态导出面里只能
 * 被正则扫源码的锚「测试」）。核心断言面：
 * 1. row→source→doc→row 往返不漂移（黑名单/白名单/模型三切分）
 * 2. _pending 差集生命周期（全集未到时投影兜底直传；到达后回算勾选态）
 * 3. 空配置不携带字段（服务端按 hub agent 配置回退——v7.4 统一配置源）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    newTeamMemberRow, memberDocToRow, teamMemberValid, buildInlineSource,
} from '../src/utils/team-member-core.ts'

const HUB_TOOLS = ['bash', 'read', 'write', 'grep'] as const
const HUB_SKILLS = ['diagram-design', 'tdd', 'research'] as const

test('buildInlineSource: 空配置不携带字段（回退 hub agent 配置）', () => {
    const row = newTeamMemberRow()
    row.systemPrompt = '你是测试员'
    const source = buildInlineSource(row, [...HUB_TOOLS], [...HUB_SKILLS])
    assert.deepEqual(source, { type: 'inline', systemPrompt: '你是测试员' })
    assert.equal('provider' in source, false)
    assert.equal('disabledTools' in source, false)
    assert.equal('skills' in source, false)
    assert.equal('extensions' in source, false)
})

test('buildInlineSource: model 首个 / 切分（modelId 含 / 的 openrouter 形态）', () => {
    const row = newTeamMemberRow()
    row.systemPrompt = 'P'
    row.model = 'openrouter/deepseek/r1'
    const source = buildInlineSource(row, [], [])
    assert.equal(source.provider, 'openrouter')
    assert.equal(source.model, 'deepseek/r1')
})

test('buildInlineSource: custom 差集 = 全集 − 勾选', () => {
    const row = newTeamMemberRow()
    row.systemPrompt = 'P'
    row.toolsMode = 'custom'
    row.enabledTools = ['bash', 'read'] // 勾=可用
    row.skillsMode = 'custom'
    row.enabledSkills = ['tdd']
    const source = buildInlineSource(row, [...HUB_TOOLS], [...HUB_SKILLS])
    assert.deepEqual(source.disabledTools, ['write', 'grep'])
    assert.deepEqual(source.skills, { type: 'custom', disabledSkills: ['diagram-design', 'research'] })
})

test('_pending 差集生命周期：全集未到 → 投影兜底直传差集（不漂移成全放行）', () => {
    // doc → row：黑名单挂 _pending（全集未知，勾选态无法回显）
    const row = memberDocToRow({
        name: 'bob', memory: true,
        source: { type: 'inline', systemPrompt: 'P', disabledTools: ['bash', 'grep'], skills: { type: 'custom', disabledSkills: ['tdd'] } },
    })
    assert.equal(row.toolsMode, 'custom')
    assert.deepEqual(row._pendingDisabledTools, ['bash', 'grep'])
    assert.deepEqual(row.enabledTools, []) // 全集未到，勾选态空
    // 全集加载失败（C-I3 守卫）：不回算、不清 pending → 投影走兜底，差集原样保留
    const degraded = buildInlineSource(row, [], [])
    assert.deepEqual(degraded.disabledTools, ['bash', 'grep'])
    assert.deepEqual(degraded.skills, { type: 'custom', disabledSkills: ['tdd'] })
})

test('_pending 差集生命周期：全集到达 → 回算勾选态后投影同结果（往返不漂移）', () => {
    const row = memberDocToRow({
        name: 'bob', memory: false,
        source: { type: 'inline', systemPrompt: 'P', disabledTools: ['bash', 'grep'], skills: { type: 'custom', disabledSkills: ['tdd'] } },
    })
    // 模拟组件 onMounted 回算（全集到达）：勾选=全集−disabled
    const disabledTools = new Set(row._pendingDisabledTools ?? [])
    row.enabledTools = [...HUB_TOOLS].filter((name) => !disabledTools.has(name))
    row._pendingDisabledTools = undefined
    const disabledSkills = new Set(row._pendingDisabledSkills ?? [])
    row.enabledSkills = [...HUB_SKILLS].filter((id) => !disabledSkills.has(id))
    row._pendingDisabledSkills = undefined
    // 投影 → 回读 doc 形状 → 再展平：与初值一致
    const source = buildInlineSource(row, [...HUB_TOOLS], [...HUB_SKILLS])
    assert.deepEqual(source.disabledTools, ['bash', 'grep'])
    const back = memberDocToRow({ name: 'bob', memory: false, source: { type: 'inline', systemPrompt: 'P', ...source } })
    assert.deepEqual(back._pendingDisabledTools, ['bash', 'grep'])
    assert.deepEqual(back._pendingDisabledSkills, ['tdd'])
})

test('显式全不选 ≠ 未初始化：enabled 空且无 pending → 差集=全集（全禁用）', () => {
    const row = newTeamMemberRow()
    row.systemPrompt = 'P'
    row.toolsMode = 'custom'
    row.enabledTools = []
    // 无 _pending（用户显式清空或全集到达后回算为空）→ 全禁用，而非兜底
    const source = buildInlineSource(row, [...HUB_TOOLS], [])
    assert.deepEqual(source.disabledTools, [...HUB_TOOLS])
})

test('memberDocToRow: extensions 白名单/agent 引用/模型往返', () => {
    const row = memberDocToRow({
        name: '子代理甲', memory: true,
        source: { type: 'agent', agentId: 'worker-1', provider: 'p1', model: 'm1', thinkingLevel: 'high', extensions: ['coding-tools'] },
    })
    assert.equal(row.type, 'agent')
    assert.equal(row.agentId, 'worker-1')
    assert.equal(row.model, 'p1/m1')
    assert.equal(row.thinkingLevel, 'high')
    assert.equal(row.extensionsMode, 'custom')
    assert.deepEqual(row.selectedExtensions, ['coding-tools'])
})

test('teamMemberValid: 名字必填 + 分型必填', () => {
    const inline = newTeamMemberRow()
    assert.equal(teamMemberValid(inline), false)
    inline.name = 'bob'
    assert.equal(teamMemberValid(inline), false) // inline 缺人格
    inline.systemPrompt = 'P'
    assert.equal(teamMemberValid(inline), true)
    const agent = newTeamMemberRow()
    agent.name = 'bob'
    agent.type = 'agent'
    assert.equal(teamMemberValid(agent), false) // agent 缺引用
    agent.agentId = 'a1'
    assert.equal(teamMemberValid(agent), true)
})
