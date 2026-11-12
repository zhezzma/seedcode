import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
function read(rel: string): string {
    return readFileSync(path.resolve(dir, '..', rel), 'utf8')
}

const src = read('src/composables/useFileActions.ts')

test('useFileActions: sendMention 发送绝对路径的 @引用（不再按 scope 分 @agent: 前缀）', () => {
    // 改动：sendMention 现在发绝对路径，路径本身已唯一，无需 @agent: namespace 分流
    assert.match(
        src,
        /appendText\(`@\$\{buildAbsolutePath\(root, entry\.path\)\}`\)/,
        'sendMention must append @ + absolute path (buildAbsolutePath(root, entry.path))',
    )
    // copyMention 已移除
    assert.doesNotMatch(src, /workspace\.menu\.copyMention/, 'copyMention action must be removed')
})

test('useFileActions: 目录 entry 上禁用 file-only 操作', () => {
    // 发送 @引用 / 发送内容 / 下载 在目录上没有意义，必须 disabled
    const disabledMatches = src.match(/disabled: !isFile/g)
    assert.ok(disabledMatches && disabledMatches.length >= 3,
        `expected at least 3 'disabled: !isFile' (sendMention / sendContent / download), got ${disabledMatches?.length ?? 0}`)
})

test('useFileActions: download 动作走 fetchDownload + saveBlob，并通过 toast 上报错误', () => {
    assert.match(src, /workspace\.menu\.download/, 'menu must include download action')
    assert.match(src, /fetchDownload\(agentId, entry\.path, scope\)/, 'download must call fetchDownload with scope')
    assert.match(src, /saveBlob\(blob, entry\.name\)/, 'download must save blob via saveBlob using entry.name')
    assert.match(
        src,
        /toast\.error\(`\$\{tr\('workspace\.menu\.download'\)\}: \$\{e\?\.message \|\| String\(e\)\}`\)/,
        'download errors must include the action name as context prefix',
    )
    // i18n 双侧
    const en = read('src/i18n/en.ts')
    const zh = read('src/i18n/zh.ts')
    assert.match(en, /download: 'Download'/, 'en must define download')
    assert.match(en, /downloaded: 'Downloaded'/, 'en must define downloaded')
    assert.match(zh, /download: '下载'/, 'zh must define download')
    assert.match(zh, /downloaded: '已下载'/, 'zh must define downloaded')
})

test('useFileActions: rename 动作走 scope 路由 API、拒路径分隔符、刷新原父 + 关 viewer', () => {
    assert.match(src, /workspace\.menu\.rename\b/, 'menu must include rename action')
    // scope 三元选择重命名 API
    assert.match(src, /scope === 'agent' \? renameAgentEntry : renameEntry/, 'rename picks scope-specific API')
    // 纯改名：拒绝路径分隔符与 . / ..（与后端一致）
    assert.match(src, /name\.includes\('\/'\)/, 'rename must reject path separators (no move)')
    assert.match(src, /name === '\.\.'/, 'rename must reject .. as new name')
    // 重命名后旧路径失效：刷新 parentDir(entry.path) + onDeleted 关闭旧 viewer
    assert.match(
        src,
        /await rename\(agentId, entry\.path, name\)\s*\n[\s\S]*?await mutate\(parentDir\(entry\.path\)\)\s*\n\s*if \(onDeleted\) await onDeleted\(entry\.path\)/,
        'rename must refresh parentDir and close stale viewer via onDeleted',
    )
    // prompt 预填当前名字，取消（null）不报错
    assert.match(src, /window\.prompt\(tr\('workspace\.menu\.renamePrompt'\), entry\.name\)/, 'rename prompt must prefill current name')
    assert.match(src, /if \(raw === null\) return/, 'rename must early-return on prompt cancel')
    // i18n 双侧
    const en = read('src/i18n/en.ts')
    const zh = read('src/i18n/zh.ts')
    assert.match(en, /rename: 'Rename'/, 'en must define rename')
    assert.match(en, /renamed: 'Renamed'/, 'en must define renamed')
    assert.match(zh, /rename: '重命名'/, 'zh must define rename')
    assert.match(zh, /renamed: '已重命名'/, 'zh must define renamed')
})

