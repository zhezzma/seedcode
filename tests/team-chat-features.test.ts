import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { build } from 'esbuild'

import { getSessionBucketKey, moveSessionToRouteState } from '../src/composables/session-route-state.ts'

/**
 * 本轮群聊四需求的客户端接线断言（source-structure 测试，与
 * path-mention-wiring.test.ts 同模式）：Vue SFC / composable 依赖 vue/pinia/DOM
 * 无法在 node:test 挂起，正确性靠断言源码结构兜底。
 * 数据层行为锚例外：session-route-state 零依赖直接 import；useSessionsState
 * 用 esbuild 打包驱动（同 session-auto-rename-title-set.test.ts 模式）。
 *
 * 覆盖面：
 * 1. TeamGroupWizard inline 成员高级配置（模型/思考/工具/技能/扩展 → buildInlineSource 投影）
 * 2. 群管理视图（agents/AgentTeamGroups——右栏 hub 形态 + AgentsView hub 形态 + HomeView groupSessionId 传递）
 * 3. settings store tab 类型含 'groups'
 */

const testDir = path.dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(path.resolve(testDir, rel), 'utf8')
const repoFile = (rel: string) => path.resolve(testDir, rel).replace(/\\/g, '/')

const wizard = read('../src/components/chat/TeamGroupWizard.vue')
const workspacePanel = read('../src/components/workspace/WorkspacePanel.vue')
const agentTeamGroups = read('../src/components/agents/AgentTeamGroups.vue')
const homeView = read('../src/views/HomeView.vue')
const panelComposable = read('../src/composables/useWorkspacePanel.ts')
const sessionsState = read('../src/composables/useSessionsState.ts')

// ——— 1. 统一成员表单组件 TeamMemberFields（建群向导/群管理添加/群管理编辑三处复用）———

const fields = read('../src/components/chat/TeamMemberFields.vue')

test('TeamMemberFields: 成员字段全量面（名字/类型/引用或人格/记忆/五件套平铺无折叠）', () => {
    assert.match(fields, /props\.member\.name/, '名字')
    assert.match(fields, /props\.member\.type/, '类型（radio 对）')
    assert.match(fields, /props\.member\.agentId/, 'agent 引用 select')
    assert.match(fields, /props\.member\.systemPrompt/, 'inline 人格')
    assert.match(fields, /props\.member\.memory/, '记忆开关')
    assert.match(fields, /props\.member\.model/, '模型选择（复用 ModelSelectMenuContent）')
    assert.match(fields, /props\.member\.thinkingLevel/, '思考程度菜单')
    assert.match(fields, /props\.member\.toolsMode/, '工具模式（radio）')
    assert.match(fields, /props\.member\.skillsMode/, '技能模式（radio，inherit/none/custom）')
    assert.match(fields, /props\.member\.extensionsMode/, '扩展白名单模式（radio）')
    // 规范形态（AgentSubagents 同款）：无折叠平铺 + radio 模式 + 卡片网格勾选
    assert.doesNotMatch(fields, /advancedOpen|memberAdvanced/, '无折叠（不再藏高级配置）')
    // v7.4.3：三段模式区收敛为 FilterModeSection 子组件（radio/全选/卡片网格)
    assert.match(fields, /<FilterModeSection title-key="agent.tab.tools"/, '工具段=FilterModeSection')
    // 卡片网格/hint 键随收敛搬入 FilterModeSection（上一用例已钉容器；此处钉 hint 键接线）
    assert.match(fields, /:custom-hint-key="'agent\.tools\.hint'"/, '黑名单语义提示键（复用既有文案）')
    // 两类「默认」语义分开命名（不再混用「跟随群默认」：模型/思考=群会话当前值，
    // 工具/技能/扩展=team-chat-hub 智能体配置全集）
    assert.match(fields, /memberFollowGroupModel/, '模型默认=跟随群当前模型（语义准确）')
    assert.match(fields, /memberFollowGroupThinking/, '思考默认=跟随群当前档位')
    assert.match(fields, /labelKey: 'sidebar\.memberInheritHub'/, '工具/技能/扩展默认=继承群聊智能体')
    assert.match(fields, /memberInheritHubHint/, '继承面说明行（讲清 hub 来源）')
    // 全选单按钮：收敛后经 toggle-all 事件委托（FilterModeSection 内单按钮）
    assert.match(fields, /@toggle-all="\(on: boolean\) => toggleAllTools\(on\)"/, '全选单按钮切换（toggle-all 事件）')
    const fms = read('../src/components/chat/FilterModeSection.vue')
    assert.match(fms, /allSelected\(\) \? t\('common\.deselectAll'\) : t\('common\.selectAll'\)/, '单按钮二态文案（FilterModeSection）')
})

