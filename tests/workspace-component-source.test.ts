import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))

function read(rel: string): string {
    return readFileSync(path.resolve(dir, '..', rel), 'utf8')
}

test('WorkspacePanel: 包含 tab 切换、splitter、close 与 width 应用', () => {
    const src = read('src/components/workspace/WorkspacePanel.vue')
    assert.match(src, /useWorkspacePanel/, 'WorkspacePanel must use the panel composable')
    assert.match(src, /WorkspaceTabFiles/, 'must render WorkspaceTabFiles')
    assert.match(src, /WorkspaceTabGit/, 'must render WorkspaceTabGit')
    assert.match(src, /role="tab"|tab-group|tab tab-/, 'must have tab UI')
    assert.match(src, /col-resize/, 'splitter must use col-resize cursor')
    assert.match(src, /:style=".*width/, 'panel width must bind from composable')
    // 移动端：接受 mobile prop，在移动模式下隐藏 splitter / 不用像素宽度
    assert.match(src, /mobile\??:\s*boolean/, 'must accept mobile prop')
    assert.match(src, /v-if="!mobile"/, 'splitter must be hidden in mobile drawer mode')
})

test('WorkspaceTabFiles: 调用 tree composable + viewer.openFile', () => {
    const src = read('src/components/workspace/WorkspaceTabFiles.vue')
    assert.match(src, /useWorkspaceTree/)
    assert.match(src, /useWorkspaceViewer/)
    assert.match(src, /openFile\(entry\.path\)/, 'must call viewer.openFile with workspace-relative path')
    assert.match(src, /FileTreeNode/, 'must render recursive FileTreeNode component')
    // 底部 agent files 可折叠区
    assert.match(src, /useAgentFiles/, 'must use agent-files composable')
    assert.match(src, /CollapsibleSection/, 'must use shared CollapsibleSection')
    assert.match(src, /openAgentFile/, 'must dispatch viewer.openAgentFile for agent entries')
    assert.match(src, /AgentFileTreeNode/, 'must render AgentFileTreeNode for agent dir')
    // 防回归：点击 tree 切文件前需要 dirty 确认
    assert.match(src, /useConfirm/, 'must import useConfirm to gate file switching when viewer is dirty')
    assert.match(src, /viewer\.dirty/, 'must read viewer.dirty before switching files')
    assert.match(src, /confirmIfDirty/, 'must guard openFile / openAgentFile with confirmIfDirty')
})

test('FileTreeNode: 递归、区分 file/dir/symlink、isGitRepo 徽章', () => {
    const src = read('src/components/workspace/FileTreeNode.vue')
    assert.match(src, /defineOptions\(\{ name: 'FileTreeNode'/, 'must declare name for self-recursion')
    assert.match(src, /isGitRepo/, 'must render git repo badge')
    assert.match(src, /symlink/, 'must handle symlink type')
    assert.match(src, /<FileTreeNode/, 'must self-recurse in template')
    assert.match(src, /onClick\(entry\)|onClick\(props\.entry\)/, 'must dispatch click to parent')
    // 上下文菜单 wiring
    assert.match(src, /scope:\s*'workspace'/, 'must build menu items with workspace scope')
    assert.match(src, /@contextmenu="onRowContextMenu"/, 'row must register contextmenu handler')
    assert.match(src, /lg:hidden[\s\S]{0,400}EllipsisVerticalIcon/,
        'kebab button must be mobile-only (lg:hidden + EllipsisVerticalIcon)')
    assert.match(src, /e\.stopPropagation\(\)/, 'kebab click must stop propagation to row click')
    assert.match(src, /e\.preventDefault\(\)/, 'contextmenu handler must preventDefault to suppress native menu')
    // a11y：kebab 作为菜单触发器必须被读屏器拍到
    assert.match(src, /aria-label="\$t\('workspace\.menu\.more'\)"/, 'kebab must have aria-label for screen readers')
    assert.match(src, /aria-haspopup="menu"/, 'kebab must declare aria-haspopup=menu')
})

test('WorkspaceTabFiles: toggleExpand 与 openFile 在父定义', () => {
    const src = read('src/components/workspace/WorkspaceTabFiles.vue')
    assert.match(src, /toggleExpand/, 'parent owns expand toggling')
    assert.match(src, /openFile/, 'parent owns viewer dispatch')
})

test('WorkspaceTabGit: 装配 RepoSelector + StatusGroup + HistoryList + Commit Bar', () => {
    const src = read('src/components/workspace/WorkspaceTabGit.vue')
    assert.match(src, /RepoSelector/)
    assert.match(src, /StatusGroup/)
    assert.match(src, /HistoryList/)
    assert.match(src, /useWorkspaceGit/)
    assert.match(src, /openDiff/, 'must call viewer.openDiff for status / commit clicks')
    // 底部 history 被 CollapsibleSection 包裹
    assert.match(src, /CollapsibleSection/, 'must wrap HistoryList in CollapsibleSection')
    assert.match(src, /panel\.bottomSections/, 'must read history open state from panel composable')
    // 新增：Commit Bar + 4 个 mutation
    assert.match(src, /commitMessage/, 'must bind a commit message via getCommitMessage/setCommitMessage')
    assert.match(src, /git\.commit\(/, 'must call git.commit')
    assert.match(src, /git\.stage\(/, 'must call git.stage for stage / stage all')
    assert.match(src, /git\.unstage\(/, 'must call git.unstage')
    assert.match(src, /git\.discard\(/, 'must call git.discard')
    // Ctrl/Cmd+Enter 提交
    assert.match(src, /ctrlKey \|\| e\.metaKey/, 'must support Ctrl/Cmd+Enter to commit')
    // canCommit 门：需要 message + staged > 0 + 不在 mutation 中
    assert.match(src, /canCommit/, 'must compute canCommit gating')
    assert.match(src, /stagedCount/, 'must reflect staged count in UI')
    // 各组顶部 actions
    assert.match(src, /onStageAllChanges/, 'must expose stage-all for merged Changes group')
    assert.match(src, /onUnstageAll/, 'must expose unstage-all for staged group')
    assert.match(src, /onDiscardAllChanges/, 'must expose discard-all for merged Changes group')
    // 反面锁定：合并后不应再出现 untracked 专用的 handler
    assert.doesNotMatch(src, /onDiscardAllUntracked/, 'untracked-only handler removed after merge')
    // 行右键菜单工厂
    assert.match(src, /buildGitFileMenuItems/, 'must use buildGitFileMenuItems for per-row menus')
})

test('WorkspaceTabGit: 加载 workspaceRoot + 菜单传绝对路径 + HistoryList onOpenFile', () => {
    const src = read('src/components/workspace/WorkspaceTabGit.vue')
    // 加载工作区根目录绝对路径（拼 git 文件绝对路径用）
    assert.match(src, /git\.loadWorkspaceRoot/, 'must load workspaceRoot on mount')
    assert.match(src, /git\.workspaceRoot\.value/, 'must read workspaceRoot from the git store')
    // callbacksFor 给菜单工厂传 absolutePath（repoJoin 处理根仓库 "." 不产生 "./" 前缀）
    assert.match(src, /buildAbsolutePath\(git\.workspaceRoot\.value, repoJoin\(repo, change\.path\)\)/, 'must compose absolute path as root + repoJoin(repo, change.path)')
    // commit 文件行也要打开工作区文件：透传 onOpenFile 给 HistoryList
    assert.match(src, /:on-open-file="openCommitFile"/, 'must pass onOpenFile to HistoryList for commit file open')
})

test('WorkspaceTabGit: 空白区点击刷新（无节流，每次点击都重拉）', () => {
    const src = read('src/components/workspace/WorkspaceTabGit.vue')
    // 滚动容器挂 @click.self：只有点到容器自身空白处才触发，
    // 列表行 / 按钮 / 输入框 / 下拉等子元素不受影响
    assert.match(src, /@click\.self="onBlankAreaClick"/, 'scroll container must bind click.self for blank-area refresh')
    // 复用 loadAll：status（refresh=1 顺带 fetch upstream）+ log，与切仓/顶部刷新同语义
    assert.match(src, /function onBlankAreaClick[\s\S]*?void loadAll\(repo\)/, 'blank click must reuse loadAll (status+log)')
    // 无选中仓库直接忽略
    assert.match(src, /function onBlankAreaClick[\s\S]*?if \(!repo\) return/, 'must ignore blank click when no repo selected')
    // 节流已按需求移除：不应再有时间窗口节流残留
    assert.doesNotMatch(src, /BLANK_AREA_REFRESH_INTERVAL_MS/, 'throttle was intentionally removed')
    // 拖拽选中文本松手在空白处：click 落在公共祖先（容器），.self 挡不住 →
    // pointerdown 起点位移 >4px 视为拖拽，不触发刷新
    assert.match(src, /@pointerdown="onBlankAreaPointerDown"/, 'must track pointerdown origin')
    assert.match(src, /Math\.hypot\(e\.clientX - down\.x, e\.clientY - down\.y\) > 4/, 'must ignore drag-release (>4px) as click')
})

test('CollapsibleSection: header + body + maxHeight + count + actions slot', () => {
    const src = read('src/components/workspace/CollapsibleSection.vue')
    assert.match(src, /ChevronRightIcon/, 'must render collapsed chevron')
    assert.match(src, /ChevronDownIcon/, 'must render expanded chevron')
    assert.match(src, /maxHeight/, 'must accept maxHeight prop')
    assert.match(src, /toggle/, 'must emit toggle event')
    assert.match(src, /overflow-y-auto/, 'body must scroll internally')
    // actions slot：header 右侧可放额外按钮（如 + 文件 / + 目录）
    assert.match(src, /name="actions"/, 'must expose an actions slot for header buttons')
    // actions 不能嵌在 toggle button 内（否则点子按钮会触发折叠）
    assert.match(
        src,
        /<button[^>]+@click="onHeaderClick"[\s\S]*?<\/button>\s*<div[^>]+v-if="\$slots\.actions"/,
        'actions slot must be a sibling of the toggle button, not a child',
    )
})

test('AgentFileTreeNode: 递归、不渲染 git 徽章', () => {
    const src = read('src/components/workspace/AgentFileTreeNode.vue')
    assert.match(src, /defineOptions\(\{ name: 'AgentFileTreeNode'/, 'must declare name for self-recursion')
    assert.match(src, /<AgentFileTreeNode/, 'must self-recurse in template')
    assert.match(src, /useAgentFiles/, 'must use agent-files composable, not workspace-tree')
    assert.doesNotMatch(src, /isGitRepo/, 'must NOT render git badge in agent tree')
    // 上下文菜单 wiring：scope=agent
    assert.match(src, /scope:\s*'agent'/, 'agent tree must build menu items with agent scope')
    assert.match(src, /@contextmenu="onRowContextMenu"/, 'row must register contextmenu handler')
    assert.match(src, /lg:hidden[\s\S]{0,400}EllipsisVerticalIcon/, 'kebab button must be mobile-only')
    assert.match(src, /e\.stopPropagation\(\)/, 'kebab click must stop propagation to row click')
    assert.match(src, /e\.preventDefault\(\)/, 'contextmenu handler must preventDefault')
    // a11y：kebab 作为菜单触发器
    assert.match(src, /aria-label="\$t\('workspace\.menu\.more'\)"/, 'kebab must have aria-label for screen readers')
    assert.match(src, /aria-haspopup="menu"/, 'kebab must declare aria-haspopup=menu')
})

test('RepoSelector: 显示分支徽章 + ahead/behind + dropdown', () => {
    const src = read('src/components/workspace/git/RepoSelector.vue')
    assert.match(src, /["' ]relative["' ]/i, 'should use a dropdown anchor (relative position) for repo selection')
    assert.match(src, /absolute/i, 'dropdown menu must be absolutely positioned')
    assert.match(src, /ahead/, 'should show ahead count')
    assert.match(src, /behind/, 'should show behind count')
    assert.match(src, /dirty/, 'should show dirty count')
})

test('StatusGroup: 三组渲染 + 状态字符 colorMap', () => {
    const src = read('src/components/workspace/git/StatusGroup.vue')
    assert.match(src, /statusClass/, 'must map status char to color class')
    assert.match(src, /text-warning|text-error|text-success/, 'must use semantic color classes')
    assert.match(src, /onClick/, 'click row should dispatch back to parent')
    assert.match(src, /oldPath/, 'must render rename arrow')
    // header actions slot + 行右键菜单
    assert.match(src, /name="actions"/, 'must expose actions slot for group-level buttons')
    assert.match(src, /buildItems/, 'must accept buildItems factory for per-row context menu')
    assert.match(src, /useContextMenu/, 'must wire contextmenu through useContextMenu')
    // 行内按钮：PC hover / mobile 始终可见（代替之前的 kebab）
    assert.match(src, /buildInlineActions/, 'must accept buildInlineActions factory for hover buttons')
    assert.match(src, /lg:invisible lg:group-hover:visible/, 'inline buttons must use invisible/visible (no row jitter)')
    // 明确不再使用 kebab + EllipsisVerticalIcon
    assert.doesNotMatch(src, /EllipsisVerticalIcon/, 'must NOT use kebab anymore (replaced by inline action buttons)')
})

test('HistoryList: load more + 展开 commit 文件', () => {
    const src = read('src/components/workspace/git/HistoryList.vue')
    assert.match(src, /loadMoreLog/)
    assert.match(src, /loadCommitFiles/)
    assert.match(src, /onOpenDiff/, 'must dispatch diff open to parent')
})

test('HistoryList: commit 行右键可复制完整提交信息', () => {
    const src = read('src/components/workspace/git/HistoryList.vue')
    assert.match(src, /useContextMenu/, 'history rows must use the shared workspace context menu')
    assert.match(src, /writeClipboard/, 'copy action must use the shared clipboard writer')
    assert.match(src, /formatCommitInfo\(commit\)/, 'copy action must format the full commit info')
    assert.match(src, /workspace\.git\.copyCommitInfo/, 'menu label must come from workspace git i18n')
    assert.match(src, /@contextmenu="onCommitContextMenu\(\$event, commit\)"/, 'commit row must open menu on right-click')
    assert.match(src, /catch \(err: any\)[\s\S]*toast\.error/, 'copy failures must show an error toast')
})

test('HistoryList: commit 文件行右键可打开文件/打开 diff/复制路径', () => {
    const src = read('src/components/workspace/git/HistoryList.vue')
    // commit 展开的文件行复用通用 buildGitFileMenu（与工作区/暂存区共用核心菜单）
    assert.match(src, /import \{ buildGitFileMenu[^}]*\} from ['"]\.\.\/\.\.\/\.\.\/composables\/useGitFileActions['"]/, 'must import buildGitFileMenu')
    assert.match(src, /buildAbsolutePath/, 'must import buildAbsolutePath to compose absolute path')
    // 拼绝对路径用 workspaceRoot + repo + file
    assert.match(src, /git\.workspaceRoot\.value/, 'must read workspaceRoot from the git store')
    // onOpenFile 打开工作区当前版本，由父组件透入
    assert.match(src, /onOpenFile/, 'must accept onOpenFile prop to open the working-tree version')
    // commit 文件行绑定 @contextmenu
    assert.match(src, /@contextmenu="onCommitFileContextMenu\(\$event, commit, f\)"/, 'commit file row must open menu on right-click')
})

test('WorkspaceViewer: 通过 type 切换 file vs diff', () => {
    const src = read('src/components/workspace/WorkspaceViewer.vue')
    assert.match(src, /useWorkspaceViewer/)
    assert.match(src, /WorkspaceFileView/, 'must use WorkspaceFileView for file mode')
    assert.match(src, /WorkspaceDiffEditor/, 'must use WorkspaceDiffEditor for diff mode')
    assert.match(src, /Escape/, 'must support Esc to close')
    // 防回归：全局 Ctrl/Cmd+S 快捷键（monaco addCommand 仅在编辑器获焦时生效，
    // 这里补充 viewer 范围内任意焦点都能响应）
    assert.match(src, /onSaveShortcut|ctrlKey.*metaKey|metaKey.*ctrlKey/,
        'must register a viewer-scoped Ctrl/Cmd+S handler')
    assert.match(src, /'keydown'/, 'must register keydown listener for shortcuts')
})

test('WorkspaceFileView: 默认可编辑 + 保存 + dirty 追踪，无 view/edit toggle', () => {
    const src = read('src/components/workspace/WorkspaceFileView.vue')
    assert.match(src, /fetchFile/, 'must fetch via agent-scoped API')
    assert.match(src, /saveFile/, 'must call saveFile')
    assert.match(src, /isDirty/, 'must track dirty state')
    assert.match(src, /KeyS/, 'must register Ctrl/Cmd+S save shortcut')
    assert.match(src, /defineExpose/, 'must expose state to parent (WorkspaceViewer)')
    // 明确不要 toggle 交互（VSCode 风格：默认就能编辑）
    assert.doesNotMatch(src, /toggleEdit/, 'must NOT expose toggleEdit (no view/edit mode toggle)')
    assert.doesNotMatch(src, /isEditing/, 'must NOT track isEditing flag')
    // scope=workspace|agent 双模式
    assert.match(src, /scope/, 'must accept scope prop for workspace/agent file routing')
    assert.match(src, /fetchAgentFile/, 'must support agent scope')
    assert.match(src, /saveAgentFile/, 'must save via agent scope endpoint')
    // 防回归：save() 必须带 loading guard，避免 load 窗口内写旧内容到新路径
    assert.match(src, /loading\.value/, 'save() must guard against in-flight load')
    // 防回归：props 变化必须同步重置 content/baseline，避免 viewer.dirty 错挂新路径
    assert.match(
        src,
        /watch\(\(\) => \[props\.agentId, props\.path[^]+?content\.value = ''[^]+?baselineContent\.value = ''/,
        'switching props must reset content/baseline before loadFile'
    )
    // 防回归：fetch 期间 editor 临时只读（避免输入被 setValue 覆盖）
    assert.match(src, /editor\?\.updateOptions\(\{ readOnly: true \}\)/,
        'must temporarily set readOnly during load to avoid losing edits')
})

// 防回归：SVG 预览必须走空 sandbox iframe——内嵌 <script>/事件处理器一律不执行，
// 且不得与主文档同源；将来不得“好心”加回 allow-scripts / allow-same-origin
test('WorkspaceFileView: SVG 预览走空 sandbox iframe，杜绝 XSS 面', () => {
    const src = read('src/components/workspace/WorkspaceFileView.vue')
    assert.match(src, /previewKind === 'svg'/, 'must have svg preview branch')
    const m = src.match(/previewKind === 'svg'"[\s\S]{0,200}?sandbox="([^"]*)"/)
    assert.ok(m, 'svg preview iframe must declare a sandbox attribute')
    assert.ok(!m[1].includes('allow-scripts'), 'svg sandbox must NOT allow scripts')
    assert.ok(!m[1].includes('allow-same-origin'), 'svg sandbox must NOT share origin')
    const api = read('src/composables/workspace-api.ts')
    assert.match(api, /\\\.svg\$\/i/, 'previewableExt must match .svg')
})

test('WorkspaceDiffEditor: monaco diff editor + split/inline 切换', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    assert.match(src, /createDiffEditor/, 'must use monaco.editor.createDiffEditor')
    assert.match(src, /fetchFileVersions/, 'must fetch both sides via file-versions endpoint')
    assert.match(src, /renderSideBySide/, 'must support side-by-side toggle')
    assert.match(src, /sideBySide/, 'must expose split/inline state')
    assert.match(src, /binary/, 'must show binary placeholder')
    assert.match(src, /truncated/, 'must show truncated banner')
    // 明确不走 hljs / unified-text fallback
    assert.doesNotMatch(src, /hljs/, 'must NOT fall back to hljs unified diff')
})

test('ChatHeader: 包含 RectangleGroupIcon panel toggle，PC 与移动端共用', () => {
    const src = read('src/components/chat/ChatHeader.vue')
    assert.match(src, /RectangleGroupIcon/, 'must import RectangleGroupIcon for workspace toggle')
    assert.match(src, /useWorkspacePanel/, 'must call useWorkspacePanel')
    assert.match(src, /panel\.toggle/, 'toggle button must call panel.toggle')
    // 防回归：panel toggle 不能被限定为 PC only，移动端也需要能打开 right-drawer
    assert.match(src, /v-if="chatState\.agentsSelectedId"\s+@click="panel\.toggle\(\)"/,
        'panel toggle must live outside the PC-only `hidden lg:flex` block')
    // 该按钮在选中 agent 时才显示，避免点开空 drawer
    assert.match(src, /chatState\.agentsSelectedId/, 'must hide toggle when no agent selected')
    // 负向断言：该按钮不能再携 hidden lg:inline-flex（那是之前的 PC-only 状态）
    assert.doesNotMatch(
        src,
        /hidden lg:inline-flex[^"]*"[^>]*workspace\.toggle/,
        'workspace toggle must NOT carry the PC-only `hidden lg:inline-flex` class anymore'
    )
})

test('HomeView: 接入 WorkspacePanel + WorkspaceViewer + 快捷键', () => {
    const src = read('src/views/HomeView.vue')
    assert.match(src, /WorkspacePanel/)
    assert.match(src, /WorkspaceViewer/)
    assert.match(src, /useWorkspacePanel/)
    assert.match(src, /useWorkspaceViewer/)
    assert.match(src, /handleWorkspaceShortcut/, 'must register keyboard shortcut handler')
    assert.match(src, /metaKey|ctrlKey/, 'shortcut must accept Ctrl/Meta modifier')
    // session/agent 切换 → 关闭 viewer（带 dirty toast）
    assert.match(src, /chatState\.sessionKey/, 'must watch sessionKey')
    assert.match(src, /chatState\.agentsSelectedId/, 'must also watch agentsSelectedId (for /new agent dropdown)')
    assert.match(src, /wsViewer\.close\(\)/, 'session/agent switch must close viewer')
    assert.match(src, /discardedDirty/, 'must toast discardedDirty when closing dirty viewer')
    assert.doesNotMatch(src, /if \(!prev\)\s/, 'must NOT skip null→value transition with !prev guard on session watch')
    // 移动端 drawer
    assert.match(src, /workspace-drawer/, 'must mount mobile right-drawer (id=workspace-drawer)')
    assert.match(src, /drawer-end/, 'mobile workspace drawer must slide from the right')
    assert.match(src, /:mobile="true"/, 'mobile WorkspacePanel must receive mobile prop')
    assert.match(src, /useMediaQuery/, 'must use useMediaQuery to gate viewer-auto-close behaviour')
    assert.match(src, /wsViewer\.current/, 'must watch viewer.current to auto-close drawer on mobile')
    // 防回归：isMobile 进入时强制 wsPanel.close，避免跨会话持久化的 isOpen 在 mobile 上默认盖屏
    assert.match(src, /watch\(isMobile/, 'must watch isMobile to force-close drawer when entering mobile breakpoint')
    // 防回归：mobile drawer 内容懒加载，避免未访问者付出 fetch 代价
    assert.match(src, /mobilePanelMounted/, 'mobile drawer body must be lazy-mounted on first open')
    // 全局 context menu 挂在 HomeView 根，避免被 panel/drawer overflow 裁切
    assert.match(src, /WorkspaceContextMenu|ContextMenu/, 'must mount global workspace context menu at HomeView root')
})

test('WorkspaceFileView: 向 viewer 同步 dirty 状态', () => {
    const src = read('src/components/workspace/WorkspaceFileView.vue')
    assert.match(src, /useWorkspaceViewer/, 'must read viewer composable')
    assert.match(src, /viewer\.setDirty/, 'must propagate dirty state to viewer')
})

test('WorkspaceFileView: text 模式接受 language prop 并在 loadText 优先使用', () => {
    const src = read('src/components/workspace/WorkspaceFileView.vue')
    // 接受可选 language prop（代码块全屏按 fence 语言高亮，而非内容猜）
    assert.match(src, /language\?:\s*string/, 'must accept an optional language prop for text mode')
    // loadText 必须优先用 props.language（而非仅 guessLanguageFromContent）
    assert.match(src, /props\.language/, 'loadText must prefer the language prop over content-based guess')
    // 复用共享的标签 → monaco id 解析（不内联映射表，避免与 monaco-setup 漂移）
    assert.match(src, /resolveLanguageId/, 'must resolve fence label via shared resolveLanguageId')
})

test('monaco-setup: 导出 resolveLanguageId（代码块语言标签 → monaco id，未知回退 plaintext）', () => {
    const src = read('src/components/workspace/monaco-setup.ts')
    assert.match(src, /export function resolveLanguageId/, 'must export resolveLanguageId')
    assert.match(src, /plaintext/, 'must fall back to plaintext for unknown labels')
})

test('markdown: 代码块全屏读取 fence 语言并透传给 openText', () => {
    const src = read('src/utils/markdown/markdown.ts')
    // 必须从代码块头部 .code-language 取语言（否则全屏丢失高亮）
    assert.match(src, /code-language/, 'onFullscreen must read the language from the .code-language span')
    // 仍走统一的 openText（现在带语言参数）
    assert.match(src, /openText\(/, 'must dispatch fullscreen via openText')
})

// ── Mutation × 磁盘副作用同步（audit 回归点）──
// Files tab 的文件 mutation 与编辑器保存都会改 worktree → git status / repos 下拉
// 数据源必须同步；discard 会 revert/删文件 → 树缓存与 viewer 必须跟进。

test('WorkspaceTabGit: discard 后同步磁盘副作用（树缓存失效 + viewer 重载/关闭）', () => {
    const src = read('src/components/workspace/WorkspaceTabGit.vue')
    assert.match(src, /function afterDiscard/, 'must define afterDiscard for disk side-effects')
    // 单文件与全部丢弃两条路径都要走 afterDiscard；stagedAdds 与 repo 同源闭包传入
    assert.match(
        src,
        /onDiscard: group === 'unstaged' && repo\s*\?\s*async \(\) => \{[\s\S]*?afterDiscard\(\[change\], repo, stagedAdds\)/,
        'single-file discard must run afterDiscard with the same repo as git.discard',
    )
    assert.match(
        src,
        /onConfirmed: async \(\) => \{[\s\S]*?afterDiscard\(list, repo, stagedAdds\)/,
        'discard-all must run afterDiscard with the same repo as git.discard',
    )
    // staged-add（'A'/'R'/'C'，不在 HEAD）的文件 discard 后被服务端删除：必须在
    // discard 前快照 staged（discard 后 'A' 行已消失），否则 AM 文件被当还原处理
    // → 树幽灵条目 + viewer 重开 404
    assert.match(
        src,
        /function stagedAddsSnapshot[\s\S]*?c\.status === 'A' \|\| c\.status === 'R' \|\| c\.status === 'C'/,
        'must snapshot staged A/R/C paths before discard for delete classification',
    )
    assert.match(
        src,
        /const stagedAdds = stagedAddsSnapshot\(\)[\s\S]*?await git\.discard/,
        'snapshot must be taken before git.discard (post-discard status no longer has the A rows)',
    )
    // discard 返回 stale（epoch 失配：切 agent / 改绑 workspace）→ 跳过 afterDiscard
    assert.match(
        src,
        /const r = await git\.discard\([\s\S]*?if \(r\.stale\) return[\s\S]*?await afterDiscard/,
        'must skip afterDiscard when discard reports stale (rebind keeps currentAgentId, ownership check alone cannot block)',
    )
    // untracked 被删 / 目录增删 → 失效已缓存（展开过）的受影响目录**及祖先链**并重拉
    assert.match(src, /tree\.invalidate\(/, 'must invalidate tree cache of deleted parents')
    assert.match(src, /entriesAt\(dir\)[\s\S]*?isLoading\(dir\)/, 'must only reload already-cached dirs')
    assert.match(
        src,
        /for \(let dir = p; ; dir = dir\.includes\('\/'\) \? dir\.slice\(0, dir\.lastIndexOf\('\/'\)\) : ''\)/,
        'must walk the ancestor chain (dir itself may be uncached while the stale listing lives in the nearest cached ancestor)',
    )
    // viewer 正看着被删的 untracked 文件 → 关闭；看着被还原的 tracked 文件且无未保存改动 → close+nextTick+open 强制重载
    // （close 与 openFile 必须隔 nextTick：同 tick 批处理会让 v-if 保留实例、不重拉）
    assert.match(src, /deletedPaths\.has\(cur\.path\)[\s\S]*?viewer\.close\(\)/, 'must close viewer showing deleted untracked file')
    assert.match(src, /viewer\.close\(\)\s*await nextTick\(\)\s*viewer\.openFile\(cur\.path\)/, 'must force-reload reverted file via close+nextTick+open')
    // discard await 期间切 agent → 续体不得污染新 agent 的缓存与 viewer（全局单槽）
    assert.match(src, /afterDiscard[\s\S]*?git\.currentAgentId !== props\.agentId/, 'afterDiscard must guard against agent switch during in-flight discard')
    // repo / stagedAdds 必须由调用方闭包传入（discard 用的同一时点），不得在 await 后重读
    // selectedRepo：用户可能已在在飞期间切了仓库，用新仓库算前缀会失效错目录/关错 viewer
    assert.match(src, /function afterDiscard\(changes: FileChange\[\], repo: string, stagedAdds: Set<string>\)/, 'afterDiscard must take repo/stagedAdds from caller closure, not re-read selectedRepo')
    // 分类逻辑必须走 classifyDiscardEffects（staged-add 删除判别不可内联重造）
    assert.match(src, /classifyDiscardEffects\(changes, repo, stagedAdds\)/, 'must classify via classifyDiscardEffects')
    const adStart = src.indexOf('function afterDiscard')
    // 边界须容忍 async function（相邻函数可能是 async，如 openFile）
    const adEnd = src.slice(adStart + 1).search(/\n(?:async )?function /)
    const adBody = src.slice(adStart, adEnd !== -1 ? adStart + 1 + adEnd : undefined)
    assert.ok(!adBody.includes('selectedRepo'), 'afterDiscard body must NOT read selectedRepo (stale after in-flight repo switch)')
    // tracked 'D'（工作区删除）discard = git restore 恢复文件回磁盘 → 父目录列表新增
    // 条目，需要失效父目录缓存，否则幽灵缺失
    // （分类已抽到 classifyDiscardEffects 纯函数，行为由 workspace-git.test.ts 锁死）
    // 被删 untracked 文件的 viewer 有未保存改动 → buffer 是唯一副本，先确认再关
    // （与 FileTreeNode.onDeleted 同语义）
    assert.match(
        src,
        /deletedPaths\.has\(cur\.path\)\)[\s\S]*?dirty\.value\?\.path === cur\.path[\s\S]*?confirm\([\s\S]*?viewer\.close\(\)/,
        'must confirm before closing dirty viewer of discarded untracked file',
    )
    // 首次 loadRepos 在飞时 tab 重挂载：不得因 reposLoading 跳过 await —— 在飞请求
    // 完成后无人补跑选仓逻辑，tab 会停在空壳（无选中无状态无历史）
    assert.doesNotMatch(src, /if \(!git\.reposLoading\.value\)/, 'onMounted must NOT skip loadRepos when one is in flight (blank-tab trap)')
    // await 后归属复查：旧实例续体不得用新 agent 的 repos[0] 写旧 agent 的持久化选择
    assert.match(
        src,
        /await git\.loadRepos\(props\.agentId\)[\s\S]*?git\.currentAgentId !== props\.agentId[\s\S]*?return/,
        'onMounted must re-check store ownership after loadRepos await',
    )
})

test('WorkspaceTabFiles: workspace 文件 mutation 后刷新 git（status + repos 下拉数据源）', () => {
    const src = read('src/components/workspace/WorkspaceTabFiles.vue')
    assert.match(src, /useWorkspaceGit/, 'must import git store')
    assert.match(
        src,
        /onMutatedWorkspace[\s\S]*?refreshWorktreeState/,
        'onMutatedWorkspace must refresh git store (worktree changed)',
    )
    // agent scope（agent 配置目录）不在 repos 扫描范围内，不该触发
    assert.doesNotMatch(src, /onMutatedAgent[\s\S]*?refreshWorktreeState/, 'agent-scope mutations must not touch git store')
})

test('FileTreeNode: workspace 文件 mutation 后刷新 git store', () => {
    const src = read('src/components/workspace/FileTreeNode.vue')
    assert.match(src, /useWorkspaceGit/, 'must import git store')
    assert.match(src, /onMutated[\s\S]*?refreshWorktreeState/, 'onMutated must refresh git store')
})

test('WorkspaceFileView: workspace 保存后重拉 repos（下拉 dirty 徽标数据源）', () => {
    const src = read('src/components/workspace/WorkspaceFileView.vue')
    // 刷新逻辑抽到 utils/gitSaveRefresh（notifyGitFileSaved，行为有专属单测）；
    // 这里断言 workspace scope 的保存收尾确实调用了它。
    assert.match(
        src,
        /scopeAtStart === 'workspace'[\s\S]*?notifyGitFileSaved\(/,
        'save in workspace scope must refresh repos summary (via notifyGitFileSaved)',
    )
    // 保存网络往返期间可能已切 agent：组件卸载后 props 冻结、三联快照恒真，
    // 必须额外校验 store 归属，否则旧 agent 的刷新会写进新 agent 的 store
    assert.match(
        src,
        /scopeAtStart === 'workspace' && git\.currentAgentId === agentAtStart/,
        'save tail refresh must be gated by store ownership',
    )
})

// ── 二轮 audit 修复的回归点（嵌套仓库选择 / tab 后台刷新 / 改绑失效 / 双实例 / 保存竞态）──

test('WorkspaceTabGit: 显式仓库选择不被静默覆写 + tab 挂载后台刷新 + stale 不 toast', () => {
    const src = read('src/components/workspace/WorkspaceTabGit.vue')
    // 嵌套仓库（不在 /repos 列表）被徽章显式选中后，onMounted/refresh 不得回退 repos[0]
    assert.doesNotMatch(
        src,
        /!repo \|\| !git\.repos\.value\.find/,
        'must not clobber explicit (possibly nested) repo selection',
    )
    // 缓存命中也后台重拉：agent/终端可能已在面板外改过 git 状态
    assert.match(src, /void loadAll\(repo\)/, 'must background-refresh status+log on cache hit')
    assert.match(src, /void git\.loadRepos\(props\.agentId\)/, 'must background-refresh repos on cache hit')
    // agent 切换后的迟到 mutation 返回 stale → 跳过成功 toast（误导归属）
    const toastSkips = src.match(/if \(!r\.stale\) toast\.success/g) || []
    assert.ok(toastSkips.length >= 2, `commit+sync 都要 stale 守卫，got ${toastSkips.length}`)
    // diff viewer 对着被丢弃文件：强制重开（commit diff 跳过）
    assert.match(
        src,
        /cur\?\.type === 'diff'[\s\S]*?cur\.mode !== 'commit'[\s\S]*?viewer\.openDiff/,
        'must force-reload unstaged/untracked diff of discarded file',
    )
})

test('RepoSelector: 嵌套仓库（不在 /repos 列表）合成仅名字的展示条目', () => {
    const src = read('src/components/workspace/git/RepoSelector.vue')
    assert.match(src, /lastIndexOf\('\/'\)/, 'must derive display name for nested repo selection')
})

test('useWorkspaceRefresh: refreshAll 快照 agentId + 手动刷新带 refresh=1', () => {
    // 刷新逻辑已从 WorkspacePanel 抽到 useWorkspaceRefresh（面板右键菜单 / Files 空白左键 / 文件行菜单共用）
    const src = read('src/composables/useWorkspaceRefresh.ts')
    // agentId 以参数快照传入；stale() 实时复查 = 防刷新中途切 agent 造成跨 agent 写串
    assert.match(src, /async function refreshAll\(agentId: string, getLiveAgentId\?: \(\) => string\)/,
        'refreshAll must snapshot agentId and accept live-agent getter')
    assert.match(src, /const stale = \(\) => !!getLiveAgentId && getLiveAgentId\(\) !== agentId/,
        'refreshAll must detect agent switch via stale()')
    assert.match(src, /refresh: true/, 'manual refresh must ask server to fetch upstream')
    // 树重展开 Promise.all 之后也必须复查：期间切 agent 时 agentFiles 已被
    // ensureAgent(reset) 归属新 agent，新 tab 的 immediate watch 已建好在飞占位；
    // 继续走 agentFiles.refresh() 会无条件清掉新 agent 的占位，而 loadPath(旧
    // agent) 被归属守护 no-op，无人重拉 → Agent Files 区卡死空白
    // 源码为 CRLF 行尾：归一化后再做位置断言
    const norm = src.replace(/\r\n/g, '\n')
    const iAll = norm.indexOf('await Promise.all(expandedPaths.map')
    const iRecheck = norm.indexOf('if (stale()) return', iAll)
    // 带换行匹配真实调用语句（本测试上方源码注释里也提到了 agentFiles.refresh()）
    const iAgentRefresh = norm.indexOf('agentFiles.refresh()\n', iAll)
    assert.ok(iAll !== -1, 'refresh must re-expand tree paths')
    assert.ok(iRecheck !== -1 && iAgentRefresh !== -1 && iRecheck < iAgentRefresh,
        'refresh must re-check agent ownership after tree re-expand await, BEFORE agentFiles.refresh() wipes new agent placeholder')
    // 调用方必须接线 live getter（等价于旧实现的 props.agentId !== agentId 实时比较）
    const panelSrc = read('src/components/workspace/WorkspacePanel.vue')
    assert.match(panelSrc, /refreshAll\(props\.agentId, \(\) => props\.agentId\)/,
        'panel must wire live agent getter so refresh bails out on agent switch')
})

test('WorkspaceViewer: close 等待保存落地后再走丢弃确认', () => {
    const src = read('src/components/workspace/WorkspaceViewer.vue')
    assert.match(
        src,
        /isSaving === true[\s\S]*?confirmDiscardIfDirty/,
        'close must wait for in-flight save before discard-confirm (否则确认丢弃的其实是已落盘的改动)',
    )
    // 等待期间用户已从树点开新文件 → 关闭意图已被取代，不能把新文件关掉
    assert.match(src, /const startTarget = viewer\.current\.value/, 'close must snapshot the target it was invoked for')
    assert.match(
        src,
        /viewer\.current\.value !== startTarget[\s\S]*?return/,
        'close must give up when the user opened a new file during the wait',
    )
})

test('FileTreeNode/AgentFileTreeNode: 删除改名级联失效 + dirty 确认后才关 viewer', () => {
    for (const f of ['src/components/workspace/FileTreeNode.vue', 'src/components/workspace/AgentFileTreeNode.vue']) {
        const src = read(f)
        assert.match(src, /invalidatePrefix\(deletedPath\)/, `${f} must cascade-invalidate subtree cache`)
        assert.match(
            src,
            /viewer\.dirty\.value\?\.path === cur\.path[\s\S]*?confirm\(/,
            `${f} must confirm before closing viewer with unsaved changes`,
        )
    }
})

test('HomeView: PC panel 与 drawer panel 双实例互斥', () => {
    const src = read('src/views/HomeView.vue')
    assert.match(src, /showWorkspacePanel && !isMobile/, 'PC panel must not mount on mobile')
    assert.match(src, /if \(!mobile\) mobilePanelMounted\.value = false/, 'drawer instance must unmount on desktop')
    // TDZ：isMobile watch 带 immediate:true，回调在注册点同步执行；
    // mobilePanelMounted 声明必须在 watch 之前，否则桌面首屏抛 ReferenceError
    const declIdx = src.indexOf('const mobilePanelMounted = ref(false)')
    const watchIdx = src.indexOf('watch(isMobile')
    assert.ok(declIdx !== -1 && watchIdx !== -1 && declIdx < watchIdx,
        'mobilePanelMounted must be declared BEFORE the immediate isMobile watch (TDZ ReferenceError on desktop load)')
    // 桌面端打开 panel（isOpen→true）不得置位 mobilePanelMounted：那会把 lg:hidden
    // 仅 CSS 隐藏的 drawer 实例也挂出来（双份 onMounted/订阅/请求）
    assert.match(src, /if \(open && isMobile\.value\) mobilePanelMounted\.value = true/, 'drawer lazy-mount must be gated by isMobile')
})

test('AgentOverview: 改绑 workspace 后失效三个 workspace store + 清仓库选择 + 关 viewer', () => {
    const src = read('src/components/agents/tabs/AgentOverview.vue')
    assert.match(src, /onWorkspaceUpdated[\s\S]*?wsGit\.reset\(\)/, 'must reset git store on rebind')
    assert.match(src, /wsTree\.reset\(\)/, 'must reset tree store on rebind')
    assert.match(src, /wsAgentFiles\.reset\(\)/, 'must reset agent-files store on rebind')
    assert.match(src, /clearRepoForAgent\(id\)/, 'must clear remembered repo selection on rebind')
    // viewer 是全局单槽：改绑后同相对路径指向新 workspace 的另一个文件，
    // 不关闭的话保存会写错地方
    assert.match(src, /onWorkspaceUpdated[\s\S]*?wsViewer\.close\(\)/, 'must close viewer on rebind (same rel-path would hit new workspace)')
})

// ── 三轮审核回归点（store 守护强化 + useConfirm 单槽语义）──

test('useWorkspaceGit: 三重防护（epoch + repo 门控 + seq）与同步归属守护', () => {
    const src = read('src/composables/useWorkspaceGit.ts')
    // 同 key 并发「后发起者胜」：慢旧响应（refresh=1 / 多仓 repos）不得覆盖已落地的新数据
    assert.match(src, /reposSeq/, 'loadRepos must have seq guard (later-issued wins)')
    assert.match(src, /statusSeq/, 'loadStatus must have seq guard (later-issued wins)')
    assert.match(src, /logSeq/, 'loadLog must have seq guard (later-issued wins)')
    // 翻页也要参与 logSeq：翻页在飞时 log 重拉（commit/sync 触发）换血第一页，
    // 旧翻页响应后到不得 append（边界重复条目）
    const lmStart = src.indexOf('async loadMoreLog(')
    const lmEnd = src.indexOf('async loadCommitFiles(', lmStart)
    const lmBody = src.slice(lmStart, lmEnd !== -1 ? lmEnd : undefined)
    assert.ok(lmBody.includes('mySeq = ++logSeq'), 'loadMoreLog (pagination) must also participate in logSeq')
    // 同步归属守护：旧组件的迟到续体（save 收尾等）在 agent 切换后调用时，
    // epoch 拦不住（起头才捕获，已是新值），必须同步拦
    assert.match(src, /function ownedBy/, 'loads must have sync ownership guard')
    // mutation 重拉仓库门控：在飞期间用户切了仓库 → 不得把 statusRepo/commitsRepo
    // 拉回旧仓库（选择器/状态列表错位 → 错仓 stage/commit）
    const gates = src.match(/state\.statusRepo === null \|\| state\.statusRepo === repo/g) || []
    assert.ok(gates.length >= 5, `stage/unstage/discard/commit/sync 五处都要仓库门控，got ${gates.length}`)
    const logGates = src.match(/state\.commitsRepo === null \|\| state\.commitsRepo === repo/g) || []
    assert.ok(logGates.length >= 2, 'commit/sync 的 log 重拉也要仓库门控')
    // loadLog 只在切仓库时清列表：同仓库后台重拉保留旧数据（History 不闪空）
    assert.match(src, /if \(state\.commitsRepo !== repo\)\s*\{[\s\S]*?state\.commitsData = \[\]/, 'loadLog must only clear commitsData when repo changes')
})

test('useConfirm: 单槽位移旧确认按「取消」结清（不 reject）', async () => {
    const { useConfirm } = await import('../src/composables/useConfirm.ts')
    const c = useConfirm() as any
    // 复位到干净状态（防止单例被前序测试污染）
    c.cancel()
    const first = c.confirm('旧确认')
    const second = c.confirm('新确认')
    // 旧 promise 被位移：必须以 false（取消）结清而非 reject（reject 会让调用方
    // catch 出无参 rejection → toast「删除: undefined」）
    const firstResult = await first
    assert.equal(firstResult, false, 'displaced confirm must resolve(false), not reject')
    // 新确认正常工作
    c.ok()
    assert.equal(await second, true)
})