test('useFileActions: sendContent 必须区分 binary / truncated / 错误三态，并通过 toast 上报', () => {
    // 必须把 binary 单独 warning，不当成正常发送
    assert.match(src, /data\.binary/, 'sendContent must check binary')
    assert.match(src, /toast\.warning\(tr\('workspace\.binaryFile'\)\)/, 'binary must emit binaryFile toast')

    // 截断也是 warning（用户的 chat 里有内容，但要知道是不完整的）
    assert.match(src, /data\.truncated/, 'sendContent must check truncated')
    assert.match(src, /workspace\.menu\.contentTruncated/, 'truncated must use contentTruncated key')

    // 错误必须 toast，不能静默吞
    assert.match(src, /catch \(e: any\)/, 'sendContent must catch fetch errors')
    assert.match(
        src,
        /toast\.error\(`\$\{tr\('workspace\.menu\.sendContent'\)\}: \$\{e\?\.message \|\| String\(e\)\}`\)/,
        'fetch errors must include the action name as context prefix',
    )
})

test('useFileActions: appendToChatInput 走 useChatInput.appendText\uff08\u907f\u514d\u8df3\u8fc7 history \u91cd\u7f6e\uff09', () => {
    // 不能直接戳 inputText.value：会与 useChatInput 内部的 historyIndex / savedDraft 失同步，
    // 用户在历史浏览态时 ArrowDown 会把追加的文本吃掉。
    assert.match(src, /useChatInput\(\)\.appendText/, 'must call useChatInput().appendText, not write inputText directly')
    assert.doesNotMatch(
        src,
        /ci\.inputText\.value\s*=/,
        'must NOT assign to inputText.value directly (would skip history reset)',
    )
})

test('useChatInput: appendText \u91cd\u7f6e history \u72b6\u6001\u540e\u518d\u5199\u5165', () => {
    const ci = read('src/composables/useChatInput.ts')
    // appendText 必须存在
    assert.match(ci, /const appendText = \(text: string\)/, 'must export appendText')
    // 必须显式重置 historyIndex / savedDraft；防止后续 ArrowDown 恢复 savedDraft 吞掉追加
    assert.match(
        ci,
        /const appendText[\s\S]+historyIndex\.value = -1[\s\S]+savedDraft\.value = ''/,
        'appendText must reset historyIndex and savedDraft before mutating inputText',
    )
    // 暴露在 export 里
    assert.match(ci, /\bappendText,/, 'appendText must be exported via _chatInputState')
})

