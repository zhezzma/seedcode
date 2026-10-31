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

test('useFileActions: 本地打开 gating —— 仅 Tauri 桌面 + local 网关模式', () => {
    // gating 必须是可测的纯函数：isTauri 环境探测 + effectiveGatewayMode 结果由调用方传入
    assert.match(
        src,
        /export function shouldShowLocalOpenItems\(isTauriEnv: boolean, mode: 'local' \| 'remote'\): boolean/,
        'must export shouldShowLocalOpenItems as a pure function',
    )
    assert.match(
        src,
        /return isTauriEnv && mode === 'local'/,
        'local-open items only when Tauri AND gatewayMode=local',
    )
    // 调用点必须真的用 isTauri + effectiveGatewayMode 计算 gating
    assert.match(src, /shouldShowLocalOpenItems\(isTauri, effectiveGatewayMode\(\)\)/, 'call site must pass isTauri + effectiveGatewayMode()')
    // isTauri 来自 notify-server-connection（window 探测），effectiveGatewayMode 来自 local-server
    assert.match(src, /import \{ isTauri \} from '\.\/notify-server-connection'/, 'isTauri must come from notify-server-connection')
    assert.match(src, /import \{ effectiveGatewayMode \} from '\.\/local-server'/, 'effectiveGatewayMode must come from local-server')
})

test('useFileActions: 本地打开两项置于菜单顶部（gating 关闭时整组不渲染）', () => {
    // gating 展开：非 local 环境（remote / 浏览器 / Android）整个数组不渲染
    assert.match(
        src,
        /\.\.\.\(showLocalOpen \? \[\{[\s\S]*?workspace\.menu\.openLocally[\s\S]*?workspace\.menu\.revealInFileManager[\s\S]*?\}\] as ContextMenuItem\[\] : \[\]\)/,
        'local-open items must be behind a single showLocalOpen spread (omitted entirely when gated off)',
    )
})

