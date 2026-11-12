# Viewer 顶栏「⋮ 更多」菜单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 WorkspaceViewer 顶栏的独立 Copy 按钮收进「⋮ 更多」下拉菜单，菜单含复制路径（绝对）/复制内容/复制文件名/发送到聊天/下载/本地打开三件套；diff 模式含复制 diff/复制修改后内容/下载 .patch；text 模式补上复制内容；顶栏面包屑 PC 显示全路径、移动端只显示文件名。

**Architecture:** 复用现有单例 ContextMenu（useContextMenu + ContextMenu.vue，文件树 kebab 同款链路）承载下拉；新建 `useViewerActions.ts` 工厂函数 `buildViewerMenuItems()` 生成 `ContextMenuItem[]`（镜像 useFileActions.buildFileMenuItems 模式），最大化复用 useFileActions 已导出的 buildAbsolutePath/shouldShowLocalOpenItems/openInTerminalAt，并新导出 fenceContent/runOpenerAction/parentDir 供两处共用。WorkspaceViewer 顶栏挂 ⋮ 按钮 → `ctxMenu.openAtElement(items, el)`。

**Tech Stack:** Vue 3 + TypeScript + daisyUI + heroicons + vue-i18n；测试 node:test 源码正则断言（项目惯例）。

**Spec:** 本文档自带（brainstorming 已由用户逐项确认：只收复制类 / 绝对路径 / diff 两项都放 / 增强项组合 / 移动端文件名）。

## Global Constraints

- 不提交 git（AGENTS.md：未经允许不擅自提交）
- i18n key 必须 zh/en 双侧同步添加
- 菜单项结构复用 `ContextMenuItem`（useContextMenu.ts），不自造新 item 类型
- 本地打开三件套门控与文件树一致：`shouldShowLocalOpenItems(isTauri, effectiveGatewayMode())`
- 发送到聊天后自动关 viewer，但必须走组件的 confirm-aware `close()`（dirty 不能静默丢弃）——composable 通过 `onClose` 回调注入，不直调 `viewer.close()`
- 验证命令：`npm test`（全量）与 `npm run tcs`（类型）；改动文件相关测试单跑加速

## Review Focus

1. **absolute scope 的 /assets URL**：不是真实文件系统路径 → 本地打开三件套必须隐藏（openPath 会失败）；复制路径照常复制 URL。
2. **root 拿不到（agentsList 未含该 agent）**：复制路径退回相对路径（不 disabled）；本地打开三件套 disabled/隐藏（无法拼绝对路径）。
3. **发送内容后关 viewer 遇 dirty buffer**：必须走 confirm-aware close，不得静默丢弃未保存修改。
4. **diff 模式 staged/commit**：右侧是 index/commit 内容不是工作区文件 → 发送 @引用 与本地打开三件套不得出现（文件可能已不存在/内容不符）。
5. **binary/媒体文件**：content 为空串 → 复制内容/发送内容必须 disabled（不得把空串当内容发出去）。

---

### Task 1: useViewerActions 菜单工厂 + useFileActions 导出 + i18n keys

**Files:**
- Create: `src/composables/useViewerActions.ts`
- Modify: `src/composables/useFileActions.ts`（导出 fenceContent / 抽取 runOpenerAction / 导出 parentDir）
- Modify: `src/i18n/zh.ts`、`src/i18n/en.ts`（workspace.menu 下加 4 个 key）
- Test: `tests/workspace-viewer-actions.test.ts`（新建）

**Interfaces:**
- Consumes（useFileActions 新导出）:
  - `fenceContent(path: string, content: string): string`
  - `runOpenerAction(labelKey: string, run: (opener: typeof import('@tauri-apps/plugin-opener')) => Promise<void>): Promise<void>`（原 buildFileMenuItems 内闭包 runOpener 抽出，toast 错误前缀行为不变）
  - `parentDir(p: string): string`（原私有函数导出）
  - 已有导出不变：`buildAbsolutePath(root, relPath)`、`shouldShowLocalOpenItems(isTauriEnv, mode)`、`openInTerminalAt(dirAbsPath)`
- Produces（Task 3 依赖）:
  - `buildViewerMenuItems(args: ViewerMenuArgs): ContextMenuItem[]`
  - `interface ViewerMenuArgs { agentId: string; target: ViewerTarget; fileContent: () => string; diffContent: () => string; getUnifiedDiff: () => Promise<string>; onClose: () => Promise<void> }`
  - i18n keys（zh / en）：`workspace.menu.copyPath`（复制路径 / Copy Path）、`copyContent`（复制内容 / Copy Content）、`copyDiff`（复制 diff / Copy Diff）、`downloadPatch`（下载 .patch / Download .patch）