test('useFileActions: fenceContent 根据 content 里最长连续反引号自适应 fence 长度', () => {
    // README / SKILL.md 里本身会出现 ``` 代码块，外层不能写死三反引号，
    // 否则内部的 ``` 会提前关闭外层，chat 渲染乱且 agent 拿到的也不再是单一 code block。
    assert.match(
        src,
        /content\.match\(\/`\+\/g\)/,
        'fenceContent must scan content for backtick runs',
    )
    assert.match(
        src,
        /'`'\.repeat\(Math\.max\(3, longest \+ 1\)\)/,
        'fenceContent must use longest+1 backticks (≥3) so inner ``` cannot close it',
    )
})

test('useFileActions: 菜单提供绝对 + 相对两种复制路径', () => {
    // 拆分是 UX 调整 — 不要回退到单一 copyPath
    assert.match(src, /workspace\.menu\.copyAbsolutePath/, 'must offer copyAbsolutePath as a distinct item')
    assert.match(src, /workspace\.menu\.copyRelativePath/, 'must offer copyRelativePath as a distinct item')
    assert.doesNotMatch(src, /workspace\.menu\.copyPath\b/, 'must NOT keep the legacy copyPath key')
    // 绝对路径需要拼 root + entry.path，走专用 helper
    assert.match(src, /buildAbsolutePath\(root, entry\.path\)/, 'absolute path action must call buildAbsolutePath with explicit root from caller')
})

test('useFileActions: 不跨模块 import composable（避免 HMR 下 singleton 分裂）', () => {
    // 原本该文件 import 了 useWorkspaceTree / useAgentFiles 去拿 root，
    // 但 Vite HMR 重求值后出现多个独立 singleton，导致 FileTreeNode 读不到
    // WorkspaceTabFiles 写进去的 expanded 状态 → 目录点不开。
    // 修复后 root 由调用者从自己的 composable 拿并传入 args。
    assert.doesNotMatch(src, /from\s+['\"]\.\/useWorkspaceTree['\"]/,
        'must NOT import useWorkspaceTree (cross-module composable singleton splits under HMR)')
    assert.doesNotMatch(src, /from\s+['\"]\.\/useAgentFiles['\"]/,
        'must NOT import useAgentFiles (cross-module composable singleton splits under HMR)')
    // BuildArgs 必须接受 root，调用者负责传入
    assert.match(src, /root:\s*string\s*\|\s*null/, 'BuildArgs must require root passed in by caller')
})

test('useFileActions.buildAbsolutePath: 跨平台拼接 + 缺省安全退退', () => {
    // root 拿不到 → 退回 relPath，不会报错丢 "undefined/..."
    assert.match(src, /if \(!root\) return relPath/, 'must fall back to relPath when root is unavailable')
    // Windows 路径含反斜杠时，entry.path 的正斜杠要被转为反斜杠，避免混合分隔符
    assert.match(
        src,
        /root\.includes\('\\\\'\)/,
        'must detect Windows roots by backslash presence',
    )
})

test('useFileActions: copyPath key 归属 viewer 菜单，文件树不回退到单一 copyPath', () => {
    const en = read('src/i18n/en.ts')
    const zh = read('src/i18n/zh.ts')
    assert.match(en, /copyAbsolutePath:/, 'en must define copyAbsolutePath')
    assert.match(en, /copyRelativePath:/, 'en must define copyRelativePath')
    assert.match(zh, /copyAbsolutePath:/, 'zh must define copyAbsolutePath')
    assert.match(zh, /copyRelativePath:/, 'zh must define copyRelativePath')
    // copyPath 重生为 viewer 菜单（useViewerActions）的单一「复制路径」项：
    // viewer 只有一项（绝对路径，root 缺失退回相对），与文件树的绝对/相对拆分不冲突。
    // 文件树菜单源码仍不得引用它（拆分是 UX 调整，不回退）。
    assert.match(en, /copyPath:/, 'en must define copyPath for the viewer menu')
    assert.match(zh, /copyPath:/, 'zh must define copyPath for the viewer menu')
    const va = read('src/composables/useViewerActions.ts')
    assert.match(va, /workspace\.menu\.copyPath/, 'viewer menu must own the copyPath key')
})

test('useFileActions: mutation 三件套（newFile / newDir / delete）均存在', () => {
    assert.match(src, /workspace\.menu\.newFile/, 'menu must include newFile')
    assert.match(src, /workspace\.menu\.newDir/, 'menu must include newDir')
    assert.match(src, /workspace\.menu\.delete\b/, 'menu must include delete')
    // newFile / newDir 仅在 dir entry 上启用
    assert.match(src, /disabled: !isDir/, 'newFile/newDir must require directory entry')
    // delete 必须走 useConfirm 弹 confirm
    assert.match(src, /useConfirm/, 'delete must require explicit user confirmation')
    assert.match(src, /confirm\(/, 'delete must call confirm()')
    // delete 必须 danger 样式
    assert.match(src, /danger: true/, 'delete must be marked danger')
})

test('useFileActions: validateChildName 拒绝绝对路径 / .. / 空段', () => {
    // 关键安全：用户从 prompt 输入的内容必须先校验
    assert.match(src, /trimmed\.startsWith\('\/'\)/, 'must reject absolute paths starting with /')
    assert.match(src, /trimmed\.startsWith\('\\\\'\)/, 'must reject absolute paths starting with backslash')
    assert.match(src, /seg === '\.\.'|seg === "\.\."/g, 'must reject .. segments')
    assert.match(src, /seg === '\.'|seg === "\."/g, 'must reject . segments')
})

test('useFileActions: mutation 用 onMutated 回调刷新树（不跨模块 import composable）', () => {
    // 与 root 一样的设计：actions 不直接调 useWorkspaceTree.invalidate，
    // 由 TreeNode 透入 onMutated callback，避免 HMR 下 singleton 分裂。
    assert.match(src, /onMutated\?:/, 'BuildArgs must accept optional onMutated callback')
    // 不能 import tree composable
    assert.doesNotMatch(src, /from\s+['"]\.\/useWorkspaceTree['"]/, 'must NOT import useWorkspaceTree')
    assert.doesNotMatch(src, /from\s+['"]\.\/useAgentFiles['"]/, 'must NOT import useAgentFiles')
})

test('useFileActions: parentOf — dir entry 取自身，file entry 取父目录', () => {
    // dir 上的菜单点击 = 在该 dir 下创建；file 上的菜单 = 在 file 同级创建。
    assert.match(src, /entry\.type === 'dir'.*?return entry\.path/s, 'parentOf: dir returns its own path')
    assert.match(src, /lastIndexOf\('\/'\)/, 'parentOf: file extracts parent via lastIndexOf')
})

test('useFileActions: scope 路由 mutation API（workspace vs agent）', () => {
    // 与现有 fetchFile/fetchAgentFile 同样的 scope 三元
    assert.match(src, /scope === 'agent' \? createAgentFile : createFile/, 'create file picks scope-specific API')
    assert.match(src, /scope === 'agent' \? createAgentDir : createDir/, 'create dir picks scope-specific API')
    assert.match(src, /scope === 'agent' \? deleteAgentFile : deleteFile/, 'delete file picks scope-specific API')
    assert.match(src, /scope === 'agent' \? deleteAgentDir : deleteDir/, 'delete dir picks scope-specific API')
})

test('useWorkspaceTree / useAgentFiles: 暴露 invalidate(path) 用于精准刷新', () => {
    const ws = read('src/composables/useWorkspaceTree.ts')
    const af = read('src/composables/useAgentFiles.ts')
    assert.match(ws, /invalidate\(path: string\)/, 'workspace tree must expose invalidate')
    assert.match(af, /invalidate\(path: string\)/, 'agent files must expose invalidate')
    // invalidate 删单条而非全 reset
    assert.match(ws, /delete state\.cache\[path\]/, 'invalidate must delete single cache entry, not reset all')
    assert.match(af, /delete state\.cache\[path\]/, 'invalidate must delete single cache entry, not reset all')
})

test('useFileActions: 非法名 vs prompt 取消必须区分（非法要 toast）', () => {
    // reviewer Major: ../boom 不能和取消等价静默
    assert.match(src, /if \(raw === null\) return/, 'must early-return on prompt cancel BEFORE validation')
    assert.match(src, /workspace\.menu\.invalidName/, 'invalid input must use invalidName toast key')
    // i18n 双侧
    const en = read('src/i18n/en.ts')
    const zh = read('src/i18n/zh.ts')
    assert.match(en, /invalidName:/, 'en must define invalidName')
    assert.match(zh, /invalidName:/, 'zh must define invalidName')
})

test('useFileActions: validateChildName 拦截 Windows 盘符绝对路径', () => {
    // reviewer Nit: C:\foo / D:/bar 也要拦，与 “不能是绝对路径” 语义一致
    assert.match(src, /\^\[a-zA-Z\]:\[\\\\\/\]/, 'must reject Windows drive-letter absolute paths')
})

test('useFileActions: 暴露 runNewFileFlow / runNewDirFlow 入口供 toolbar 共用', () => {
    // 根目录工具栏与右键菜单共用同一组流程，避免 prompt + validate + create 逻辑两边走样
    assert.match(src, /export async function runNewFileFlow/, 'must export runNewFileFlow')
    assert.match(src, /export async function runNewDirFlow/, 'must export runNewDirFlow')
    // 接受 parentPath 作为入参，可为 ""（根）或任意已存在目录
    assert.match(src, /parentPath: string/, 'RootMutationArgs must accept parentPath')
})

test('useFileActions: BuildArgs 暴露 onDeleted 回调供关闭 viewer 用', () => {
    assert.match(src, /onDeleted\?:/, 'BuildArgs must accept onDeleted callback')
    // delete action 顺序：rm → mutate(parentDir(entry.path)) → onDeleted(entry.path) → toast
    // 用 parentDir 而不是 parentOf：parentOf(dir) = dir.path 是「在这里建子项」语义，
    // 删除后这个路径已不存在，必须刷新它的原父。
    assert.match(
        src,
        /await mutate\(parentDir\(entry\.path\)\)\s*\n\s*if \(onDeleted\) await onDeleted\(entry\.path\)/,
        'delete must invalidate parentDir(entry.path), not parentOf(entry)',
    )
})

test('FileTreeNode: 删除后用 viewer.current 检查，路径匹配则关闭 viewer', () => {
    const src = read('src/components/workspace/FileTreeNode.vue')
    assert.match(src, /useWorkspaceViewer/, 'must read viewer composable')
    assert.match(src, /function onDeleted\(deletedPath: string\)/, 'must implement onDeleted')
    // 必须比较 viewer.current.path 与 deletedPath（或被删的目录是当前文件的祖先）。
    // 形式：不匹配则早退；命中且无未保存改动 → close，有未保存改动先 confirm（audit #11）。
    assert.match(
        src,
        /cur\.path !== deletedPath && !cur\.path\.startsWith\(deletedPath \+ '\/'\)\) return/,
        'must early-return when deleted path does not match current file',
    )
    assert.match(src, /viewer\.close\(\)/, 'must close viewer on match')
})

test('AgentFileTreeNode: 删除后用 viewer.current 检查，类型为 agent-file 才处理', () => {
    const src = read('src/components/workspace/AgentFileTreeNode.vue')
    assert.match(src, /useWorkspaceViewer/, 'must read viewer composable')
    assert.match(src, /cur\.type !== 'agent-file'/, 'agent-file scope must check type=agent-file')
})

test('WorkspaceTabFiles: 根目录 toolbar 提供 New File / New Dir 按钮', () => {
    const src = read('src/components/workspace/WorkspaceTabFiles.vue')
    // 工具栏调用 runNewFileFlow / runNewDirFlow，parentPath: ''
    assert.match(src, /runNewFileFlow/, 'toolbar must call runNewFileFlow')
    assert.match(src, /runNewDirFlow/, 'toolbar must call runNewDirFlow')
    assert.match(src, /parentPath: ''/, 'root toolbar must pass parentPath: \'\'')
    // workspace 与 agent 各自一组（onMutated 也分两个，避免串台）
    assert.match(src, /onMutatedWorkspace/, 'must define separate onMutated for workspace tree')
    assert.match(src, /onMutatedAgent/, 'must define separate onMutated for agent files tree')
    // toolbar 用图标按钮（DocumentPlus / FolderPlus）
    assert.match(src, /DocumentPlusIcon/, 'toolbar must use DocumentPlusIcon')
    assert.match(src, /FolderPlusIcon/, 'toolbar must use FolderPlusIcon')
    // Workspace 区顶部肩 header：左侧标题 + 右侧按钮，与底部 CollapsibleSection 风格一致
    assert.match(src, /workspace\.workspace/, 'workspace section header must use i18n key workspace.workspace')
    // Agent 区按钮放进 CollapsibleSection 的 #actions slot，不在 body 里
    assert.match(
        src,
        /<template #actions>[\s\S]*?onNewAgentFile[\s\S]*?onNewAgentDir[\s\S]*?<\/template>/,
        'agent buttons must live inside CollapsibleSection #actions slot, not in body',
    )
})

test('useFileActions: runUploadFlow 暴露入口 + 仅 workspace scope 防御', () => {
    // toolbar / 右键菜单共用入口
    assert.match(src, /export async function runUploadFlow/, 'must export runUploadFlow')
    // 函数级防御：非 workspace scope 不上传（菜单源头已不展示 agent scope 的项）
    assert.match(src, /if \(scope !== 'workspace'\)/, 'runUploadFlow must guard against non-workspace scope')
})

test('useFileActions: 多文件上传逐个循环，单文件失败不中断', () => {
    assert.match(src, /for \(const file of files\)/, 'must upload each file in a loop')
    assert.match(src, /let ok = 0/, 'must count successes')
    assert.match(src, /let failed = 0/, 'must count failures')
    // catch 内 failed++：单个失败被吞，循环继续
    assert.match(src, /} catch \{[\s\S]*?failed\+\+/, 'single failure must not abort remaining uploads')
})

test('useFileActions: 上传结果三态 toast（全成 / 全败 / 部分）', () => {
    // 三分支分别用不同 toast 级别与文案
    assert.match(src, /if \(failed === 0\)/, 'branch: all success')
    assert.match(src, /else if \(ok === 0\)/, 'branch: all failure')
    assert.match(src, /workspace\.menu\.uploadPartial/, 'partial branch must use uploadPartial key')
})

test('useFileActions: 上传共享 input —— 重置 value 以允许重选同一文件', () => {
    // 不重置 value，第二次选同一文件不触发 change
    assert.match(src, /input\.value = ''/, 'must reset input.value before each click')
    assert.match(src, /input\.addEventListener\('change', onChange\)/, 'must bind change listener')
    assert.match(src, /input\.removeEventListener\('change', onChange\)/, 'must unbind change listener after resolve')
})

test('useFileActions: upload 菜单项仅 workspace scope 展示', () => {
    // agent 配置目录无 /upload 端点：菜单项不应在 agent scope 出现，
    // 否则用户点到一个看似可用的项却只弹无意义 warning。
    assert.match(
        src,
        /\.\.\.\(scope === 'workspace' \? \[\{[\s\S]*?workspace\.menu\.upload[\s\S]*?\}\] as ContextMenuItem\[\] : \[\]\)/,
        'upload menu item must only render when scope === workspace (agent scope omits it entirely)',
    )
})

test('useFileActions: upload 相关 i18n 双侧补齐', () => {
    const en = read('src/i18n/en.ts')
    const zh = read('src/i18n/zh.ts')
    assert.match(en, /upload: 'Upload File'/, 'en upload')
    assert.match(en, /uploadedMany: 'Uploaded \{count\} files'/, 'en uploadedMany')
    assert.match(en, /uploadFailed: 'Upload failed'/, 'en uploadFailed')
    assert.match(en, /uploadPartial: 'Uploaded \{ok\}, \{failed\} failed'/, 'en uploadPartial')
    assert.match(zh, /upload: '上传文件'/, 'zh upload')
    assert.match(zh, /uploadedMany: '已上传 \{count\} 个文件'/, 'zh uploadedMany')
    assert.match(zh, /uploadPartial: '已上传 \{ok\} 个，\{failed\} 个失败'/, 'zh uploadPartial')
})

test('useFileActions.parentDir: 分隔符无关（Windows 反斜杠绝对路径也能取父目录）', () => {
    // viewer 菜单「在终端中打开」直接传 buildAbsolutePath 的产物；Windows 上是
    // 反斜杠路径，只认 / 的 parentDir 会返回 '' → openInTerminalAt('') 静默 no-op。
    // 文件树调用方传正斜杠相对路径，lastIndexOf('\\') 恒为 -1，行为不变。
    assert.match(src, /export function parentDir\(p: string\): string \{[\s\S]*?lastIndexOf\('\\\\'\)/,
        'parentDir must handle backslash separators too')
})