test('useFileActions: 本地打开菜单项 —— runOpener 统一入口 + openPath / revealItemInDir', () => {
    // 目录 → 文件管理器；文件 → 默认关联程序。走 opener 插件，零自定义 Rust 命令。
    assert.match(src, /await import\('@tauri-apps\/plugin-opener'\)/, 'opener plugin must be dynamically imported')
    // 错误处理单一入口：动态加载 + try/catch + toast 只写一份（避免双份漂移）
    assert.match(
        src,
        /toast\.error\(`\$\{tr\(labelKey\)\}: \$\{e\?\.message \|\| String\(e\)\}`\)/,
        'runOpener must own the toast.error with action-name prefix (single source)',
    )
    assert.match(src, /runOpener\('workspace\.menu\.openLocally'/, 'open action must route through runOpener with its label key')
    assert.match(src, /runOpener\('workspace\.menu\.revealInFileManager'/, 'reveal action must route through runOpener with its label key')
    assert.match(src, /o\.openPath\(absPath\)/, 'open action must call openPath with absolute path')
    assert.match(src, /o\.revealItemInDir\(absPath\)/, 'reveal action must call revealItemInDir with absolute path')
    // 绝对路径复用既有 helper（root 由调用方透入）
    assert.match(src, /const absPath = buildAbsolutePath\(root, entry\.path\)/, 'must build absolute path via existing helper')
})

test('useFileActions: 本地打开两项依赖 root（拿不到绝对路径时禁用），复制组补 separator', () => {
    // root 为 null 时无法拼绝对路径 → disabled
    const disabledRootMatches = src.match(/disabled: !root/g)
    assert.ok(disabledRootMatches && disabledRootMatches.length >= 2,
        `expected at least 2 'disabled: !root' (openLocally / revealInFileManager), got ${disabledRootMatches?.length ?? 0}`)
    // 前置两项后，原有「复制绝对路径」组要补前置分隔线（仅当本地项展示时）
    assert.match(
        src,
        /label: tr\('workspace\.menu\.copyAbsolutePath'\),\s*\n\s*icon: DocumentDuplicateIcon,\s*\n\s*separator: showLocalOpen/,
        'copyAbsolutePath must gain a separator when local-open items are shown',
    )
})

test('useFileActions: 本地打开 i18n 双侧补齐', () => {
    const en = read('src/i18n/en.ts')
    const zh = read('src/i18n/zh.ts')
    assert.match(en, /openLocally: 'Open with Local Program'/, 'en must define openLocally')
    assert.match(en, /revealInFileManager: 'Reveal in File Manager'/, 'en must define revealInFileManager')
    assert.match(zh, /openLocally: '用本地程序打开'/, 'zh must define openLocally')
    assert.match(zh, /revealInFileManager: '在文件管理器中显示'/, 'zh must define revealInFileManager')
})

test('useFileActions: 在终端中打开 —— 走自家 Rust 命令，与本地打开同 gating、同 root 依赖', () => {
    // 终端启动器随平台各异，opener 插件无此能力：动态 import api/core invoke 自家命令
    assert.match(src, /await import\('@tauri-apps\/api\/core'\)/, 'terminal action must dynamically import tauri core api')
    assert.match(
        src,
        /export async function openInTerminalAt\(dirAbsPath: string \| null\): Promise<void>/,
        'terminal action must be exported so the panel blank menu can reuse it',
    )
    assert.match(
        src,
        /invoke\('open_in_terminal', \{ path: dirAbsPath \}\)/,
        'shared action must invoke the custom rust command with the absolute dir path',
    )
    // 文件行入口：目录 → 它自身；文件 → 其父目录（parentOf 语义）
    assert.match(
        src,
        /openInTerminalAt\(root \? buildAbsolutePath\(root, parentOf\(entry\)\) : null\)/,
        'file row menu must open the containing dir via the shared action',
    )
    assert.match(
        src,
        /label: tr\('workspace\.menu\.openInTerminal'\),\s*\n\s*icon: CommandLineIcon,\s*\n\s*disabled: !root,\s*\n\s*action: openInTerminal,/,
        'row menu item must sit in the local-open group (same gating) and stay disabled without root',
    )
    // 面板空白处（Files tab）入口：终端开在 workspace 根，root 未加载时禁用
    const panelSrc = read('src/components/workspace/WorkspacePanel.vue')
    assert.match(
        panelSrc,
        /const rootDir = tree\.entriesAt\(''\)\?\.root \?\? null/,
        'panel blank menu must resolve the workspace root the same way as the file rows',
    )
    // 空白菜单与文件行同一 gating：remote/浏览器下 root 是远端机器路径，开本地终端无意义
    assert.match(
        panelSrc,
        /shouldShowLocalOpenItems\(isDesktopTauri, effectiveGatewayMode\(\)\)/,
        'panel blank menu must share the local-open gating (Tauri desktop + local gateway only)',
    )
    // gating 依赖的 import 存在性（防“清理未使用导入”删掉后测试仍绿而编译挂）
    assert.match(panelSrc, /import \{ isDesktopTauri \} from '\.\.\/\.\.\/utils\/environment'/, 'panel must import isDesktopTauri')
    assert.match(panelSrc, /from '\.\.\/\.\.\/composables\/local-server'/, 'panel must import effectiveGatewayMode from local-server')
    assert.match(
        panelSrc,
        /label: t\('workspace\.menu\.openInTerminal'\),\s*\n\s*icon: CommandLineIcon,\s*\n\s*disabled: !rootDir,\s*\n\s*action: \(\) => openInTerminalAt\(rootDir\),/,
        'panel blank menu must expose open-in-terminal at workspace root, disabled without root',
    )
})

test('useFileActions: 在终端中打开 —— Rust 命令存在且已注册，分平台启动器齐全', () => {
    const lib = read('src-tauri/src/lib.rs')
    assert.match(lib, /fn open_in_terminal\(path: String\) -> Result<\(\), String>/, 'command fn must exist')
    assert.match(lib, /open_in_terminal,/, 'command must be registered in invoke_handler')
    // Windows：wt 优先 + cmd start 回落；UNC 路径回落 PowerShell（cmd 不支持 UNC cwd）。
    // 注意 PowerShell 本体就是目标窗口，必须 CREATE_NEW_CONSOLE（CREATE_NO_WINDOW 会藏成静默无反应）。
    assert.match(lib, /Command::new\("wt"\)/, 'windows branch must prefer Windows Terminal')
    assert.match(lib, /args\(\["\/C", "start", "", "cmd"\]\)/, 'windows fallback must open a classic cmd window')
    assert.match(lib, /Command::new\("powershell"\)/, 'UNC fallback must use PowerShell')
    assert.match(lib, /Set-Location -LiteralPath/, 'UNC fallback must cd via -LiteralPath')
    assert.match(lib, /CREATE_NEW_CONSOLE/, 'UNC fallback must spawn a VISIBLE console')
    assert.match(lib, /args\(\["-a", "Terminal", path\]\)/, 'macos branch must open Terminal.app at the dir')
    assert.match(lib, /CANDIDATES: &\[\(&str, &\[&str\]\)\]/, 'linux branch must try a candidate list of terminals')
})

test('useFileActions: 在终端中打开 i18n 双侧补齐', () => {
    const en = read('src/i18n/en.ts')
    const zh = read('src/i18n/zh.ts')
    assert.match(en, /openInTerminal: 'Open in Terminal'/, 'en must define openInTerminal')
    assert.match(zh, /openInTerminal: '在终端中打开'/, 'zh must define openInTerminal')
})

test('capabilities: opener open-path 授权必须带 scope 条目（空 scope 运行时全拒）', () => {
    const cap = read('src-tauri/capabilities/default.json')
    // open_path 运行时经 tauri::fs::Scope（glob 匹配）检查：裸 allow-open-path 无 scope 条目
    // → allow 集合为空 → is_allowed 恒 false → ForbiddenPath，功能完全不可用。
    // 必须显式给 path 条目。范围只能放宽到 **：workspaceDir 由用户绑定（任意盘符/目录），
    // 静态窄范围会打断功能；本地模式下 bundled agent 本就全权执行命令，无边际风险。
    // revealItemInDir 无需单列：opener:default 已含 allow-reveal-item-in-dir，
    // 且该命令不做运行时 scope 检查。
    assert.match(
        cap,
        /"identifier": "opener:allow-open-path",\s*"allow": \[\s*\{\s*"path": "\*\*"\s*\}\s*\]/,
        'allow-open-path must carry a scope allow entry (path: **) or open_path is denied at runtime',
    )
    assert.match(cap, /"opener:default"/, 'existing opener:default must be kept (covers revealItemInDir)')
})
