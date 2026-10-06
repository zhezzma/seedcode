import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const navigationSource = readFileSync(path.join(root, 'src/config/navigation.ts'), 'utf8')
const sidebarSource = readFileSync(path.join(root, 'src/components/AppSidebar.vue'), 'utf8')
const sessionActionMenuSource = readFileSync(path.join(root, 'src/components/chat/SessionActionMenu.vue'), 'utf8')
const zhSource = readFileSync(path.join(root, 'src/i18n/zh.ts'), 'utf8')
const enSource = readFileSync(path.join(root, 'src/i18n/en.ts'), 'utf8')

test('navigation drops task sessions and archived standalone pages', () => {
    // 独立任务/归档页面与底部导航入口全部删除，入口收敛到侧栏 tabs
    assert.doesNotMatch(navigationSource, /route: 'tasks'/)
    assert.doesNotMatch(navigationSource, /route: 'archived'/)
    assert.doesNotMatch(navigationSource, /ArchiveBoxIcon/)
    assert.doesNotMatch(navigationSource, /CalendarDaysIcon/)
})

test('sidebar renders three session tabs and lazy-loads per tab', () => {
    assert.match(sidebarSource, /const sessionTab = ref<SidebarSessionTab>\('chats'\)/)
    // plans/archived 懒加载；chats 由启动链 useAppInit 加载，不进 TAB_LOADERS
    assert.match(sidebarSource, /plans: \(\) => sessionsState\.loadTaskSessions\(\)/)
    assert.match(sidebarSource, /archived: \(\) => sessionsState\.loadArchivedSessions\(\)/)
    assert.doesNotMatch(sidebarSource, /chats: \(\) => sessionsState\.loadSessions\(\)/)
    assert.match(sidebarSource, /const loadedTabs = new Set<SidebarSessionTab>\(\)/)
    // tab 标签由 SESSION_TABS 配置驱动，labelKey 指向 i18n
    assert.match(sidebarSource, /labelKey: 'sidebar\.tabChats'/)
    assert.match(sidebarSource, /labelKey: 'sidebar\.tabPlans'/)
    assert.match(sidebarSource, /labelKey: 'sidebar\.tabArchived'/)
})

test('sidebar batch delete button is removed', () => {
    assert.doesNotMatch(sidebarSource, /handleDeleteAllSessions/)
    assert.doesNotMatch(sidebarSource, /deleteSessions\(/)
    // 旧「删除全部会话」入口的残留文案不得回归；TrashIcon 现用于回收站 tab
    // （sidebar-tabs.test.ts 钉住第 4 桶与清空按钮语义），此处不再禁图标本体
    assert.doesNotMatch(sidebarSource, /sidebar\.clearAll/)
})

test('row menu items are tab-aware', () => {
    // 对话 tab 才有置顶；菜单按行归档状态切换归档/取消归档
    assert.match(sidebarSource, /if \(sessionTab\.value === 'chats'\) \{\s*items\.push\(\{\s*key: session\.pinned \? 'unpin' : 'pin'/)
    // 已归档行显示取消归档（归档 tab 全部 + 计划 tab 中已归档项）
    assert.match(sidebarSource, /if \(session\.archived\) \{\s*items\.push\(\{\s*key: 'unarchive'/)
    // 归档入口仅对话 tab 可用：任务会话（计划 tab）不支持归档
    assert.match(sidebarSource, /\} else if \(sessionTab\.value === 'chats'\) \{\s*(?:\/\/[^\n]*\n\s*)*items\.push\(\{\s*key: 'archive',\s*label: t\('sidebar\.archive'\)/)
    assert.match(sidebarSource, /const handleUnarchiveSession = async \(session: \{ key: string, label: string \}\) => \{\s*await sessionsState\.unarchiveSession\(session\.key\)/)
    assert.match(sidebarSource, /if \(action === 'unarchive'\) \{\s*await handleUnarchiveSession\(session\)/)
})

test('AppSidebar uses SessionActionMenu for session row actions', () => {
    assert.match(sidebarSource, /import SessionActionMenu from '\.\/chat\/SessionActionMenu\.vue'/)
    assert.match(sidebarSource, /<SessionActionMenu[\s\S]*?@select="handleSessionMenuSelect\(session, \$event\)"/)
    assert.match(sidebarSource, /:actions="getSessionMenuItems\(session\)"/)
})

test('session rows open context menu on right-click and keep rename input behavior', () => {
    assert.match(sidebarSource, /@contextmenu\.prevent="openSessionContextMenu\(session\.key\)"/)
    assert.match(sidebarSource, /<input[\s\S]*?@contextmenu\.stop/)
    assert.match(sessionActionMenuSource, /return \{[\s\S]*?\bopenMenu,/)
})

test('session action menu uses icon-only vertical trigger with accessible title and required menu id', () => {
    assert.match(sessionActionMenuSource, /import \{ EllipsisVerticalIcon \} from '@heroicons\/vue\/24\/outline'/)
    assert.match(sessionActionMenuSource, /menuId:[\s\S]*?type: String,[\s\S]*?required: true/)
    assert.match(sessionActionMenuSource, /<EllipsisVerticalIcon class="h-4 w-4" \/>/)
})

test('sidebars pass stable prefixed menu ids to session action menus', () => {
    assert.match(sidebarSource, /:menu-id="`recent:\$\{session\.key\}`"/)
})

test('sidebar i18n includes tab labels and archive actions in Chinese and English', () => {
    assert.match(zhSource, /tabChats: '对话'/)
    assert.match(zhSource, /tabPlans: '计划'/)
    assert.match(zhSource, /tabArchived: '归档'/)
    assert.match(zhSource, /archive: '归档'/)
    assert.match(zhSource, /unarchive: '取消归档'/)
    assert.match(zhSource, /pin: '置顶'/)
    assert.match(zhSource, /unpin: '取消置顶'/)
    assert.match(zhSource, /more: '更多'/)
    assert.match(enSource, /tabChats: 'Chats'/)
    assert.match(enSource, /tabPlans: 'Plans'/)
    assert.match(enSource, /tabArchived: 'Archived'/)
    assert.match(enSource, /archive: 'Archive'/)
    assert.match(enSource, /unarchive: 'Unarchive'/)
    assert.match(enSource, /pin: 'Pin'/)
    assert.match(enSource, /unpin: 'Unpin'/)
    assert.match(enSource, /more: 'More'/)
})
