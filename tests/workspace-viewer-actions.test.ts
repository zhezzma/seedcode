/**
 * Viewer 顶栏「⋮ 更多」菜单（useViewerActions.buildViewerMenuItems）源码断言。
 *
 * 惯例同 workspace-file-actions.test.ts：菜单工厂是「UI store + 副本」的组合体，
 * node:test 环境无 DOM，用源码正则锁定接线与门控语义。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
function read(rel: string): string {
    return readFileSync(path.resolve(dir, '..', rel), 'utf8')
}

const fa = read('src/composables/useFileActions.ts')
const va = read('src/composables/useViewerActions.ts')
const zh = read('src/i18n/zh.ts')
const en = read('src/i18n/en.ts')

// ── useFileActions：为 viewer 菜单导出的共享积木 ──

test('useFileActions: 导出 fenceContent / runOpenerAction / parentDir 供 viewer 菜单复用', () => {
    assert.match(fa, /export function fenceContent/, 'fenceContent must be exported')
    assert.match(fa, /export async function runOpenerAction/, 'runOpenerAction must be exported (extracted from closure)')
    assert.match(fa, /export function parentDir/, 'parentDir must be exported')
    // 抽取后 buildFileMenuItems 内不再有闭包 runOpener 定义（单一实现）
    assert.doesNotMatch(fa, /const runOpener = async/, 'closure runOpener must be removed after extraction')
    // 抽取后的共享实现仍被 buildFileMenuItems 使用（行为不变）
    assert.match(fa, /runOpenerAction\(\s*'workspace\.menu\.openLocally'/,
        'buildFileMenuItems must call shared runOpenerAction for openLocally')
})

// ── useViewerActions：菜单工厂 ──

test('useViewerActions: buildViewerMenuItems 工厂签名 + ViewerMenuArgs 接口', () => {
    assert.match(va, /export function buildViewerMenuItems\(args: ViewerMenuArgs\): ContextMenuItem\[\]/,
        'factory signature must return ContextMenuItem[]')
    assert.match(va, /export interface ViewerMenuArgs/, 'ViewerMenuArgs interface must be exported')
    // 接口字段：Task 3 的 WorkspaceViewer 按这些名字传参
    for (const field of ['agentId', 'target', 'fileContent', 'diffContent', 'getUnifiedDiff', 'onClose']) {
        assert.match(va, new RegExp(`${field}[?]?:`), `ViewerMenuArgs must declare ${field}`)
    }
    assert.match(va, /import type \{ ContextMenuItem \}|import \{ useContextMenu, type ContextMenuItem \}/,
        'must reuse ContextMenuItem type from useContextMenu')
})

test('useViewerActions: file 模式 scope 路由拼绝对路径（workspace→workspaceDir / agent→agentDir / absolute→自身）', () => {
    // root 来源：agentsList 按 agentId 查（useAppInit 启动即加载，可靠）
    assert.match(va, /agentsList\.find\(a => a\.id === agentId\)/, 'must look up agent record by id')
    assert.match(va, /workspaceDir/, 'workspace scope root must come from agent.workspaceDir')
    assert.match(va, /agentDir/, 'agent scope root must come from agent.agentDir')
    // 复用 buildAbsolutePath（与文件树右键同一拼法，Windows 反斜杠语义一致）
    assert.match(va, /buildAbsolutePath\(/, 'must reuse buildAbsolutePath for OS-native separators')
})

test('useViewerActions: /assets URL 隐藏本地打开三件套（不是真实文件系统路径）', () => {
    assert.match(va, /startsWith\('\/assets'\)/, 'must guard /assets prefix')
})

test('useViewerActions: 下载仅 workspace/agent scope（absolute 无对应端点，隐藏不 disabled）', () => {
    assert.match(va, /scope !== 'absolute'/, 'download item must be hidden for absolute scope')
    assert.match(va, /fetchDownload\(/, 'download must reuse fetchDownload')
    assert.match(va, /saveBlob\(/, 'download must save via saveBlob')
})

test('useViewerActions: 本地打开三件套门控与文件树一致（Tauri+local）+ 终端打开父目录', () => {
    assert.match(va, /shouldShowLocalOpenItems\(/, 'must reuse shouldShowLocalOpenItems gating')
    assert.match(va, /runOpenerAction\(/, 'must reuse runOpenerAction for opener calls')
    assert.match(va, /openInTerminalAt\(/, 'terminal must go through openInTerminalAt')
    assert.match(va, /parentDir\(/, 'terminal must open the parent dir of the file')
})

test('useViewerActions: 发送到聊天走 appendText + fenceContent，发送后经 onClose 关 viewer', () => {
    assert.match(va, /appendText\(/, 'must append via useChatInput().appendText')
    assert.match(va, /fenceContent\(/, 'send content must reuse fenceContent (backtick-safe fence)')
    // onClose 是组件注入的 confirm-aware close：dirty buffer 不得静默丢弃
    assert.match(va, /await onClose\(\)/, 'send actions must close viewer via injected onClose')
})

test('useViewerActions: 复制类动作走 writeClipboard + copied toast；空内容 disabled', () => {
    assert.match(va, /writeClipboard\(/, 'copy actions must use writeClipboard')
    assert.match(va, /workspace\.menu\.copied/, 'copy success toast must reuse copied key')
    assert.match(va, /disabled: !fileContent\(\)/, 'file copy-content must disable on empty content (binary/media)')
    assert.match(va, /disabled: !diffContent\(\)/, 'diff copy-content must disable on empty content')
})

test('useViewerActions: diff 模式路径拼 repoJoin + 复制/下载 patch 走 getUnifiedDiff（空 diff no-op）', () => {
    assert.match(va, /repoJoin\(target\.repo, target\.file\)/, 'diff path must compose via repoJoin')
    assert.match(va, /getUnifiedDiff\(\)/, 'copy-diff / download-patch must fetch unified diff on demand')
    // 空 diff：不写剪贴板 / 不弹保存对话框
    assert.match(va, /if \(!text\) return/, 'empty diff must be a no-op')
    assert.match(va, /\.patch/, 'patch filename must end with .patch')
    // 拉取失败可感知（网络动作与纯剪贴板不同）
    assert.match(va, /common\.networkError/, 'diff fetch failure must toast networkError')
})

test('useViewerActions: diff 的发送 @引用 与本地打开仅限 unstaged/untracked（工作树文件）', () => {
    assert.match(va, /mode === 'unstaged' \|\| target\.mode === 'untracked'/,
        'worktree-mode gate must cover send mention + local open (staged/commit 右侧不是工作区文件)')
})

test('useViewerActions: text 模式仅提供复制内容（补全屏预览零按钮缺口）', () => {
    const m = va.match(/target\.type === 'text'([\s\S]{0,400})/)
    assert.ok(m, 'text mode branch must exist')
    assert.match(m[1], /copyContent/, 'text mode must offer copy content')
})

// ── i18n 双侧 ──

test('i18n: viewer 菜单新增 4 key 双侧齐备', () => {
    assert.match(zh, /copyPath: '复制路径'/)
    assert.match(en, /copyPath: 'Copy Path'/)
    assert.match(zh, /copyContent: '复制内容'/)
    assert.match(en, /copyContent: 'Copy Content'/)
    assert.match(zh, /copyDiff: '复制 diff'/)
    assert.match(en, /copyDiff: 'Copy Diff'/)
    assert.match(zh, /downloadPatch: '下载 \.patch'/)
    assert.match(en, /downloadPatch: 'Download \.patch'/)
})

// ── WorkspaceViewer 组件接线（⋮ 按钮 / 移除 Copy / 移动端文件名）──

const wv = read('src/components/workspace/WorkspaceViewer.vue')

test('Viewer: ⋮ 按钮挂单例 ContextMenu（openAtElement + buildViewerMenuItems）', () => {
    assert.match(wv, /EllipsisVerticalIcon/, 'kebab icon must be rendered')
    assert.match(wv, /useContextMenu\(\)/, 'must use the singleton context menu (same as tree kebab)')
    assert.match(wv, /openAtElement\(/, 'kebab must open via openAtElement')
    assert.match(wv, /buildViewerMenuItems\(/, 'menu items must come from the viewer factory')
    assert.match(wv, /aria-haspopup="menu"/, 'a11y: kebab must declare menu trigger')
    assert.match(wv, /workspace\.menu\.more/, 'aria-label/title must use the more key')
})

test('Viewer: 独立 Copy 按钮移除（复制逻辑收进 ⋮ 菜单）', () => {
    assert.doesNotMatch(wv, /onClickCopy\b/, 'file copy handler must move into the factory')
    assert.doesNotMatch(wv, /onClickCopyDiff/, 'diff copy handler must move into the factory')
    assert.doesNotMatch(wv, /ClipboardDocumentIcon/, 'copy icon must no longer sit in the header')
})

test('Viewer: 菜单实参接线（编辑器实时内容 getter + confirm-aware onClose）', () => {
    assert.match(wv, /fileContent: \(\) => fileViewRef\.value\?\.content \?\? ''/,
        'file content getter must read the editor live value')
    assert.match(wv, /diffContent: \(\) => diffViewRef\.value\?\.content \?\? ''/,
        'diff content getter must read the modified side live value')
    assert.match(wv, /onClose: close/, 'onClose must be the confirm-aware close (dirty 不静默丢弃)')
})

test('Viewer: 面包屑 PC 全路径 / 移动端文件名（dirty 圆点保留）', () => {
    assert.match(wv, /breadcrumbShort/, 'short breadcrumb computed must exist')
    assert.match(wv, /lg:hidden[\s\S]{0,200}breadcrumbShort/,
        'mobile span (lg:hidden) must show the basename')
    assert.match(wv, /hidden lg:inline[\s\S]{0,200}breadcrumb/,
        'desktop span (hidden lg:inline) must show the full path')
    assert.match(wv, /text-warning shrink-0/, 'dirty dot must stay outside the truncating spans')
})

test('Viewer: Save/Preview/Split 按钮保留（只收复制类进菜单）', () => {
    assert.match(wv, /onClickSave\b/, 'file save button preserved')
    assert.match(wv, /onClickPreview\b/, 'file preview button preserved')
    assert.match(wv, /onClickSaveDiff/, 'diff save button preserved')
    assert.match(wv, /onClickToggleSplit/, 'split toggle preserved')
})

test('Viewer: Esc 分层——⋮ 菜单打开时 Esc 只关菜单，不连带关 viewer', () => {
    // ContextMenu 是文档级单例且先注册：菜单自己处理 Esc 后，viewer 的 onEscape
    // 仍会触发（target 是菜单项 BUTTON，过 INPUT/TEXTAREA 过滤器）→ 必须显式让位。
    assert.match(wv, /function onEscape\([\s\S]*?ctxMenu\.visible/,
        'onEscape must bail when the singleton menu is open (layered close, same as ChatInput dropdowns)')
})