**菜单内容（锁定）：**
- `text` 模式：仅 `复制内容`（disabled: !fileContent()）。
- `file | agent-file | absolute` 模式：
  - 复制路径 → scope 路由拼绝对路径：workspace=`agent.workspaceDir`+path、agent-file=`agent.agentDir`+path、absolute=path 本身（root 缺失退回相对路径）
  - 复制内容 → `fileContent()` 实时值（含未保存修改），disabled: 空串
  - 复制文件名 → path 最后一段（`/` 与 `\` 都处理）
  - 发送 @引用到聊天 → `useChatInput().appendText('@' + absPath)` + toast + `await onClose()`
  - 发送内容到聊天 → `appendText(fenceContent(path, content))` + toast + `await onClose()`，disabled: 空串
  - 下载 → 仅 workspace/agent scope（absolute 隐藏）；复用 fetchDownload+saveBlob+downloading toast 模式（同 useFileActions.download）
  - 本地打开三件套 → `shouldShowLocalOpenItems` 门控 + `/assets` 前缀隐藏 + root 缺失 disabled；终端打开传 `parentDir` 的绝对路径
- `diff` 模式：
  - 复制路径 → `buildAbsolutePath(agent.workspaceDir, repoJoin(repo, file))`，root 缺失退回 `repoJoin` 相对路径
  - 复制 diff → `getUnifiedDiff()`（空串 no-op；失败 toast `common.networkError`）
  - 复制内容 → `diffContent()`（modified 侧实时值），disabled: 空串
  - 发送 @引用到聊天 → 仅 `mode === 'unstaged' || 'untracked'`，其余 mode 不渲染该项
  - 下载 .patch → `getUnifiedDiff()` 空串 no-op；非空 `saveBlob(blob, basename + '.patch')`
  - 本地打开三件套 → 同 file 模式门控 + 仅 unstaged/untracked

- [ ] **Step 1: 写失败测试 `tests/workspace-viewer-actions.test.ts`**

源码正则断言（惯例同 workspace-file-actions.test.ts），覆盖：
```ts
// useFileActions 导出三件
assert.match(src, /export function fenceContent/)
assert.match(src, /export async function runOpenerAction|export function runOpenerAction/)
assert.match(src, /export function parentDir/)
// buildFileMenuItems 内改用共享 runOpenerAction（不再有闭包定义）
assert.doesNotMatch(src, /const runOpener = async/)
// useViewerActions：scope 路由
assert.match(va, /workspaceDir/, 'workspace scope root from agentsList')
assert.match(va, /agentDir/, 'agent scope root from agentDir')
assert.match(va, /startsWith\('\/assets'\)/, '/assets URL hides local-open trio')
assert.match(va, /scope !== 'absolute'/, 'download hidden for absolute scope')
assert.match(va, /mode === 'unstaged' \|\| target\.mode === 'untracked'/, 'diff send/local-open gated to worktree modes')
assert.match(va, /repoJoin\(/, 'diff path composed via repoJoin')
assert.match(va, /getUnifiedDiff\(\)/, 'diff copy/patch via getUnifiedDiff')
assert.match(va, /\.patch/, 'patch filename')
assert.match(va, /await onClose\(\)/, 'send actions close via injected confirm-aware callback')
assert.match(va, /fenceContent\(/, 'send content reuses fenceContent')
assert.match(va, /openInTerminalAt\(/, 'terminal opens parent dir')
// text 模式：仅复制内容
// i18n 双侧 4 key
assert.match(zh, /copyPath: '复制路径'/); assert.match(en, /copyPath: 'Copy Path'/) …（copyContent/copyDiff/downloadPatch 同理）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test tests/workspace-viewer-actions.test.ts`
Expected: FAIL（useViewerActions.ts 不存在 / export 缺失）

- [ ] **Step 3: 改 useFileActions.ts（导出 + 抽取，行为不变）**

`fenceContent`/`parentDir` 加 export；闭包 `runOpener` 抽为模块级 `export async function runOpenerAction(labelKey, run)`，buildFileMenuItems 内三处调用改用之。

- [ ] **Step 4: 写 `src/composables/useViewerActions.ts`**

`buildViewerMenuItems(args)` 按「菜单内容（锁定）」实现；复用 `tr` 2-liner（i18n.global）、`useToast`、`useChatInput().appendText`、`writeClipboard`、`fetchDownload`、`saveBlob`、`buildAbsolutePath`、`fenceContent`、`parentDir`、`shouldShowLocalOpenItems`、`openInTerminalAt`、`runOpenerAction`、`repoJoin`（useWorkspaceGit）、`ViewerTarget`（useWorkspaceViewer）、`ContextMenuItem`（useContextMenu）。root 来源：`useAgentsState().agentsList.find(a => a.id === agentId)`（useAppInit 启动即加载，可靠）。

- [ ] **Step 5: i18n 双侧加 4 key**（workspace.menu 下：copyPath/copyContent/copyDiff/downloadPatch）

- [ ] **Step 6: 跑测试确认通过 + 类型检查**

Run: `node --experimental-strip-types --test tests/workspace-viewer-actions.test.ts && npm run tcs`
Expected: PASS / 无类型错误

---

### Task 2: WorkspaceDiffEditor expose content

**Files:**
- Modify: `src/components/workspace/WorkspaceDiffEditor.vue`（defineExpose 加 `content`）
- Test: `tests/workspace-diff-editor-edit.test.ts`（追加一个 test）

**Interfaces:**
- Produces（Task 3 依赖）: `diffViewRef.value?.content` → string（modified 侧实时内容，内部已有该 ref，仅补 expose）

- [ ] **Step 1: 在 workspace-diff-editor-edit.test.ts 追加失败测试**

```ts
test('DiffEditor: expose content（viewer 菜单复制修改后内容用）', () => {
    const src = read('src/components/workspace/WorkspaceDiffEditor.vue')
    const expose = src.match(/defineExpose\(\{[\s\S]*?\}\)/)
    assert.ok(expose, 'defineExpose must exist')
    assert.match(expose[0], /\bcontent\b/, 'must expose content ref')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test tests/workspace-diff-editor-edit.test.ts`
Expected: 新 test FAIL

- [ ] **Step 3: defineExpose 数组加 `content`**（一行）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test tests/workspace-diff-editor-edit.test.ts`
Expected: PASS（含存量）

---

### Task 3: WorkspaceViewer 接线（⋮ 按钮 + 移除 Copy 按钮 + 移动端文件名）

**Files:**
- Modify: `src/components/workspace/WorkspaceViewer.vue`
- Test: `tests/workspace-viewer-actions.test.ts`（追加组件源码断言）

**Interfaces:**
- Consumes: Task 1 的 `buildViewerMenuItems` + `useContextMenu().openAtElement`；Task 2 的 `diffViewRef.content`

**模板改动（锁定）：**
- `#actions` 末尾（file/diff 两个 template 块之外，始终渲染）：⋮ 按钮 `EllipsisVerticalIcon`，`btn btn-ghost btn-sm btn-circle`，`aria-label=$t('workspace.menu.more')` + `aria-haspopup="menu"`，@click → `ctxMenu.openAtElement(buildViewerMenuItems({...}), e.currentTarget)`
- buildViewerMenuItems 实参：`fileContent: () => fileViewRef.value?.content ?? ''`、`diffContent: () => diffViewRef.value?.content ?? ''`、`getUnifiedDiff: () => diffViewRef.value!.getUnifiedDiff()`、`onClose: close`（组件已有的 confirm-aware close）
- 删除 file/diff 两个 Copy 按钮 + `onClickCopy`/`onClickCopyDiff`/`isCopyingDiff`（逻辑移入 Task 1 工厂）
- 面包屑 `#title`：两个 span——`lg:hidden` 显示 `breadcrumbShort`（basename），`hidden lg:inline truncate` 显示原 `breadcrumb`；dirty 圆点保持两 span 之外
- `breadcrumbShort` computed：file/agent-file/absolute → path 最后一段；diff → file 最后一段；text → title（同 breadcrumb 回退）
- Save/Preview/Split 按钮原样保留

- [ ] **Step 1: 追加失败测试（组件源码断言）**

```ts
test('Viewer: ⋮ 按钮挂 ContextMenu 单例（openAtElement + buildViewerMenuItems）', …)
// match: EllipsisVerticalIcon、openAtElement、buildViewerMenuItems、aria-haspopup="menu"
test('Viewer: 独立 Copy 按钮已移除（逻辑进 ⋮ 菜单）', …)
// doesNotMatch: onClickCopy、onClickCopyDiff、ClipboardDocumentIcon
test('Viewer: 面包屑 PC 全路径 / 移动端文件名', …)
// match: breadcrumbShort、lg:hidden（短标题）、hidden lg:inline（全路径）；dirty 圆点仍在
test('Viewer: Save/Preview/Split 按钮保留', …)
// match: onClickSave、onClickPreview、onClickToggleSplit
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test tests/workspace-viewer-actions.test.ts`
Expected: 新组件断言 FAIL

- [ ] **Step 3: 改 WorkspaceViewer.vue**（按「模板改动（锁定）」）

- [ ] **Step 4: 跑测试确认通过 + 全量回归 + 类型检查**

Run: `npm test && npm run tcs`
Expected: 全部 PASS（含存量 workspace-component-source / workspace-diff-editor-edit 无回归）

---

## Self-Review 结论

- 覆盖检查：复制路径/内容/文件名 ✓、diff 双项 ✓、发送/下载/本地打开 ✓、text 模式补缺 ✓、移动端文件名 ✓、Copy 按钮移除 ✓
- Review Focus 5 项均有对应断言（/assets 隐藏、root 缺失退回、onClose confirm、staged/commit 门控、空内容 disabled）
- 类型一致：ViewerMenuArgs 字段名与 Task 3 实参一致；`getUnifiedDiff` 签名与 WorkspaceDiffEditor expose 一致
- 比例：计划长度与改动量相当，无 TBD