test('team-member 共享加载器：失败不缓存（网络抖动不沉淀为永久空清单）', () => {
    // catch 分支清 in-flight：下次调用重拉。若失败结果被缓存，一次网络抖动会让
    // 工具/技能全集在会话期内永久为空（表单差集投影漂移成全放行）
    const facade = read('../src/utils/team-member.ts')
    assert.match(facade, /catch\(\(\) => \{[\s\S]*?inflightTools\.promise = null[\s\S]*?\}\)/, 'hub 工具加载失败清 in-flight')
    assert.match(facade, /catch\(\(\) => \{[\s\S]*?inflightSkills\.promise = null/, 'hub 技能加载失败清 in-flight')
})

test('TeamMemberFields: buildInlineSource 投影（纯函数核在 utils，行为测试见 team-member.test.ts）', () => {
    // v7.4.3：投影本体从 SFC 静态导出面抽到 utils/team-member-core.ts（零运行时
    // 依赖，node:test 直接 import 行为级断言往返/差集/切分——本锚只钉结构）：
    // 组件 re-export 保持三处消费面 + 本体不再内联在 SFC
    const core = read('../src/utils/team-member-core.ts')
    assert.match(core, /export const buildInlineSource/, '投影函数本体（utils/team-member-core）')
    assert.match(fields, /export \{[\s\S]*buildInlineSource[\s\S]*\} from '\.\.\/\.\.\/utils\/team-member'/, 'SFC re-export 门面（消费面零改）')
    // provider/model 切分口径（首个 /）与黑名单差集语义由行为测试覆盖
    // （tests/team-member.test.ts：round-trip 不漂移/_pending 生命周期/差集）
})

test('TeamMemberFields: _pending 差集残留生命周期（回算消费后清除 + 显式操作清除）', () => {
    // 全集到达回算后 pending 作废：否则用户其后显式清空勾选时 buildInlineSource
    // 兜底把旧差集原样写回（「全不选」被吞）
    assert.ok(fields.includes('props.member._pendingDisabledTools = undefined'), '工具回算后清 pending')
    assert.ok(fields.includes('props.member._pendingDisabledSkills = undefined'), '技能回算后清 pending')
    // 全选/全不选是用户显式表态：同样清除，不再走旧差集兜底
    const toggleIdx = fields.indexOf('const toggleAllTools')
    const toggleWindow = fields.slice(toggleIdx, toggleIdx + 600)
    assert.ok(toggleWindow.includes('_pendingDisabledTools = undefined'), 'toggleAllTools 清 pending')
})

test('TeamMemberFields: 模型/思考下拉复用（不手搓 select）', () => {
    assert.match(fields, /<ModelSelectMenuContent :available-models="availableModels"/, '模型菜单复用 ModelSelectMenuContent')
    assert.match(fields, /Teleport to="body"/, '浮层 Teleport 出弹窗容器（免 overflow 裁剪）')
    assert.doesNotMatch(fields, /v-model="props\.member\.model"[^>]*select/, '模型不再手搓原生 select')
})

test('TeamMemberFields: 高级配置数据源（共享加载器：hub 目录 + 全局扩展清单）', () => {
    // v7.4.3：三份清单改共享加载器（utils/team-member.ts 模块级 in-flight 去重
    // + ok 标记）——向导 N 行成员=1 次请求；ok=false 时调用方保留 _pending
    //（空全集回算会把黑名单漂移成全放行，C-I3）
    const tm = read('../src/utils/team-member.ts')
    assert.match(tm, /export const loadHubToolsOnce/, 'hub 工具共享加载器')
    assert.match(tm, /export const loadHubSkillsOnce/, 'hub 技能共享加载器')
    assert.match(tm, /export const loadExtensionsOnce/, '扩展清单共享加载器')
    assert.match(tm, /ok: tools\.length > 0/, '空全集=失败面（C-I3 守卫数据源）')
    assert.match(fields, /loadHubToolsOnce\(\)\.then\(\(\{ ok \}\) => \{[\s\S]*?if \(!ok\) return/, '组件消费 ok 守卫（不回算不消费 pending）')
})

test('TeamMemberFields: 三处统一复用（向导成员行 / 群管理弹窗——同一 view）', () => {
    const agentGroupManage = read('../src/components/agents/AgentGroupManage.vue')
    assert.match(wizard, /<TeamMemberFields :ref/, '建群向导成员行内嵌组件')
    assert.match(agentGroupManage, /<TeamMemberFields ref="memberFieldsRef"/, '群管理弹窗内嵌组件（添加/编辑共用）')
    // 投影统一走组件实例方法（差集用组件内部全集，免三处各自同步）
    assert.match(wizard, /memberRefs\[index\]\?\.projectSource\(\)/, '向导提交投影=组件方法')
    assert.match(agentGroupManage, /memberFieldsRef\.value\?\.projectSource\(\)/, '弹窗提交投影=组件方法')
})

test('TeamMemberFields: 编辑全字段可改（memberDocToRow 预填 + 无 disabled 锁定）', () => {
    const agentGroupManage = read('../src/components/agents/AgentGroupManage.vue')
    assert.match(fields, /memberDocToRow[,}]/, 'MemberDoc→表单行展平 re-export（本体在 utils/team-member-core）')
    assert.ok(agentGroupManage.includes("memberFormMode === 'edit'"), '编辑态判定存在')
    // 类型/引用/人格/模型/思考全字段开放（旧版 :disabled 锁定删除）
    assert.doesNotMatch(agentGroupManage, /:disabled="memberForm\.mode === 'edit'"/, '编辑态不再锁定类型')
    assert.doesNotMatch(agentGroupManage, /groupEditAgentHint/, 'agent 引用编辑不再只有提示文案')
})

test('TeamGroupWizard: 向导瘦身（字段面全部委托统一组件）', () => {
    // 原五件套断言对象已搬入 TeamMemberFields——向导只剩行卡片/增删/提交投影
    assert.doesNotMatch(wizard, /member\.toolsMode/, '字段面不再在向导内联')
    assert.match(wizard, /newTeamMemberRow/, '行工厂复用组件导出')
    assert.match(wizard, /teamMemberValid/, '校验复用组件导出')
})

test('TeamGroupWizard: 首建 hub 默认模型/思考（hubMissing 才显 + hubDefaults 投影 + 首个 / 拆分）', () => {
    // 首建判定：agentsList 反查 hub（HUB_AGENT_ID 从 utils/team-member re-export，
    // 两仓契约常量同源）；未载时挂载拉 loadAgents 兑底
    assert.match(wizard, /const hubMissing = computed\(\(\) => !agentsState\.agentsList\.some\(a => a\.id === HUB_AGENT_ID\)\)/, 'hubMissing 判定（agentsList 反查 hub）')
    assert.match(wizard, /import \{ HUB_AGENT_ID, THINKING_LEVELS \} from '\.\.\/\.\.\/utils\/team-member'/, 'hub 常量同源 import')
    assert.match(wizard, /if \(!agentsState\.agentsList\?\.length\) agentsState\.loadAgents\?\.\(\)/, 'agentsList 未载时挂载拉取')
    // 只在首建时渲染选择器（v-if 门控）
    assert.match(wizard, /v-if="hubMissing"/, '选择器 hubMissing 门控')
    // 投影：首建 +（模型含 / 或思考非空）才写 hubDefaults——两条独立路径
    // （仅模型投影 / 仅思考投影），仅思考时 provider/model 不携带（模型留
    // 跟随系统缺省不硬塞空 provider）；thinkingLevel 非空才携带（条件展开）
    assert.match(wizard, /if \(hubMissing\.value && \(hubModel\.value\.includes\('\/'\) \|\| hubThinkingLevel\.value\)\) \{/, '首建+（模型含 / 或思考非空）才投影')
    assert.match(wizard, /\.\.\.\(hubModel\.value\.includes\('\/'\) \? \{\s*provider: hubModel\.value\.slice\(0, slash\),\s*model: hubModel\.value\.slice\(slash \+ 1\),\s*\} : \{\}\)/, 'provider/model 仅模型含 / 时条件展开（仅思考路径不带）')
    assert.match(wizard, /\.\.\.\(hubThinkingLevel\.value \? \{ thinkingLevel: hubThinkingLevel\.value \} : \{\}\)/, 'thinkingLevel 条件展开（空不携带）')
    // 拆分口径：首个 /（indexOf，同 buildInlineSource——modelId 可含 /，
    // lastIndexOf 会把 provider 切错导致往返漂移）
    const proj = wizard.match(/const slash = hubModel\.value\.indexOf\('\/'\)[\s\S]{0,300}/)![0]
    assert.match(proj, /provider: hubModel\.value\.slice\(0, slash\)/, 'provider=前段')
    assert.match(proj, /model: hubModel\.value\.slice\(slash \+ 1\)/, 'model=后段')
    assert.doesNotMatch(wizard, /hubModel\.value\.lastIndexOf\('/, '不用 lastIndexOf 拆分')
    // 菜单形态复用：ModelSelectMenuContent + Teleport 浮层 + computeFloatingMenuStyle
    assert.match(wizard, /<ModelSelectMenuContent :available-models="availableModels"/, '模型菜单复用 ModelSelectMenuContent')
    assert.match(wizard, /useFloatingMenu\(\)/, '浮层菜单组合式接线（定位实现唯一在 useFloatingMenu）')
    // payload 类型透传（useSessionsState createTeamGroup 入参含 hubDefaults）
    assert.match(sessionsState, /hubDefaults\?: TeamHubDefaults/, 'createTeamGroup 入参类型含 hubDefaults')
})

// ——— 2. 右栏「群管理」tab ———

test('WorkspacePanel: hub agent → 四 tab（智能体/群/文件/git）；跨群强 remount', () => {
    // v7.4 去特殊化：hub 与普通 agent 同面「智能体」tab（AgentDetail，hub 配置
    // 可改、bot 继承）+ 群 tab；文件/git 照常
    assert.match(workspacePanel, /const isHubAgent = computed\(\(\) => props\.agentId === TEAM_CHAT_HUB_AGENT\)/, 'hub 判定')
    assert.match(workspacePanel, /v-if="isHubAgent" class="tab tab-bordered gap-1"[^>]*@click="panel\.setTab\('groups'\)"/s, 'hub 群 tab')
    // 智能体 tab 不再 v-else（hub 也有）：同 tab 对所有 agent 渲染
    assert.match(workspacePanel, /<a class="tab tab-bordered gap-1" :class="\{ 'tab-active': panelTab === 'agent' \}"\s*@click="panel\.setTab\('agent'\)"/s, '智能体 tab（hub 同样在场）')
    assert.doesNotMatch(workspacePanel, /v-else class="tab tab-bordered gap-1"[^>]*setTab\('agent'\)/s, '智能体 tab 不再被 v-else 排除 hub')
    assert.match(workspacePanel, /const panelTab = computed<'groups' \| 'agent' \| 'files' \| 'git'>/, 'panelTab 归一')
    assert.match(workspacePanel, /tab === 'agent' \|\| tab === 'files' \|\| tab === 'git' \? tab : 'groups'/, 'hub 残留值归位 groups')
    assert.match(workspacePanel, /v-if="isHubAgent && panelTab === 'groups'"[^>]*>\s*<AgentTeamGroups/, 'hub groups tab 内容件（外包边距容器）')
    assert.match(workspacePanel, /:key="'groups-' \+ \(groupSessionId \?\? 'list'\)"/, '跨群强 remount（数据隔离）')
    // 无群上下文（AgentsView 打开 hub / 非群会话）→ 列表形态（sessionId 省略）
    assert.match(workspacePanel, /:session-id="groupSessionId"/, 'sessionId prop 透传（可缺省）')
})

test('AgentDetail: hub = 普通 agent 配置面 + 群 tab（v7.4 去特殊化）', () => {
    const agentDetail = read('../src/components/agents/AgentDetail.vue')
    const agentsView = read('../src/views/AgentsView.vue')
    assert.match(agentDetail, /id: 'groups', label: t\('agent\.tab\.groups'\)/, 'hub 追加群 tab')
    assert.match(agentDetail, /const isHub = computed\(\(\) => props\.agentId === TEAM_CHAT_HUB_AGENT\)/, 'hub 判定（契约常量）')
    assert.match(agentDetail, /<AgentTeamGroups v-if="activeTab === 'groups' && isHub" :show-header="false"/, '群 tab 内嵌（无 header）+ hub 门控（防 activeTab 残留）')
    // AgentsView 不再整页替换：hub 也走 AgentDetail（群 tab 在内）
    assert.doesNotMatch(agentsView, /selectedAgentId === TEAM_CHAT_HUB_AGENT/, 'AgentsView 无 hub 特殊分支')
    assert.match(agentsView, /<AgentDetail v-if="selectedAgentId" :key="selectedAgentId"/, 'hub 同走 AgentDetail + :key 跨 agent 强 remount（同 WorkspacePanel 策略）')
})

test('WorkspacePanel: groupSessionId prop 接线', () => {
    assert.match(workspacePanel, /groupSessionId\?: string/, 'prop 声明')
})

test('HomeView: 群会话行级身份判定并把 groupSessionId 传给两处 WorkspacePanel', () => {
    // 移动端 drawer 宽 90vw/上限 500：四 tab（群/智能体/文件/Git）图标+文字不换行
    assert.match(homeView, /width: min\(90vw, 500px\)/, '移动端 drawer 宽 90vw（四 tab 不换行）')
    // 群 tab 文案（i18n）：「群」短字（原「群管理」挤压 tab 条）
    const zh = read('../src/i18n/zh.ts')
    assert.match(zh, /tabTeam: '群',/, 'tabTeam 短文案（群）')
    // 行级身份判定（非桶位置）：归档群/回收站回填的群行也命中群管理 tab；
    // 判定统一调 useSessionsState 导出的 isGroupSessionRow（不再内联双判）
    assert.match(homeView, /const row = useSessionsState\(\)\.findSessionLocal\(key\)/, '行级判定')
    assert.match(homeView, /isGroupSessionRow\(row\)/, '统一判定 helper')
    const mounts = homeView.match(/<WorkspacePanel[^>]*>/gs) ?? []
    assert.ok(mounts.length >= 2, `应有两处 WorkspacePanel 挂载（PC+移动 drawer，实际 ${mounts.length}）`)
    for (const m of mounts) {
        assert.match(m, /:group-session-id="currentGroupSessionId"/, '挂载点应传 group-session-id')
    }
})

test('useWorkspacePanel/store: tab 联合类型含 groups（hub 群管理 tab 回归）', () => {
    assert.match(panelComposable, /'files' \| 'git' \| 'agent' \| 'groups'/, '四 tab 联合类型')
    assert.doesNotMatch(panelComposable, /'agent' \| 'team'/, 'team 不在联合类型')
    // 值域外残留归位（computed 兜底；hub 面板的 groups 归一在 WorkspacePanel panelTab）
    assert.match(panelComposable, /return tab === 'files' \|\| tab === 'git' \|\| tab === 'groups' \? tab : 'agent'/, '残留值归位 agent')
})

test('AgentGroupManage: 群管理动作面（设群主/移除/记忆/加成员/PATCH 全量 members）', () => {
    const agentGroupManage = read('../src/components/agents/AgentGroupManage.vue')
    assert.match(agentGroupManage, /apiPatch\(`/, 'PATCH 更新')
    assert.match(agentGroupManage, /const next = \[member, \.\.\.rest\]/, '设为群主=置首')
    assert.match(agentGroupManage, /defaultResponder: \{ kind: 'member', memberKey: member\.key \}/, '设群主同步 responder 指向')
    assert.match(agentGroupManage, /membersInput\(next\)/, '移除成员=全量过滤回传')
    // C-I4：移除的是群主/responder 指向成员 → defaultResponder 同步指新群主（防悬空）
    assert.match(agentGroupManage, /defaultResponder: \{ kind: 'member', memberKey: next\[0\]\.key \}/, '移除群主同步 responder 指向')
    assert.match(agentGroupManage, /const membersInput = /, 'MemberDoc→GroupMemberInput 投影')
    // keepDrafts 机制：改成员类动作不覆写群信息弹窗未保存草稿（removeMember
    // 同口径，漏了会在移除成员时把用户编到一半的 name/bulletin/icon 抹回库值）
    assert.match(agentGroupManage, /, \{ keepDrafts: true \}\)/, '改成员类 patch 带 keepDrafts')
    const rmBlock = agentGroupManage.slice(agentGroupManage.indexOf('const removeMember'), agentGroupManage.indexOf('const toggleMemory'))
    assert.match(rmBlock, /keepDrafts: true/, 'removeMember 同口径带 keepDrafts')
    // saveBasics 仅在保存成功（含 saving 守卫未命中）时关弹窗——守卫静默跳过时
    // 关弹窗会让用户误以为已保存
    assert.match(agentGroupManage, /const ok = await patchGroup\(/, 'saveBasics 消费 patchGroup 结果')
    assert.match(agentGroupManage, /if \(ok\) showInfo\.value = false/, '仅成功才关弹窗')
    // 群管理面 PATCH 成功后同步刷新已开群聊的名册/queue 投影（名册到达线不含
    // 管理面变更——不刷则 @ 补全名单陈旧至下回合边界）
    assert.match(agentGroupManage, /chatState\.refreshGroupTurnState\(props\.sessionId\)/, 'PATCH 成功刷新当前群名册')
})

test('AgentGroupManage: 群头像压缩链（FileReader→canvas 最长边 256/jpeg 0.85→dataURL 草稿；保存随 PATCH 落库；同文件重选可再触发）', () => {
    // 服务端 700k 上限约束下的确定性压缩契约——若退化为直接 readAsDataURL 不压缩，
    // 大图 dataURL 必超限被拒（本锚钉住链路不被无声拆断）
    const agentGroupManage = read('../src/components/agents/AgentGroupManage.vue')
    assert.match(agentGroupManage, /const scale = Math\.min\(1, 256 \/ Math\.max\(img\.width, img\.height\)\)/, '最长边 256 等比缩放（不放大）')
    assert.match(agentGroupManage, /canvas\.toDataURL\('image\/jpeg', 0\.85\)/, 'jpeg 0.85 压缩输出')
    // 透明底铺白（PNG→JPEG 无 alpha 通道填 0 会变黑）+ 两级解码失败反馈：
    // 删掉 fillRect 即透明图头变黑回归，锚拦
    assert.match(agentGroupManage, /ctx\.fillStyle = '#ffffff'[\s\S]*?ctx\.fillRect\(0, 0, canvas\.width, canvas\.height\)/, '透明底铺白（PNG→JPEG 不变黑）')
    assert.match(agentGroupManage, /reader\.onerror = \(\) => fail\(\)/, 'FileReader 失败反馈')
    assert.match(agentGroupManage, /img\.onerror = \(\) => fail\(\)/, 'Image 解码失败反馈')
    assert.match(agentGroupManage, /iconDraft\.value = canvas\.toDataURL/, '压缩产物入草稿（非原图 dataURL）')
    assert.match(agentGroupManage, /patchGroup\(\{ name: nameDraft\.value\.trim\(\) \|\| doc\.value\.name, bulletin: bulletinDraft\.value, icon: iconDraft\.value \}\)/, '保存随 PATCH 全量落库（icon null=清除）')
    assert.match(agentGroupManage, /input\.value = ''/, '读后置空 input（同文件重选再触发）')
})

test('群管理面风格统一（同 CronView/PromptEditorModal 形态，不再自拟样式）', () => {
    const agentGroupManage = read('../src/components/agents/AgentGroupManage.vue')
    const wizard = read('../src/components/chat/TeamGroupWizard.vue')
    const fields = read('../src/components/chat/TeamMemberFields.vue')
    // 群头部（v7.5：群信息分区迁 header 编辑弹窗）：圆形头像兑底容器（w-16）
    // + 缺省群聊气泡兑底（原 w-5 分区锚随 section 删除击穿，随迁改锚）
    assert.match(agentGroupManage, /w-16 h-16 rounded-full/, '群头部圆形头像容器（w-16）')
    assert.match(agentGroupManage, /ChatBubbleLeftRightIcon v-else class="w-8 h-8"/, '头像缺省兑底（群聊气泡）')
    assert.match(agentGroupManage, /card bg-base-200 border border-base-300/, '信息卡壳（同 CronView/PromptCard）')
    // 字段：form-control + label-text font-medium（同 PromptEditorModal）
    assert.match(agentGroupManage, /form-control w-full/, '表单字段结构')
    assert.match(wizard, /form-control w-full/, '向导字段结构')
    // 弹窗头：font-bold text-lg + btn-circle btn-ghost XMark w-5 h-5（同 PromptEditorModal）
    for (const src of [agentGroupManage, wizard]) {
        assert.match(src, /font-bold text-lg/, '弹窗标题')
        assert.match(src, /btn btn-sm btn-circle btn-ghost[^"]*"[^>]*>\s*<XMarkIcon class="w-5 h-5"/s, '关闭钮规格')
    }
    // 成员卡：card + card-body p-3 + 底部 border-t 分隔行（同 CronView 任务卡）
    assert.match(agentGroupManage, /card-body p-3 sm:p-4/, '成员卡内距')
    assert.match(wizard, /card bg-base-200 border border-base-300/, '向导成员行卡片化')
    // 不再出现自拟边框色/裸 label
    for (const src of [agentGroupManage, wizard, fields]) {
        assert.doesNotMatch(src, /border-base-content\/10/, '自拟边框色已清除')
    }
    assert.doesNotMatch(agentGroupManage, /text-base font-semibold/, '自拟标题字号已清除')
    // 勾选块容器（AgentSubagents 规范形态：base-200/50 圆角壳 + 卡片网格）
    // v7.4.3：勾选块容器随三段收敛搬入 FilterModeSection
    const fms = read('../src/components/chat/FilterModeSection.vue')
    assert.match(fms, /bg-base-200\/50 rounded-xl border border-base-300/, '勾选块容器（FilterModeSection）')
    assert.match(fms, /bg-base-100 p-2 rounded-lg border border-base-300 hover:border-primary\/30/, '卡片网格（同 AgentSubagents 形态）')
    assert.match(fields, /import FilterModeSection from '\.\/FilterModeSection\.vue'/, 'TeamMemberFields 消费子组件')
})

test('AgentTeamGroups: 列表=格子卡片（照工具卡形态），管理走弹窗（不页面内导航）', () => {
    // v7.4.1：横条卡改居中竖排图标卡（同 AgentTools）：移动端 2 列起步，
    // compact（窄面板）恒 2 列，宽容器响应式 3/4/5 列
    assert.match(agentTeamGroups, /class="grid grid-cols-2 gap-4 p-1"/, '格子布局（移动端 2 列起步；p-1 同工具网格）')
    // 容器不带 padding（边距归挂载环境，双份会比工具 tab 多一圈）
    assert.doesNotMatch(agentTeamGroups, /overflow-y-auto p-4/, '列表/直管容器无自带 padding')
    assert.match(agentTeamGroups, /compact \? '' : 'sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'/, 'compact 恒 2 列 / 宽容器响应式（同 AgentTools）')
    assert.match(agentTeamGroups, /card bg-base-200 border border-base-300 shadow-sm hover:shadow-md hover:border-primary transition-all cursor-pointer/, '卡片壳（同工具卡）')
    assert.match(agentTeamGroups, /ChatBubbleLeftRightIcon class="w-6 h-6"/, '居中图标（群聊气泡）')
    assert.match(agentTeamGroups, /@click="openManage\(s\.id\)"/, '点格开管理弹窗（行 id=壳会话 sessionId）')
    assert.match(agentTeamGroups, /managingGroupId/, '弹窗管理的群 id')
    assert.match(agentTeamGroups, /<AgentGroupManage :session-id="managingGroupId" \/>/, '弹窗内嵌管理面')
    assert.match(agentTeamGroups, /<AgentGroupManage :session-id="sessionId" \/>/, '右栏直管形态复用同件')
    assert.doesNotMatch(agentTeamGroups, /activeGroupId/, '不再页面内导航进入管理')
    // compact prop 接线：AgentDetail 群 tab 透传自身 compact，WorkspacePanel 恒 true（窄面板）
    const agentDetail = read('../src/components/agents/AgentDetail.vue')
    const workspacePanel = read('../src/components/workspace/WorkspacePanel.vue')
    assert.match(agentDetail, /<AgentTeamGroups v-if="activeTab === 'groups' && isHub" :show-header="false"\s*:compact="compact"/, 'AgentDetail 群 tab 透传 compact')
    assert.match(workspacePanel, /:session-id="groupSessionId" :show-header="false" :compact="true"/, 'WorkspacePanel 群 tab 恒 compact（窄面板）')
    assert.match(workspacePanel, /isHubAgent && panelTab === 'groups'"[^>]*class="flex-1 min-h-0 overflow-hidden p-4"/, '右栏群 tab 外包 p-4（AgentTeamGroups 无自带边距）')
})

test('AgentDetail: scrollbar-gutter stable 防容器查询断点抖动（tab 形态稳定）', () => {
    // 滚动条出现/消失会挤压内容区宽度：@sm 容器查询恰在边缘时切 tab（内容长短不同）
    // 会让 tab 条在图标/图标+文字形态间跳变；gutter 恒占位后宽度恒定
    const agentDetail = read('../src/components/agents/AgentDetail.vue')
    assert.match(agentDetail, /flex-1 min-h-0 overflow-y-auto \[scrollbar-gutter:stable\]/, '内容滚动容器 gutter 恒定占位')
})

// ——— 4. 群聊会话生命周期对齐（解散=软删进回收站；归档/置顶可用） ———

const sidebar = read('../src/components/AppSidebar.vue')
const routeState = read('../src/composables/session-route-state.ts')

test('useSessionsState: 群桶体系已删（群行随 /api/sessions 投影进对话桶）', () => {
    // 服务端收束：GET /api/groups 已删（404），群行统一随 GET /api/sessions 投影
    //（sessionCategory='group'、群名=SeedMeta.title）——客户端独立群桶全套符号移除
    assert.doesNotMatch(sessionsState, /groupSessionsResult/, '群桶 state 字段')
    assert.doesNotMatch(sessionsState, /loadGroupSessions/, '群桶加载器')
    assert.doesNotMatch(sessionsState, /teamGroups/, '群原始清单')
    assert.doesNotMatch(sessionsState, /TeamGroupApiRow/, '/groups 行契约类型')
    assert.doesNotMatch(sessionsState, /toGroupRow/, '群行→SessionRow 投影')
    // 置顶/取消置顶统一刷 /api/sessions（排序权威在服务端，群行同桶同源）
    const pinFn = sessionsState.match(/const pinSession = async \(id: string\) => \{[\s\S]*?\n\}/)![0]
    assert.match(pinFn, /await loadSessions\(\)/, 'pin 统一刷 /api/sessions 列表')
    const unpinFn = sessionsState.match(/const unpinSession = async \(id: string\) => \{[\s\S]*?\n\}/)![0]
    assert.match(unpinFn, /await loadSessions\(\)/, 'unpin 统一刷 /api/sessions 列表')
})

test('useSessionsState: deleteTeamGroup 解散=软删进回收站（与 deleteSession 共用本地搬迁）', () => {
    assert.match(sessionsState, /const deleteTeamGroup = async \(shellSessionId: string\)/, '函数存在')
    assert.match(sessionsState, /apiDelete\(`\/api\/extensions\/team-chat\/groups\/\$\{encodeURIComponent\(shellSessionId\)\}`\)/, '走 team-chat 端点（在飞 abort+清单+软删）')
    // 软删本地搬迁抽私有共用段：deleteSession 与 deleteTeamGroup 同一实现
    //（解散群顺带清输入历史——行为对齐普通删除，属改善）
    assert.match(sessionsState, /const relocateSessionToTrashLocal = \(key: string\) =>/, '软删本地搬迁抽私有')
    const deleteSessionFn = sessionsState.match(/const deleteSession = async[\s\S]*?\n\}/)![0]
    assert.match(deleteSessionFn, /relocateSessionToTrashLocal\(key\)/, 'deleteSession 走共用搬迁')
    const deleteTeamGroupFn = sessionsState.match(/const deleteTeamGroup = async[\s\S]*?\n\}/)![0]
    assert.match(deleteTeamGroupFn, /relocateSessionToTrashLocal\(shellSessionId\)/, 'deleteTeamGroup 走共用搬迁')
    assert.match(sessionsState, /deletedSession = \{[\s\S]{0,260}deleted: true,/, '软删态本地标记')
    assert.match(sessionsState, /moveSessionToRouteState\(state, deletedSession, deletedSession\)/, '搬进回收站桶（可恢复）')
})

test('useSessionsState: 群行全链路——建群刷列表出现；解散进回收站；恢复回列表 category=group', () => {
    // 建群即产壳会话行（服务端），刷统一列表侧栏即出现——无群桶专属刷新；
    // 解散→软删本地搬迁进回收站桶（上一用例已钉）；恢复→搬回原桶且分类
    // 原样透传，回列表后 isGroupSessionRow 命中（sidebar toRow 缺省单判，
    // 链路锚见 sidebar-tabs.test.ts）
    const createFn = sessionsState.match(/const createTeamGroup = async \(input: \{[\s\S]*?\n\}/)![0]
    assert.match(createFn, /await loadSessions\(\)/, '建群统一刷 /api/sessions 列表（侧栏出现）')
    const restoreFn = sessionsState.match(/const restoreSession = async \(id: string\) => \{[\s\S]*?\n\}/)![0]
    assert.match(restoreFn, /sessionCategory: known\.sessionCategory/, '恢复行分类透传（group 身份不丢）')
    assert.match(restoreFn, /deleted: false/, '恢复=软删标记清除')
    assert.match(restoreFn, /moveSessionToRouteState\(state, restoredSession, restoredSession\)/, '恢复搬回原桶（group 行→对话桶）')
})

test('session-route-state: 四桶路由——group 行归 sessionsResult（独立群桶已删）', () => {
    // 行为锚（session-route-state 零依赖，node:test 直接驱动）：群行不再有专属桶，
    // 活跃群归对话桶（/api/sessions 统一投影）；归档/软删仍按更高优先级桶走
    assert.equal(getSessionBucketKey({ sessionCategory: 'group' }), 'sessionsResult', '活跃群→对话桶')
    assert.equal(getSessionBucketKey({ sessionCategory: 'group', archived: true }), 'archivedSessionsResult', '归档群→归档桶')
    assert.equal(getSessionBucketKey({ sessionCategory: 'group', deleted: true }), 'deletedSessionsResult', '软删群→回收站桶')
    assert.equal(getSessionBucketKey({ sessionCategory: 'task' }), 'taskSessionsResult', '计划→计划桶')
    assert.equal(getSessionBucketKey(undefined), 'sessionsResult', '缺省→对话桶')
    // 桶字段面：groupSessionsResult 从契约里消失（源级钉）
    assert.doesNotMatch(routeState, /groupSessionsResult/, 'SessionRouteBuckets 无群桶字段')
    // 优先级序：回收站 > 任务 > 归档 > 对话
    const keyFn = routeState.match(/export const getSessionBucketKey[\s\S]*?\n\}/)![0]
    assert.ok(keyFn.indexOf("deletedSessionsResult") < keyFn.indexOf("taskSessionsResult"), '回收站 > 任务')
    assert.ok(keyFn.indexOf("taskSessionsResult") < keyFn.indexOf("archivedSessionsResult"), '任务 > 归档')
    assert.ok(keyFn.indexOf("archivedSessionsResult") < keyFn.indexOf("sessionsResult"), '归档 > 对话')
})

test('session-route-state: 软删搬迁后恢复仍 category=group（群身份随行持久）', () => {
    // 解散/删除 → 回收站桶：分类字段原样保留（不丢群身份）
    const row = { id: 'g1', sessionCategory: 'group' as const, name: '群一' }
    let buckets = moveSessionToRouteState(
        { sessionsResult: null, taskSessionsResult: null, archivedSessionsResult: null, deletedSessionsResult: null },
        row,
        { sessionCategory: 'group', deleted: true },
    )
    assert.equal(buckets.deletedSessionsResult?.sessions[0]?.sessionCategory, 'group', '回收站行保留群分类')
    // 恢复（deleted=false）→ 回对话桶（群行无专属桶），分类仍是 group
    const trashed = buckets.deletedSessionsResult!.sessions[0]
    buckets = moveSessionToRouteState(buckets, trashed, { sessionCategory: 'group', deleted: false })
    assert.equal(buckets.sessionsResult?.sessions[0]?.sessionCategory, 'group', '恢复行归对话桶且分类为 group')
    assert.equal(buckets.deletedSessionsResult?.sessions.length ?? 0, 0, '回收站行已搬空')
})

test('AppSidebar: 群行菜单生命周期对齐（置顶/归档/取消归档/解散；回收站 restore）', () => {
    // 回收站行菜单前置分支：群行例外不给重命名（改壳名会被群库名打回）
    assert.match(sidebar, /if \(sessionTab\.value === 'trash'\) \{[\s\S]{0,200}if \(!session\.isGroup\) \{\s*items\.push\(\{ key: 'rename'/, '回收站群行去 rename')
    // 归档群行：取消归档 + 解散
    assert.match(sidebar, /if \(session\.archived\) \{\s*return \[\s*\{ key: 'unarchive', label: t\('sidebar\.unarchive'\) \},\s*\{ key: 'dissolve'/, '归档群菜单')
    // 活跃群行：置顶/归档/解散
    assert.match(sidebar, /\{ key: session\.pinned \? 'unpin' : 'pin'[^}]+\},\s*\{ key: 'archive', label: t\('sidebar\.archive'\) \},\s*\{ key: 'dissolve'/, '活跃群菜单')
    // 解散守卫放宽到归档桶（归档群可解散）
    assert.match(sidebar, /archivedSessionsResult\?\.sessions\?\.some\(s => s\.id === session\.key\)/, '归档桶守卫')
    // 归档/回收站桶群行识别均只按分类单判（不误伤手聊 hub 的普通删/归档会话；
    // 服务端 /deleted 已透传分类，旧数据退化普通行=预期——spec 9.11 零 fallback）；
    // 三桶统一走 toRow 默认参数 isGroupSessionRow，无桶级别名/覆写残留
    assert.match(sidebar, /const toRow = \(s: SessionRow, isGroup = isGroupSessionRow\(s\)\): DisplaySession => \(/, '三桶统一单判入口')
    assert.doesNotMatch(sidebar, /isDeletedGroupRow|isArchivedGroupRow|groupJudge/, '无桶级别名/覆写残留')
})

test('AppSidebar: 群行天然在统一列表（无本地归并），排序权威在服务端', () => {
    // 群桶删除后无「置顶群/置顶普通两段拼头 + 未置顶游标混排」本地归并：群行
    // 天然混排在 chats 统一列表，置顶前置+modified 倒序由服务端排序保证，本地
    // 只投影 pinned 标记渲染钉头 icon；分组视图同管线（群行 agentId=hub 自然
    // 归 hub agent 组，组内顺序=列表序，无伪组特判）
    assert.match(sidebar, /return \(sessionsState\.sessionsResult\?\.sessions \?\? \[\]\)\.map\(\(s: SessionRow\) => toRow\(s\)\)/, 'chats 直出统一列表（群行天然在列表）')
    assert.doesNotMatch(sidebar, /groupDisplays/, '伪组显示层已删')
    assert.doesNotMatch(sidebar, /pinnedGroup|pinnedNormal|unpinnedGroup|unpinnedNormal/, '两段拼头/混排游标符号已删')
    assert.doesNotMatch(sidebar, /merged\.push/, '本地归并拼序已删')
    assert.match(sidebar, /const idx = indexOf\.get\(session\.agentId\)/, '分组按 agentId（群行无伪组特判）')
})

// ——— 数据层行为锚（esbuild 打包真实 useSessionsState 驱动）———

const harnessStubs: Record<string, string> = {
    tauri: 'export const invoke = async () => ({}); export const listen = async () => () => {}; export default {};',
    i18n: 'export const i18n = { global: { t: (k: string) => k, te: () => true, locale: { value: "zh" } }, t: (k: string) => k }; export default i18n;',
    router: 'const router = { push: async () => {}, replace: async () => {}, afterEach: () => {} }; export default router;',
    'notify-client': 'export const connectBrowserWs = async () => {}; export const disconnectBrowserWs = () => {}; export const getWsUrl = () => ""; export const sendBrowserWs = async () => false;',
}

function harnessStubPlugin() {
    return {
        name: 'seedcode-team-chat-test-stubs',
        setup(b: any) {
            b.onResolve({ filter: /^@tauri-apps\// }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onResolve({ filter: /\/i18n$/ }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onResolve({ filter: /\/router$/ }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onResolve({ filter: /notify-client$/ }, (a: any) => ({ path: a.path, namespace: 'stub' }))
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args: any) => {
                const key = args.path.startsWith('@tauri-apps')
                    ? 'tauri'
                    : args.path.endsWith('/i18n') ? 'i18n'
                    : args.path.endsWith('/router') ? 'router'
                    : args.path.endsWith('notify-client') ? 'notify-client'
                    : 'tauri'
                return { contents: harnessStubs[key], loader: 'ts', resolveDir: testDir }
            })
        },
    }
}

test('useSessionsState: isGroupSessionRow 单判 sessionCategory（hub agentId 误判修复）', async () => {
    // 判定单化：服务端 origin 分类是唯一权威——agentId=team-chat-hub 的 hub 壳
    // 普通会话不再被误判为群（否则发送/分流会走错 team-chat 端点）
    const outDir = path.join(testDir, '.tmp-isgroup-harness')
    await mkdir(outDir, { recursive: true })
    const entryPath = path.join(outDir, 'entry.ts')
    await writeFile(entryPath, `
;(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { (globalThis as any).window = { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) } } catch {}
;(globalThis as any).document = { createElement: () => ({ style: {} }), addEventListener: () => {}, removeEventListener: () => {} }

import { createPinia, setActivePinia } from 'pinia'
setActivePinia(createPinia())

const { isGroupSessionRow } = await import('${repoFile('../src/composables/useSessionsState.ts')}')

console.log('GROUP ' + isGroupSessionRow({ sessionCategory: 'group' }))
console.log('HUB_DEFAULT ' + isGroupSessionRow({ sessionCategory: 'default', agentId: 'team-chat-hub' }))
console.log('HUB_ONLY ' + isGroupSessionRow({ agentId: 'team-chat-hub' }))
console.log('NULL ' + isGroupSessionRow(null))
console.log('EMPTY ' + isGroupSessionRow({}))
`, 'utf8')
    const run = await (async () => {
        try {
            await build({
                entryPoints: [entryPath],
                bundle: true,
                platform: 'node',
                format: 'esm',
                outfile: path.join(outDir, 'harness.mjs'),
                external: ['vue', 'pinia'],
                logLevel: 'silent',
                plugins: [harnessStubPlugin()],
            })
            return spawnSync(process.execPath, [path.join(outDir, 'harness.mjs')], { encoding: 'utf8' })
        } finally {
            await rm(outDir, { recursive: true, force: true })
        }
    })()
    assert.equal(run.status, 0, 'harness 应正常退出\n' + run.stderr)
    const out = (key: string) => run.stdout.split('\n').find(line => line.startsWith(key + ' '))?.slice(key.length + 1).trim()
    assert.equal(out('GROUP'), 'true', 'sessionCategory=group → true')
    assert.equal(out('HUB_DEFAULT'), 'false', 'default 分类 + hub agentId → false（修误判）')
    assert.equal(out('HUB_ONLY'), 'false', '仅 hub agentId 无分类 → false（缺省=default）')
    assert.equal(out('NULL'), 'false', 'null 行 → false')
    assert.equal(out('EMPTY'), 'false', '空对象行 → false')
})

test('useChatState/ChatInput: 群分流行级身份判定（归档群不迷路）', () => {
    const chatState = read('../src/composables/useChatState.ts')
    // 发送分流：按行身份（分类/agentId）而非群桶 membership——归档群点开发消息
    // 必须仍走 team-chat 端点（否则消息黑洞进 hub 壳普通会话）；判定统一
    // isGroupSessionRow（不再内联双判）
    assert.match(chatState, /const rowForGroup = sessionsStateForGroup\.findSessionLocal\(targetKey\)/)
    assert.match(chatState, /const isGroupSession = isGroupSessionRow\(rowForGroup\)/)
    // @ 成员补全注入同款行级判定（归档群聊天也有成员补全）
    assert.match(read('../src/components/chat/ChatInput.vue') , /const row = sessionsState\.findSessionLocal\(key\)/)
    assert.match(read('../src/components/chat/ChatInput.vue'), /row && isGroupSessionRow\(row\) \? key : ''/)
})

test('AgentGroupManage: 成员表单弹窗（添加/编辑共用一套）+ key 原样回传', () => {
    const tab = read('../src/components/agents/AgentGroupManage.vue')
    // 单弹窗单表单：formOpen/formTitle 双模式（添加=空表单；编辑=预填锁定类型）
    assert.match(tab, /v-if="formOpen" class="modal modal-open/, '共用表单弹窗')
    assert.match(tab, /memberFormMode\.value === 'edit' \? t\('sidebar.groupEditMember'\)/, '标题双模式')
    // 编辑全字段可改（用户裁决：旧版 :disabled 锁定删除）——组件复用后字段面同添加
    assert.doesNotMatch(tab, /:disabled="memberForm\.mode/, '编辑态不再锁定字段')
    // 提交分流：添加=追加（key 空，服务端重算）；编辑=替换（key 原样回传）
    assert.match(tab, /if \(memberFormMode\.value === 'add'\) \{/, '提交分流')
    assert.match(tab, /list\.map\(m => \(\{ key: m.key,/, 'membersInput 回传 key')
    assert.match(tab, /改名后 key 稳定/, '编辑保记忆注释')
})

test('useSessionsState: TeamGroupMemberInput 可选 key（编辑沿用）', () => {
    assert.match(sessionsState, /key\?: string/, '可选 key 字段')
})

// ——— 5. 群聊视图按钮收敛 + 回合等待态 ———

test('MessageBubble: 群消息隐藏编辑/分支/重试按钮（isTeamMessage 门控）', () => {
    const bubble = read('../src/components/chat/MessageBubble.vue')
    assert.match(bubble, /const isTeamMessage = computed\(\(\) => props\.message\.speaker !== undefined\)/, '群消息判定=投影 speaker 在场')
    // 5 个动作按钮全部带 !isTeamMessage 门控（user 侧 edit/fork/retry + assistant 侧 fork/retry）
    const gated = bubble.match(/!isTeamMessage/g) ?? []
    assert.ok(gated.length >= 7, `动作按钮门控数（5 按钮+2 分支导航容器）>=7，实为 ${gated.length}`)
    assert.match(bubble, /isTeamMessage" @click="startEdit"/, '编辑按钮门控')
    assert.match(bubble, /isTeamMessage" @click="emit\('fork', message\)"/, 'fork 按钮门控（两侧同款行）')
    assert.match(bubble, /isTeamMessage" @click="emit\('retry', message\)"/, '重试按钮门控（两侧同款行）')
})

test('ChatHeader: 移动端会话树按钮群会话隐藏（树对群无意义，行级判定）', () => {
    const header = read('../src/components/chat/ChatHeader.vue')
    // 群壳会话消息全是 custom entry（team.bot_message），树投影无 preview——分支
    // 导航（retry/edit）对群无场景，移动端树按钮隐藏；桌面 SessionTreeRail 不动
    // （用户只提移动端）。判定统一 isGroupSessionRow（行级身份，非桶位置——归档
    // 群/回收站回填的群行同样命中）
    assert.match(header, /import \{ useSessionsState, isGroupSessionRow \} from '\.\.\/\.\.\/composables\/useSessionsState'/, '判定 helper 同源 import')
    assert.match(header, /const row = sessionsState\.findSessionLocal\(key\)/, '行级判定')
    assert.match(header, /return isGroupSessionRow\(row\)/, '统一判定 helper（不内联双判）')
    assert.match(header, /<button v-if="isSession && !isGroupSession" @click="emit\('open-session-tree'\)"/, '树按钮 v-if 含群排除判定')
})

test('useChatState: 群回合等待态生命周期（发送置位→ext.team_state 熄灭→开群恢复）', () => {
    const cs = read('../src/composables/useChatState.ts')
    assert.match(cs, /groupTurnBusy\?: boolean/, '会话数据字段')
    // 发送置位：POST 前（dispatched 前即亮——用户消息刚发出就该有反馈）
    assert.match(cs, /sessionData\.groupTurnBusy = true/, '发送置位')
    // skip / 失败路径熄灭（条件熄灭：排队残留时保持等待态——本地 queue 仍是
    // 真相源，清 busy 会让 GroupTurnBar 提前消失；零排队才熄灭）
    assert.match(cs, /if \(!\(sessionData\.groupTurnQueue\?\.length\)\) sessionData\.groupTurnBusy = false/, 'skip/失败仅零排队才熄灭（排队残留保持等待态）')
    // WS 终态广播消费（v7.5 起消费契约常量，与 AgentGroupTasks 同源不再内联字面量）
    assert.match(cs, /event === TEAM_STATE_EVENT/, 'WS 事件接线（契约常量）')
    assert.match(cs, /sd\.groupTurnBusy = data\?\.busy === true/, 'busy 投影赋值')
    // 开群恢复（页面刷新/切走错过广播时兑底）+ 回合边界拉新同源：queue 投影恢复
    assert.match(cs, /function refreshGroupTurnState\(sessionId: string\)/, '拉新收敛单点')
    assert.match(cs, /refreshGroupTurnState\(key\)/, '开群拉群详情')
    assert.match(cs, /refreshGroupTurnState\(sessionId\)/, 'ext.team_state 回合边界拉新')
    assert.match(cs, /groupTurnBusy = result\.queue\.length > 0/, 'queue 投影恢复')
    // 同群并发拉新序号守卫（晚到的旧 GET 不得覆盖新状态）+ POST 成功即触发新序号
    // 拉新（防在途旧 GET 取数早于入队、返回时抹掉乐观项的取数竞态）
    assert.match(cs, /groupTurnRefreshSeq\.get\(sessionId\) !== seq/, 'seq 守卫丢弃过期响应')
    assert.match(cs, /refreshGroupTurnState\(targetKey\)\n/, 'POST 成功即拉新（新序号作废在途旧 GET）')
    // 失败回滚按乐观泡 id 精确删（位置切片在并发连发下会误删他人乐观泡）
    assert.match(cs, /filter\(m => \(m as any\)\.id !== optimisticId\)/, '失败回滚按 id 精确删')
    // 图片丢弃提示先于空文本守卫（图片-only 发送也要有反馈）
    const sendOrder = cs.indexOf("t('chat.groupImageUnsupported')")
    const guardOrder = cs.indexOf('if (!text.trim()) return')
    assert.ok(sendOrder > -1 && guardOrder > -1 && sendOrder < guardOrder, '图片 toast 先于空文本守卫')
})

test('HomeView: 群回合等待态指示器（loading-dots 挂消息区尾部）', () => {
    assert.match(homeView, /v-if="groupTurnBusy"/, '指示器渲染门控')
    assert.match(homeView, /loading loading-dots loading-sm/, '打字点样式')
    assert.match(homeView, /const groupTurnBusy = computed/, '数据源 computed')
    // 数据源=当前会话是群（行级判定复用 currentGroupSessionId）
    assert.match(homeView, /currentGroupSessionId\.value\) return false/, '群会话判定门控')
})

// ——— 6. 群聊收敛：输入框/右栏 tab 隐藏 + 命令守卫 ———

test('ChatInput: 群会话命令菜单保留（仅客户端命令段）+ 权限/模型/思考隐藏', () => {
    const ci = read('../src/components/chat/ChatInput.vue')
    // 命令按钮群聊保留（菜单里过滤服务端命令段——客户端面板命令在群里可用）
    assert.match(ci, /v-if="!centered" class="dropdown dropdown-top/, '命令按钮群聊保留')
    assert.ok(!ci.includes('v-if="!centered && !currentGroupSessionKey"'), '命令按钮不再整体隐藏')
    // 菜单：服务端命令段（常用命令+COMMANDS）仅非群渲染；群聊标题=客户端命令
    assert.match(ci, /<template v-if="!currentGroupSessionKey">[\s\S]{0,120}chat\.commonCommands/, '服务端命令段门控')
    // v7.4.3 M3：群聊里客户端命令是唯一段，标题恒显示（原 !currentGroupSessionKey
    // 把标题藏了但命令还在——裸列无分组）
    assert.match(ci, /v-if="clientCommandItems\.length" class="menu-title"/, '客户端命令段标题恒显（群聊唯一段有分组头）')
    // 权限/模型/思考按钮仍隐藏（群聊里无意义）
    assert.match(ci, /v-if="permAvailable && !currentGroupSessionKey"/, '权限按钮门控')
    assert.match(ci, /v-if="!currentGroupSessionKey" class="dropdown dropdown-top" :class="{ 'dropdown-open': modelDropdownOpen }"/, '模型按钮门控')
    assert.match(ci, /v-if="!currentGroupSessionKey" class="dropdown dropdown-top" :class="{ 'dropdown-open': thinkingDropdownOpen }"/, '思考按钮门控')
})

test('useChatInput: 群会话 / 补全含 prompt/skill 资源命令（服务端 team-chat 端点展开投递）', () => {
    const uci = read('../src/composables/useChatInput.ts')
    assert.match(uci, /const isGroupChatSession = \(\): boolean =>/, '群判定 helper')
    assert.match(uci, /return isGroupSessionRow\(row\)/, '行级身份判定（统一 helper）')
    // 群聊过滤：只排除 builtin/extension（主会话语义），prompt/skill 照常公告
    assert.match(uci, /const serverMatches = isGroupChatSession\(\)\s*\n\s*\? filterCommands\.value\(query\)\.filter\(cmd => cmd\.source === 'prompt' \|\| cmd\.source === 'skill'\)/, '群聊公告面：prompt/skill 来源放行')
})

test('HomeView: 群会话命令守卫 v2（prompt/skill 放行，内置/扩展命令拦下）', () => {
    assert.ok(homeView.includes("inputText.startsWith('/')"), '守卫条件')
    // 拦截判据：builtin/extension 来源的已知命令名才拦；skill/prompt/未知 /xxx 放行透传
    assert.ok(homeView.includes("cmd.source === 'builtin' || cmd.source === 'extension'"), '按 source 判拦')
    assert.match(homeView, /t\('chat.groupCommandBlocked'\)/, '拦截 toast 走 i18n（chat.groupCommandBlocked）')
    // 守卫位于纯 UI 客户端命令（tree/taskbar 面板开关）之后、knownCommandNames 之前
    const guard = homeView.indexOf("'chat.groupCommandBlocked'")
    const taskbar = homeView.indexOf('taskBarCommand')
    const known = homeView.indexOf('const knownCommandNames')
    assert.ok(taskbar < guard && guard < known, '守卫次序：客户端面板命令放行其后')
})

test('AgentsView: hub agent 同走 AgentDetail（v7.4 去特殊化，群 tab 在 AgentDetail 内）', () => {
    const av = read('../src/views/AgentsView.vue')
    assert.doesNotMatch(av, /<AgentTeamGroups/, 'hub 不再整页替换成群管理视图')
    assert.match(av, /@back="clearSelection"/, '移动端返回接线')
    assert.match(av, /<AgentDetail v-if="selectedAgentId"/, '所有 agent（含 hub）同一 AgentDetail')
})

test('AgentTeamGroups: 双形态（带 sessionId=直管 / 缺省=群列表格子+管理弹窗）', () => {
    assert.match(agentTeamGroups, /sessionId\?: string/, 'sessionId 可选')
    assert.match(agentTeamGroups, /<ViewHeader v-if="showHeader" :title="headerTitle" wc-pad>/, '顶栏复用 ViewHeader（同 AgentDetail，不手搓）')
    // v7.4.3 A-4.1：群列表单真相——群行随 /api/sessions 统一投影进对话桶，
    // 过滤走 isGroupSessionRow 权威面（9.7 规则 1：行级群判定唯一权威面，
    // 不内联重写 sessionCategory 判定）；刷新走 loadSessions——不再组件自管
    // fetch（多真相漂移：侧栏解散不消行/向导建群不出现）
    assert.match(agentTeamGroups, /sessionsState\.sessionsResult\?\.sessions \?\? \[\]\)\.filter\(isGroupSessionRow\)/, '列表数据源=对话桶过滤群行（单真相，权威面判定）')
    assert.match(agentTeamGroups, /import \{ TEAM_CHAT_HUB_AGENT, useSessionsState, isGroupSessionRow \}/, 'isGroupSessionRow 从 useSessionsState 导入')
    assert.match(agentTeamGroups, /await sessionsState\.loadSessions\(\)/, '刷新走同源 loader（loadSessions）')
    assert.doesNotMatch(agentTeamGroups, /apiGet<GroupListRow/, '不再自管 fetch')
    assert.match(agentTeamGroups, /managingGroupId\.value = id/, '点格进入管理弹窗')
    assert.match(agentTeamGroups, /managingGroupId\.value = undefined/, '关闭弹窗回列表')
    assert.match(agentTeamGroups, /void loadGroups\(\)/, '弹窗关闭回刷列表')
})

// ——— 7. 群 busy 条 + stop 按钮（GroupTurnBar dock widget）———

test('GroupTurnBar: 群 busy 条 + stop 按钮（MusicBar 同形态，注册进 ChatDockArea）', () => {
    const bar = read('../src/components/chat/GroupTurnBar.vue')
    const dock = read('../src/components/chat/ChatDockArea.vue')
    // 注册进 dock 区（widget 自决定显隐）
    assert.match(dock, /registerChatDockWidget\(\{ id: 'group-turn', order: 11, component: GroupTurnBar \}\)/, 'dock 注册')
    // 行级群身份判定（唯一权威面 isGroupSessionRow，不内联双判）
    assert.match(bar, /isGroupSessionRow\(row\)/, '统一判定 helper')
    assert.doesNotMatch(bar, /sessionCategory === 'group' \|\|/, '不内联双判')
    // stop 按钮 → team-chat stop 端点（停队首在飞回合，waiting 后继自动推进）
    assert.match(bar, /apiPost\(`\/api\/extensions\/team-chat\/groups\/\$\{encodeURIComponent\(key\)\}\/stop`/, 'stop 端点')
    assert.match(bar, /btn btn-ghost btn-xs btn-circle[^"]*hover:text-error/, '停止钮规格（MusicBar 同构）')
    assert.match(bar, /<StopIcon class="h-3\.5 w-3\.5"/, 'StopIcon 图标')
    // MusicBar/TaskBar 同形态：折叠条壳 + 展开清单（封顶滚动）+ 条目卡
    assert.match(bar, /border-t border-base-300 bg-base-100\/40 px-4 py-1 text-xs select-none/, '折叠条壳（dock widget 同构）')
    assert.match(bar, /max-h-64 overflow-y-auto/, '展开清单封顶滚动')
    assert.match(bar, /rounded-lg border border-base-300 bg-base-200 px-2 py-1/, '条目卡（MusicBar 逐曲清单同构）')
    // 数据源 = useChatState 的 groupTurnQueue 投影（不自己拉不自己存）
    assert.match(bar, /groupTurnQueue/, 'queue 投影数据源')
})

test('useChatState: 群回合队列投影（发送 append / 回合边界拉新 / 名册随行）', () => {
    const cs = read('../src/composables/useChatState.ts')
    assert.match(cs, /groupTurnQueue\?: GroupTurnQueueItem\[\]/, '队列字段')
    assert.match(cs, /groupMembers\?: \{ key: string; name: string \}\[\]/, '成员名册字段')
    // 发送成功本地 append（乐观推进，回合边界拉新兑正）；skip 不入队
    assert.match(cs, /sessionData\.groupTurnQueue = \[\.\.\.\(sessionData\.groupTurnQueue \?\? \[\]\)/, '发送 append')
    // queue 与 members 同源拉取（一次 GET 两投影都兑正）
    assert.match(cs, /sd\.groupTurnQueue = result\.queue/, 'queue 赋值')
    assert.match(cs, /sd\.groupMembers = result\.members\.map/, '名册赋值')
})

// ——— 8. 群管理任务 tab（v7.3：任务历史 + 轨迹抽屉复用）———

test('AgentGroupManage: tab 结构照抄 AgentDetail（任务第一 tab + 成员第二 tab）', () => {
    const manage = read('../src/components/agents/AgentGroupManage.vue')
    // 胶囊 tablist 同构（AgentDetail 逐类照抄：容器查询 + 胶囊壳 + 选中态）
    assert.match(manage, /role="tablist"/, 'tablist 语义')
    assert.match(manage, /bg-base-300 p-1 rounded-full flex relative shadow-inner w-\[90%\] @2xl:w-\[60%\] gap-1/, '胶囊壳照抄 AgentDetail')
    assert.match(manage, /:class="activeTab === tab.id \? 'bg-base-100 text-base-content shadow-sm scale-100' : 'text-base-content\/55 hover:text-base-content'"/, '选中态照抄')
    // 任务第一 tab（default 'tasks'），成员 tab 包原有管理面
    assert.match(manage, /const activeTab = ref\('tasks'\)/, '任务 tab 缺省激活')
    assert.match(manage, /\{ id: 'tasks', label: t\('sidebar.groupTasksTab'\), icon: ClipboardDocumentListIcon \}/, '任务 tab 定义')
    assert.match(manage, /\{ id: 'members', label: t\('sidebar.groupMembersSection'\), icon: UsersIcon \}/, '成员 tab 定义')
    assert.match(manage, /<AgentGroupTasks v-if="activeTab === 'tasks'" :key="sessionId" :session-id="sessionId"/, '任务 tab 接线（:key=切群重建，评审 C-I3）')
    assert.match(manage, /if \(props.sessionId !== sid\) return/, 'load 代际防护（晚到响应不回填错群）')
})

test('AgentGroupTasks: 任务列表 + 点击复用轨迹抽屉（自定义轨迹源）', () => {
    const tasks = read('../src/components/agents/AgentGroupTasks.vue')
    // 列表数据面：GET /tasks 分页（cursor 透传）
    assert.match(tasks, /\/api\/extensions\/team-chat\/groups\/\$\{encodeURIComponent\(props.sessionId\)\}\/tasks/, '任务列表端点')
    assert.match(tasks, /nextCursor/, '分页游标')
    // 无感续载：哨兵自动拉页（无按钮——分页是服务端安全阀不该意示给用户）
    assert.match(tasks, /new IntersectionObserver/, '哨兵自动续载')
    assert.doesNotMatch(tasks, /common\.loadMore/, '无「加载更多」按钮')
    // 点击 → 详情 → 轨迹抽屉（subId=childSession，traceUrl 按成员键寻址）
    assert.match(tasks, /\/tasks\/\$\{task.taskId\}\/trace\/\$\{encodeURIComponent\(memberKey\)\}\?offset=\$\{offset\}/, 'traceUrl 端点（subId→memberKey 映射）')
    assert.match(tasks, /if \(memberKey === undefined\) throw new Error\(t\('groupTasks.noTrace'\)\)/, '映射缺失显式提示（评审 C-M1）')
    assert.match(tasks, /managedConfig: false/, '非受管配置目标（隐藏模型行）')
    assert.match(tasks, /useSubagentTrace\(\)/, '抽屉复用（不自建查看器）')
    // 评审 C-I1：statusBadge/traceActive 词表收敛（orphaned/未知终态→error，防尾条永久假流式）
    assert.match(tasks, /\? \(task.outcome === 'completed' \? 'completed' : task.outcome === 'aborted' \? 'aborted' : 'error'\)/, '终态词表收敛')
    // 评审 C-I2：在途载期间到达的回合边界事件不丢弃（补刷标记）
    assert.match(tasks, /if \(refreshPending\) \{/, '事件补刷')
    // ext.team_state 回合边界刷新（v7.4.3 起消费契约常量，不再内联字面量）
    assert.match(tasks, /onExtensionEvent\(TEAM_STATE_EVENT/, '回合边界刷新（契约常量）')
    // 任务卡 CronView 形态
    assert.match(tasks, /card bg-base-200 border border-base-300 shadow-sm/, '任务卡形态')
    assert.match(tasks, /border-t border-base-300/, '底行分隔')
})

test('SubagentTraceDrawer: 自定义轨迹源 + 非受管配置门控', () => {
    const drawer = read('../src/components/chat/SubagentTraceDrawer.vue')
    const composable = read('../src/composables/useSubagentTrace.ts')
    // poll() 走 traceUrl（缺省 subagents 侧车路由——原路径不破坏）
    assert.match(drawer, /t.traceUrl !== undefined/, '自定义轨迹源分派')
    assert.match(drawer, /\/api\/extensions\/subagents\/sessions\/\$\{t.parentSessionId\}\/subagents\/\$\{subId\}\?offset=/, 'subagents 缺省路径保留')
    // 配置面门控：managedConfig=false 不拉 config 不显下拉
    assert.match(drawer, /managedConfig !== false/, 'config 拉取门控')
    assert.match(drawer, /v-if="managedConfig" ref="modelMenuRef"/, '模型下拉门控')
    // target 契约扩展（open 第四参 options 透传）
    assert.match(composable, /traceUrl\?: \(subId: string, offset: number\) => string/, 'traceUrl 契约')
    assert.match(composable, /managedConfig\?: boolean/, 'managedConfig 契约')
})

// ——— 复用收拢（同源常量/判定/浮层定位/思考档位唯一权威面，防再散落）———

test('复用收拢: 群判定/hub 常量/浮层定位/思考档位统一同源（不再内联抄写）', () => {
    const sessionsState = read('../src/composables/useSessionsState.ts')
    // 1) 行级群判定唯一权威面：useSessionsState 导出，消费处一律调用
    assert.match(sessionsState, /export const isGroupSessionRow/, 'helper 导出')
    const consumers = [
        ['../src/components/chat/ChatInput.vue', homeView => homeView],
        ['../src/views/HomeView.vue', s => s],
        ['../src/composables/useChatInput.ts', s => s],
        ['../src/composables/useChatState.ts', s => s],
    ] as const
    for (const [file] of consumers) {
        const src = read(file)
        assert.doesNotMatch(src, /sessionCategory === 'group' \|\| \w+\.agentId === 'team-chat-hub'/, `${file}：不再内联双判`)
    }
    // 2) hub 常量唯一权威：TEAM_CHAT_HUB_AGENT（AppSidebar/TeamMemberFields 不再本地定义字面量）
    assert.match(sessionsState, /export const TEAM_CHAT_HUB_AGENT = 'team-chat-hub'/, '常量导出')
    assert.doesNotMatch(read('../src/components/AppSidebar.vue'), /const TEAM_CHAT_HUB = /, 'AppSidebar 不再本地常量')
    assert.doesNotMatch(read('../src/components/chat/TeamMemberFields.vue'), /= 'team-chat-hub'/, 'TeamMemberFields 不再字面量定义')
    // 3) 浮层定位唯一实现：utils/floating-menu；接线唯一实现：useFloatingMenu
    //    组合式（单元+组：开合/外点关闭/视口跟随/生命周期挂卸）——三个消费组件
    //    （TeamMemberFields/TeamGroupWizard/AgentSubagents）全部经组合式，不再各持
    const floating = read('../src/utils/floating-menu.ts')
    assert.match(floating, /export function computeFloatingMenuStyle/, '公共函数')
    assert.match(read('../src/composables/useFloatingMenu.ts'), /computeFloatingMenuStyle\(/, '组合式单元调公共定位')
    assert.match(read('../src/composables/useFloatingMenu.ts'), /export function useFloatingMenuGroup/, '菜单组导出（外点关/视口跟随/生命周期）')
    for (const file of ['../src/components/chat/TeamMemberFields.vue', '../src/components/chat/TeamGroupWizard.vue', '../src/components/agents/tabs/AgentSubagents.vue']) {
        assert.match(read(file), /useFloatingMenuGroup\(\[/, `${file} 浮层菜单组接线`)
    }
    for (const file of ['../src/components/chat/TeamMemberFields.vue', '../src/components/chat/TeamGroupWizard.vue', '../src/components/agents/tabs/AgentSubagents.vue']) {
        assert.doesNotMatch(read(file), /document\.addEventListener\('click', handle\w*\)/, `${file} 不再自管外点监听`)
    }
    // 4) 思考档位唯一权威：utils/thinking-levels（ChatInput/TeamMemberFields/ModelFormModal 三处 import）
    assert.match(read('../src/utils/thinking-levels.ts'), /export const THINKING_LEVELS/, '档位表导出')
    for (const file of ['../src/components/chat/ChatInput.vue', '../src/components/chat/TeamMemberFields.vue', '../src/components/models/ModelFormModal.vue']) {
        assert.doesNotMatch(read(file), /\[?'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'\]/, `${file} 不再内联档位数组`)
    }
})
