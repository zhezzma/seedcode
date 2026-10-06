import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const sidebarSource = readFileSync(path.join(root, 'src/components/AppSidebar.vue'), 'utf8')

test('sidebar defines four session tabs with pill segmented-control styling', () => {
    assert.match(sidebarSource, /export type SidebarSessionTab = 'chats' \| 'plans' \| 'archived' \| 'trash'/)
    // 四个 tab 由 SESSION_TABS 配置驱动（v-for 渲染），各有 label；
    // 纯文字档：窄侧栏四档加图标会被挤到截断，禁止图标配置残留
    assert.match(sidebarSource, /const SESSION_TABS: Array<\{ key: SidebarSessionTab, labelKey: string \}> = \[/)
    assert.match(sidebarSource, /\{ key: 'chats', labelKey: 'sidebar\.tabChats' \}/)
    assert.match(sidebarSource, /\{ key: 'plans', labelKey: 'sidebar\.tabPlans' \}/)
    assert.match(sidebarSource, /\{ key: 'archived', labelKey: 'sidebar\.tabArchived' \}/)
    assert.match(sidebarSource, /\{ key: 'trash', labelKey: 'sidebar\.tabTrash' \}/)
    assert.doesNotMatch(sidebarSource, /icon: ChatBubbleLeftRightIcon/)
    assert.doesNotMatch(sidebarSource, /icon: CalendarDaysIcon/)
    assert.doesNotMatch(sidebarSource, /icon: ArchiveBoxIcon/)
    assert.doesNotMatch(sidebarSource, /icon: TrashIcon/)
    // 胶囊分段控件：圆角灰底容器，选中项白底描边阴影
    assert.match(sidebarSource, /rounded-full bg-base-300 p-1/)
    assert.match(sidebarSource, /sessionTab === tab\.key\s*\n\s*\? 'bg-base-100 border-base-300 shadow-sm text-base-content'/)
    // 每个 tab 都有可访问性选中态
    assert.match(sidebarSource, /:aria-selected="sessionTab === tab\.key"/)
    // 旧 daisyUI tabs-boxed 结构不应残留
    assert.doesNotMatch(sidebarSource, /tabs tabs-boxed/)
    assert.doesNotMatch(sidebarSource, /tab-active/)
})

test('sidebar group toggle renders sessions grouped by agent', () => {
    // #分组 开关在 tab 分段控件右侧，aria-pressed 表达开启态
    // 开关状态持久化到 UI 设置 store（localStorage），刷新后保留
    const settingsSource = readFileSync(path.join(root, 'src/stores/setting.ts'), 'utf8')
    assert.match(settingsSource, /isSidebarGrouped: boolean/)
    assert.match(settingsSource, /isSidebarGrouped: false/)
    assert.match(settingsSource, /toggleSidebarGrouped\(\) \{\s*this\.isSidebarGrouped = !this\.isSidebarGrouped\s*this\.persist\(\)/)
    assert.match(sidebarSource, /const groupByAgent = computed\(\(\) => configStore\.isSidebarGrouped\)/)
    assert.match(sidebarSource, /const toggleGroupByAgent = \(\) => \{\s*configStore\.toggleSidebarGrouped\(\)/)
    assert.match(sidebarSource, /:aria-pressed="groupByAgent"/)
    assert.match(sidebarSource, /:title="\$t\('sidebar\.group'\)"/)
    // 分组键：agentName 优先；任务会话接口只带 agentId，本地经 agent 列表解析名称。
    // 只取 name 字段（如「万能助手」），不取 identity.name（人设名，如「小段」），最终回退 agentId
    assert.match(sidebarSource, /const agentDisplayName = \(s: SessionRow\): string => \{/)
    assert.match(sidebarSource, /agentsState\.agentsList\?\.find\(a => a\.id === s\.agentId\)/)
    assert.match(sidebarSource, /return agent\?\.name \|\| s\.agentId \|\| ''/)
    assert.doesNotMatch(sidebarSource, /identity\?\.name/)
    assert.match(sidebarSource, /agent: agentDisplayName\(s\),/)
    assert.match(sidebarSource, /const sessionGroups = computed\(\(\) => \{/)
    assert.match(sidebarSource, /label: session\.agent \|\| t\('sidebar\.ungrouped'\)/)
    // 组顺序固定不漂移：按 agent 创建时间从早到晚（未分组 key 为空永远最后），
    // 同刻退回显示名拼音（agentId 决胜）；不随会话更新时间跳位，组内仍保持时间倒序
    assert.match(sidebarSource, /const agentCreatedAtMs = \(agentId: string\): number => \{/)
    assert.match(sidebarSource, /return groups\.sort\(\(a, b\) => \{\s*if \(!a\.key\) return 1\s*if \(!b\.key\) return -1\s*const byCreated = agentCreatedAtMs\(a\.key\) - agentCreatedAtMs\(b\.key\)\s*if \(byCreated !== 0\) return byCreated\s*return a\.label\.localeCompare\(b\.label, 'zh'\) \|\| \(a\.key < b\.key \? -1 : a\.key > b\.key \? 1 : 0\)/)
    // 渲染模型单一 v-for：组头与行交错，行模板不按两种视图复制
    assert.match(sidebarSource, /v-for="session in sessionListItems"/)
    assert.match(sidebarSource, /v-if="session\.kind === 'group'"/)
    // 组头可点击展开/收起：收起状态按 tab 独立记忆（互不干扰）+ toggle + 键盘可达 + aria-expanded
    assert.match(sidebarSource, /const collapsedGroups = ref<Record<SidebarSessionTab, Set<string>>>\(\{/)
    assert.match(sidebarSource, /const toggleGroup = \(key: string\) => \{\s*const tab = sessionTab\.value\s*const next = new Set\(collapsedGroups\.value\[tab\]\)/)
    assert.match(sidebarSource, /const isGroupCollapsed = \(key: string\) => collapsedGroups\.value\[sessionTab\.value\]\.has\(key\)/)
    assert.match(sidebarSource, /@click="toggleGroup\(session\.groupKey\)"/)
    assert.match(sidebarSource, /:aria-expanded="!isGroupCollapsed\(session\.groupKey\)"/)
    // 收起的组只渲染组头，会话行不进列表
    assert.match(sidebarSource, /const collapsed = collapsedGroups\.value\[sessionTab\.value\]/)
    assert.match(sidebarSource, /if \(collapsed\.has\(group\.key\)\) continue/)
    // 文件夹图标随展开状态切换：开 FolderOpenIcon / 合 FolderIcon
    assert.match(sidebarSource, /isGroupCollapsed\(session\.groupKey\) \? FolderIcon : FolderOpenIcon/)
    // 分组关闭时输出纯行列表，空态/加载态判断仍基于 displaySessions
    assert.match(sidebarSource, /if \(!groupByAgent\.value\) \{/)
    assert.match(sidebarSource, /<div v-else-if="!displaySessions \|\| displaySessions\.length === 0"/)
})

test('sidebar grouping i18n keys exist in zh and en locales', () => {
    const zhSource = readFileSync(path.join(root, 'src/i18n/zh.ts'), 'utf8')
    const enSource = readFileSync(path.join(root, 'src/i18n/en.ts'), 'utf8')
    for (const source of [zhSource, enSource]) {
        assert.match(source, /ungrouped: '/)
    }
    assert.match(zhSource, /group: '分组'/)
    assert.match(enSource, /group: 'Group'/)
})

test('sidebar tab switch lazily loads the matching data bucket and retries on failure', () => {
    // plans/archived 懒加载；chats 依赖启动链 useAppInit，不进 TAB_LOADERS
    assert.match(sidebarSource, /plans: \(\) => sessionsState\.loadTaskSessions\(\)/)
    assert.match(sidebarSource, /archived: \(\) => sessionsState\.loadArchivedSessions\(\)/)
    assert.match(sidebarSource, /trash: \(\) => sessionsState\.loadDeletedSessions\(\)/)
    assert.doesNotMatch(sidebarSource, /chats: \(\) => sessionsState\.loadSessions\(\)/)
    // 初始无标记，懒加载语义
    assert.match(sidebarSource, /const loadedTabs = new Set<SidebarSessionTab>\(\)/)
    // loader 失败返回 null 时移除标记，下次切到该 tab 会重试
    assert.match(sidebarSource, /if \(await loader\(\) == null\) \{\s*loadedTabs\.delete\(tab\)/)
    // loader 违约 reject 时同样释放标记（catch 分支），不允许永久卡死
    assert.match(sidebarSource, /\} catch \{[\s\S]*?loadedTabs\.delete\(tab\)/)
})

test('sidebar tab loading state is per-tab, safe under concurrent tab switches', () => {
    // 在途集合按 tab 粒度，spinner 只跟随当前显示 tab；
    // 并发切换时先完成的 loader 不会把仍在途 tab 的 spinner 提前关掉
    assert.match(sidebarSource, /const loadingTabs = reactive\(new Set<SidebarSessionTab>\(\)\)/)
    assert.match(sidebarSource, /const tabLoading = computed\(\(\) => loadingTabs\.has\(sessionTab\.value\)\)/)
    assert.match(sidebarSource, /finally \{\s*loadingTabs\.delete\(tab\)\s*\}/)
    // 旧共享布尔方案不应存在
    assert.doesNotMatch(sidebarSource, /tabLoading\.value = /)
})

test('sidebar current tab renders only its matching bucket', () => {
    assert.match(sidebarSource, /sessionTab\.value === 'chats'\s*\n\s*\? sessionsState\.sessionsResult\?\.sessions/)
    assert.match(sidebarSource, /sessionTab\.value === 'plans'\s*\n\s*\? sessionsState\.taskSessionsResult\?\.sessions/)
    assert.match(sidebarSource, /: sessionsState\.archivedSessionsResult\?\.sessions/)
})

test('sidebar empty state per tab and loading indicator during first lazy load', () => {
    // 空态按 tab 显示 noChats/noPlans/noArchived/noTrash
    assert.match(sidebarSource, /sessionTab === 'chats' \? 'sidebar\.noChats' : sessionTab === 'plans' \? 'sidebar\.noPlans' : sessionTab === 'trash' \? 'sidebar\.noTrash' : 'sidebar\.noArchived'/)
    // 首次懒加载在途显示 loading 而非误导性空态
    assert.match(sidebarSource, /<div v-if="tabLoading"[\s\S]*?loading loading-spinner/)
    assert.match(sidebarSource, /<div v-else-if="!displaySessions \|\| displaySessions\.length === 0"/)
})

test('sidebar empty state keys exist in both zh and en locales', () => {
    const zhSource = readFileSync(path.join(root, 'src/i18n/zh.ts'), 'utf8')
    const enSource = readFileSync(path.join(root, 'src/i18n/en.ts'), 'utf8')
    for (const source of [zhSource, enSource]) {
        assert.match(source, /noChats: '/)
        assert.match(source, /noPlans: '/)
        assert.match(source, /noArchived: '/)
    }
})

test('sidebar row menu is tab-aware', () => {
    // 对话 tab 才有置顶/取消置顶（后端 pin 只作用于普通列表），且置顶分支只在 chats 条件内
    assert.match(sidebarSource, /if \(sessionTab\.value === 'chats'\) \{\s*items\.push\(\{\s*key: session\.pinned \? 'unpin' : 'pin'/)
    assert.doesNotMatch(sidebarSource, /key: session\.pinned \? 'unpin' : 'pin'[\s\S]*?sessionTab\.value === 'plans'/)
    // 菜单按行归档状态切换：已归档行显示取消归档；
    // 归档入口仅对话 tab（任务会话不支持归档），用 else if 限定在 chats 条件内
    assert.match(sidebarSource, /if \(session\.archived\) \{\s*items\.push\(\{\s*key: 'unarchive'[\s\S]*?\} else if \(sessionTab\.value === 'chats'\) \{\s*(?:\/\/[^\n]*\n\s*)*items\.push\(\{\s*key: 'archive'/)
})

test('sidebar tab follows the active session bucket after navigation', () => {
    // 通知点击/路由跳转 /chat/:id 后，tab 自动切到该会话所属桶：
    // 三桶各自可命中，桶未加载/无此会话时返回 null（等待回填，不盲切）
    assert.match(sidebarSource, /const sessionTabOfKey = \(key: string\): SidebarSessionTab \| null => \{[\s\S]*?sessionsResult\?\.sessions\?\.some\(s => s\.id === key\)\) return 'chats'[\s\S]*?taskSessionsResult\?\.sessions\?\.some\(s => s\.id === key\)\) return 'plans'[\s\S]*?archivedSessionsResult\?\.sessions\?\.some\(s => s\.id === key\)\) return 'archived'[\s\S]*?deletedSessionsResult\?\.sessions\?\.some\(s => s\.id === key\)\) return 'trash'[\s\S]*?return null/)
    // 同时监听 activeSessionKey 与四桶引用：冷启动点通知时桶由 getSessionById 单查回填，命中晚于跳转
    assert.match(sidebarSource, /watch\(\[activeSessionKey, \(\) => sessionsState\.sessionsResult, \(\) => sessionsState\.taskSessionsResult, \(\) => sessionsState\.archivedSessionsResult, \(\) => sessionsState\.deletedSessionsResult\]/)
    // followedKey 一次性跟随：同一次跳转只切一次，之后用户手动切其他 tab 浏览不被拉回
    assert.match(sidebarSource, /if \(!key \|\| followedKey === key\) return/)
    assert.match(sidebarSource, /followedKey = key/)
    // 桶未回填时等待下一次桶变化，不动作
    assert.match(sidebarSource, /if \(!tab\) return/)
    // 命中且非当前 tab 时走 switchSessionTab（复用懒加载与重试语义）
    assert.match(sidebarSource, /if \(tab !== sessionTab\.value\) void switchSessionTab\(tab\)/)
})
