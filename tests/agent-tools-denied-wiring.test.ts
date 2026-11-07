import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ==================== 工具面板 denied 徽章接线（disabledTools 配置态） ====================
//
// 服务端 GET /api/agents/:id/tools 返回三个字段，语义不同：
// - tools           可配置工具清单
// - activeToolNames 当前活跃会话实际提供给模型的工具（运行态：含会话装配差集，
//                   deferred 未加载的 MCP 工具不在其中）
// - disabledTools   配置里的禁用名单（PATCH /tools toggle 的唯一写入目标）
// 红叉徽章与开关此前接的是 activeToolNames（运行态），而开关写入的是
// disabledTools（配置态）——读写不同源：deferred 未加载的 MCP 工具等场景会被
// 误标「已禁用」（配置并未禁用，也无法经开关回开）。本测试钉住：
// denied 绑定 disabledTools（开关读写闭环）；active 死状态已删。

const repoRoot = path.resolve(__dirname, '..')
const stateSource = readFileSync(path.join(repoRoot, 'src/composables/useAgentsState.ts'), 'utf8')

function loadAgentToolsBlock(): string {
    const start = stateSource.indexOf('const loadAgentTools')
    assert.ok(start >= 0, '未找到 loadAgentTools')
    return stateSource.slice(start, start + 900)
}

test('loadAgentTools 响应类型声明 disabledTools（配置态字段须声明才能消费）', () => {
    const block = loadAgentToolsBlock()
    assert.match(
        block,
        /disabledTools:\s*string\[\]/,
        'apiGet 响应类型应声明 disabledTools: string[]（服务端已返回该字段）',
    )
})

test('denied 绑定 disabledTools 配置态（与 PATCH toggle 写入同源闭环）', () => {
    const block = loadAgentToolsBlock()
    assert.match(
        block,
        /denied:\s*res\.disabledTools\.includes\(t\.name\)/,
        'denied 应取 res.disabledTools.includes(t.name)——开关写入的配置字段，读写同源',
    )
    assert.doesNotMatch(
        block,
        /denied:\s*!res\.activeToolNames\.includes/,
        '不得再用 !activeToolNames 推导 denied：运行态≠配置态（deferred MCP 工具未加载会被误标禁用）',
    )
})

test('active 死状态已删（运行态无消费方，防双语义漂移复活）', () => {
    // active 曾绑 activeToolNames：服务端该字段随「有无活跃会话」切换数据源
    // （无会话=目录投影，有会话=运行态 offered 集，deferred 未加载的 MCP 工具
    // 不在），同字段两种语义；且全 src 零读取（仅两处写）。任何稳定化重定义都
    // 退化为 !denied 复读，故删除而非修复。未来要做运行态 UI 须先在服务端
    // 拆分字段（routes/agents.ts GET /:id/tools 的会话覆盖）再接。
    assert.doesNotMatch(stateSource, /active:\s*boolean/, 'AgentTool 接口不得再声明 active')
    assert.doesNotMatch(stateSource, /active:\s*res\.activeToolNames/, '工具映射不得再产 active')
    assert.doesNotMatch(stateSource, /tool\.active/, '乐观更新不得再写 active')
})
