/**
 * Workspace 文件 / 目录的右键菜单 action 工厂。
 *
 * 两类 action：
 * - 零后端：复制（绝对 / 相对 / 文件名）、发送（绝对路径 @引用 / 文件内容）
 * - mutation：下载、重命名、新建文件 / 新建目录、删除（删除走 useConfirm 确认）
 * 目录上自动禁用发送 @引用 / 发送内容 / 下载三项，对单文件才有意义。
 */
import { useChatInput } from './useChatInput'
import { useToast } from './useToast'
import { useConfirm } from './useConfirm'
import { writeClipboard } from '../utils/clipboard'
import {
    fetchFile, fetchAgentFile, fetchDownload,
    createFile, createDir, deleteFile, deleteDir,
    createAgentFile, createAgentDir, deleteAgentFile, deleteAgentDir,
    renameEntry, renameAgentEntry,
    uploadFile,
    type TreeEntry,
} from './workspace-api'
import { saveBlob } from '../utils/fileDownload'
import type { ContextMenuItem } from './useContextMenu'
import { isTauri } from './notify-server-connection'
import { effectiveGatewayMode } from './local-server'
import { i18n } from '../i18n'
import {
    DocumentDuplicateIcon,
    PaperAirplaneIcon,
    DocumentTextIcon,
    ArrowDownTrayIcon,
    PencilSquareIcon,
    DocumentPlusIcon,
    FolderPlusIcon,
    ArrowUpOnSquareIcon,
    TrashIcon,
    ArrowPathIcon,
    ArrowTopRightOnSquareIcon,
    EyeIcon,
    CommandLineIcon,
} from '@heroicons/vue/24/outline'
import { useWorkspaceRefresh } from './useWorkspaceRefresh'

export type FileScope = 'workspace' | 'agent'

interface BuildArgs {
    agentId: string
    entry: TreeEntry
    scope: FileScope
    /**
     * 当前 scope 根目录的绝对路径（workspaceDir 或 agentDir）。
     * 由调用者从自己的 useWorkspaceTree / useAgentFiles 拿后传入，
     * 避免 useFileActions 跨模块 import composable 变成独立 singleton 实例。
     */
    root: string | null
    /**
     * mutation 后的刷新 callback，传入受影响的父目录路径（相对 root，根是 ""）。
     * 调用者负责 invalidate + loadPath；同样为了避免 HMR singleton 分裂，
     * useFileActions 不跨模块 import tree composable。
     */
    onMutated?: (parentPath: string) => void | Promise<void>
    /**
     * 删除完成后的额外回调，传入被删路径。TreeNode 负责检查
     * viewer.current?.path === deletedPath 则关闭 viewer（避免查看已不存在的文件）。
     */
    onDeleted?: (deletedPath: string) => void | Promise<void>
}

/** 在不引入对 vue-i18n 的强耦合下取译文；i18n.global 由 main 初始化。 */
function tr(key: string): string {
    return (i18n.global as any).t(key)
}

/** 拼出 entry 的绝对路径：root + entry.path。OS-native 分隔符以便于粘贴给本地工具。
 *  root 从调用者透入（TreeNode 可以直接拿到），避免跨模块 import composable。 */
export function buildAbsolutePath(root: string | null, relPath: string): string {
    if (!root) return relPath
    // 服务端返回的 root 使用 Node 的 path.join：Windows 上是反斜杠，POSIX 上是正斜杠。
    // entry.path 服务端统一返回正斜杠；Windows 下走 backslash 路径拼接以避免混合分隔符。
    if (root.includes('\\')) {
        return root + '\\' + relPath.replace(/\//g, '\\')
    }
    return root + '/' + relPath
}

/** 把文件内容包成 fenced code block。
 *  关键：扫一遭 content 中最长连续反引号，外层用 N+1 个（至少 3），否则 README
 *  / SKILL.md 里本身的 ``` 会提前关闭外层、让 chat 渲染乱。CommonMark 允许任意 ≥3 个。 */
function fenceContent(path: string, content: string): string {
    const longest = (content.match(/`+/g) || []).reduce((m, s) => Math.max(m, s.length), 0)
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return `\n${fence}${guessLang(path)} title="${path}"\n${content}\n${fence}\n`
}

/** 简易扩展名 → 高亮语言；不命中默认空（fence 仍合法）。 */
function guessLang(path: string): string {
    const ext = path.includes('.') ? (path.split('.').pop() || '').toLowerCase() : ''
    const map: Record<string, string> = {
        ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', vue: 'vue',
        py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
        rb: 'ruby', php: 'php', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c',
        css: 'css', html: 'html', json: 'json', yaml: 'yaml', yml: 'yaml',
        md: 'markdown', sh: 'bash', sql: 'sql',
    }
    return map[ext] ?? ''
}

/** entry.path 的父目录（去掉最后一段）；根是 ""。与 parentOf 区别：这个始终去掉一段，
 *  用于删除场景——被删者本身不再存在，只能刷新它的原父。 */
function parentDir(p: string): string {
    const i = p.lastIndexOf('/')
    return i === -1 ? '' : p.slice(0, i)
}

/** 「在这里创建子项」语义：dir 点击 → 子项放在它里；file 点击 → 子项放在它同级。
 *  不能用于删除后的刷新（删除 dir 后这个 path 已失效）。 */
function parentOf(entry: TreeEntry): string {
    if (entry.type === 'dir') return entry.path
    return parentDir(entry.path)
}

function joinChild(parent: string, child: string): string {
    return parent ? `${parent}/${child}` : child
}

export interface RootMutationArgs {
    agentId: string
    scope: FileScope
    /** 该能为""（根）或任意已存在目录的相对路径。 */
    parentPath: string
    onMutated?: (parentPath: string) => void | Promise<void>
}

/**
 * 在 parentPath 下 prompt 创建新文件。菜单 entry-context 与根目录 toolbar 共用这个入口。
 */
export async function runNewFileFlow(args: RootMutationArgs): Promise<void> {
    const { agentId, scope, parentPath, onMutated } = args
    const toast = useToast()
    const raw = window.prompt(tr('workspace.menu.newFilePrompt'))
    if (raw === null) return
    const name = validateChildName(raw)
    if (!name) {
        toast.error(tr('workspace.menu.invalidName'))
        return
    }
    const childPath = joinChild(parentPath, name)
    const create = scope === 'agent' ? createAgentFile : createFile
    try {
        await create(agentId, childPath)
        if (onMutated) await onMutated(parentPath)
        toast.success(tr('workspace.menu.created'))
    } catch (e: any) {
        toast.error(`${tr('workspace.menu.newFile')}: ${e?.message || String(e)}`)
    }
}

export async function runNewDirFlow(args: RootMutationArgs): Promise<void> {
    const { agentId, scope, parentPath, onMutated } = args
    const toast = useToast()
    const raw = window.prompt(tr('workspace.menu.newDirPrompt'))
    if (raw === null) return
    const name = validateChildName(raw)
    if (!name) {
        toast.error(tr('workspace.menu.invalidName'))
        return
    }
    const childPath = joinChild(parentPath, name)
    const mkdir = scope === 'agent' ? createAgentDir : createDir
    try {
        await mkdir(agentId, childPath)
        if (onMutated) await onMutated(parentPath)
        toast.success(tr('workspace.menu.created'))
    } catch (e: any) {
        toast.error(`${tr('workspace.menu.newDir')}: ${e?.message || String(e)}`)
    }
}

/** 共享的隐藏 file input：避免每次上传都新建/移除 DOM 节点。
 *  只挂一份到 document.body，change 处理器按次绑定并解绑。 */
let sharedInput: HTMLInputElement | null = null
function getUploadInput(): HTMLInputElement {
    if (sharedInput) return sharedInput
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    // 不设 accept：动作语义是「上传文件」，不限图片——图片只是常见子集。
    input.style.display = 'none'
    document.body.appendChild(input)
    sharedInput = input
    return input
}

/**
 * 在 parentPath 下上传文件。仅 workspace scope：服务端只提供 /workspace/upload。
 * agent scope 调用方负责不触发（菜单项对 agent scope 不展示）。
 *
 * 多文件逐个上传：单文件失败不中断其余，失败计数在末尾汇总 toast；全部成功才刷新一次父目录。
 */
export async function runUploadFlow(args: RootMutationArgs): Promise<void> {
    const { agentId, scope, parentPath, onMutated } = args
    const toast = useToast()
    if (scope !== 'workspace') {
        toast.warning(tr('workspace.menu.upload'))
        return
    }
    const input = getUploadInput()
    // 重置 value：否则选同一文件第二次不会触发 change。
    input.value = ''
    const files = await new Promise<File[] | null>(resolve => {
        const onChange = () => {
            input.removeEventListener('change', onChange)
            resolve(input.files ? Array.from(input.files) : null)
        }
        input.addEventListener('change', onChange)
        input.click()
    })
    if (!files || files.length === 0) return

    let ok = 0
    let failed = 0
    for (const file of files) {
        try {
            await uploadFile(agentId, parentPath, file)
            ok++
        } catch {
            failed++
        }
    }
    if (ok > 0 && onMutated) await onMutated(parentPath)
    if (failed === 0) {
        toast.success(ok > 1
            ? tr('workspace.menu.uploadedMany').replace('{count}', String(ok))
            : tr('workspace.menu.uploaded'))
    } else if (ok === 0) {
        toast.error(tr('workspace.menu.uploadFailed'))
    } else {
        toast.warning(tr('workspace.menu.uploadPartial')
            .replace('{ok}', String(ok))
            .replace('{failed}', String(failed)))
    }
}

/** 检验 prompt() 收到的名字：不能是绝对路径、不能含 .. / 。返回规范后的 POSIX-style
 *  路径段（可能含中间 /，让用户能一口气输 sub/foo.md）；非法返回 null。
 *  调用者需区分 prompt 取消（原始 null）与非法输入（本函数返回 null）两种状态。 */
function validateChildName(raw: string | null): string | null {
    if (raw === null) return null
    const trimmed = raw.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null
    // Windows 盘符绝对路径：C:\foo / D:/bar 也要拦。后端有 canonicalization 兑底，
    // 这里拍是为了让“不能是绝对路径”语义与 Windows 用户直觉一致。
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return null
    const normalized = trimmed.replace(/\\/g, '/')
    if (normalized.split('/').some(seg => seg === '..' || seg === '.' || seg === '')) return null
    return normalized
}

/** 本地打开菜单项的展示条件：仅 Tauri 桌面 + 本地服务器模式（gatewayMode=local）。
 *  此时 workspace / agent 目录就在本机，可用系统程序直接打开；
 *  remote 模式 / 浏览器直连 / Android（bundled=false 强制 remote）路径不在本机，不展示。
 *  纯函数：isTauri 环境探测与网关模式由调用方传入，便于测试。 */
export function shouldShowLocalOpenItems(isTauriEnv: boolean, mode: 'local' | 'remote'): boolean {
    return isTauriEnv && mode === 'local'
}

/** 在系统终端中打开指定目录（绝对路径）。文件行菜单（所在目录）与面板空白菜单（workspace 根）共用。
 *  终端启动器随平台各异（wt/cmd、Terminal.app、gnome-terminal/konsole/…），
 *  opener 插件没有该能力，走自家 Rust 命令 open_in_terminal（见 src-tauri/src/lib.rs）。
 *  null/空路径视为不可用（root 未加载），静默 return——上游菜单项 disabled 已拦，这里双保险。 */
export async function openInTerminalAt(dirAbsPath: string | null): Promise<void> {
    const toast = useToast()
    if (!dirAbsPath) return
    try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('open_in_terminal', { path: dirAbsPath })
    } catch (e: any) {
        toast.error(`${tr('workspace.menu.openInTerminal')}: ${e?.message || String(e)}`)
    }
}

export function buildFileMenuItems(args: BuildArgs): ContextMenuItem[] {
    const { entry, scope, agentId, root, onMutated, onDeleted } = args
    const isFile = entry.type === 'file'
    const isDir = entry.type === 'dir'
    const toast = useToast()
    const { confirm } = useConfirm()

    /** mutation 完成后的刷新动作：调用者负责 invalidate + loadPath。 */
    const mutate = async (parent: string) => {
        if (onMutated) await onMutated(parent)
    }

    const rmFile = scope === 'agent' ? deleteAgentFile : deleteFile
    const rmDir = scope === 'agent' ? deleteAgentDir : deleteDir
    const rename = scope === 'agent' ? renameAgentEntry : renameEntry

    // ── 本地打开（Tauri 桌面 + local 网关）：文件就在本机，交给系统程序打开 ──
    const showLocalOpen = shouldShowLocalOpenItems(isTauri, effectiveGatewayMode())
    const absPath = buildAbsolutePath(root, entry.path)

    /** opener 动作统一入口：动态加载插件（与 local-server.ts 同模式，非 Tauri 不加载）
     *  + 失败 toast（带动作名前缀）。 */
    const runOpener = async (
        labelKey: string,
        run: (opener: typeof import('@tauri-apps/plugin-opener')) => Promise<void>,
    ) => {
        try {
            const opener = await import('@tauri-apps/plugin-opener')
            await run(opener)
        } catch (e: any) {
            toast.error(`${tr(labelKey)}: ${e?.message || String(e)}`)
        }
    }

    /** 目录 → 系统文件管理器；文件 → 系统默认关联程序。 */
    const openWithLocalApp = () => runOpener('workspace.menu.openLocally', o => o.openPath(absPath))

    /** 打开所在目录并选中该项（文件 / 目录皆可）。 */
    const revealInFileManager = () => runOpener('workspace.menu.revealInFileManager', o => o.revealItemInDir(absPath))

    /** 文件行入口：目录 → 它自身；文件 → 其父目录（终端只能 cd 进目录）。 */
    const openInTerminal = () => openInTerminalAt(root ? buildAbsolutePath(root, parentOf(entry)) : null)

    return [
        // 本地打开两项置于顶部（最高频动作）；root 拿不到时禁用（无法拼绝对路径）。
        ...(showLocalOpen ? [{
            label: tr('workspace.menu.openLocally'),
            icon: ArrowTopRightOnSquareIcon,
            disabled: !root,
            action: openWithLocalApp,
        }, {
            label: tr('workspace.menu.revealInFileManager'),
            icon: EyeIcon,
            disabled: !root,
            action: revealInFileManager,
        }, {
            label: tr('workspace.menu.openInTerminal'),
            icon: CommandLineIcon,
            disabled: !root,
            action: openInTerminal,
        }] as ContextMenuItem[] : []),
        {
            label: tr('workspace.menu.copyAbsolutePath'),
            icon: DocumentDuplicateIcon,
            separator: showLocalOpen,
            action: async () => {
                await writeClipboard(buildAbsolutePath(root, entry.path))
                toast.success(tr('workspace.menu.copied'))
            },
        },
        {
            label: tr('workspace.menu.copyRelativePath'),
            icon: DocumentDuplicateIcon,
            action: async () => {
                await writeClipboard(entry.path)
                toast.success(tr('workspace.menu.copied'))
            },
        },
        {
            label: tr('workspace.menu.copyName'),
            icon: DocumentDuplicateIcon,
            action: async () => {
                await writeClipboard(entry.name)
                toast.success(tr('workspace.menu.copied'))
            },
        },
        {
            label: tr('workspace.menu.sendMention'),
            icon: PaperAirplaneIcon,
            separator: true,
            disabled: !isFile,
            action: () => {
                // 发绝对路径的 @引用：root + entry.path，跨平台拼接。
                useChatInput().appendText(`@${buildAbsolutePath(root, entry.path)}`)
                toast.success(tr('workspace.menu.sentToChat'))
            },
        },
        {
            label: tr('workspace.menu.sendContent'),
            icon: DocumentTextIcon,
            disabled: !isFile,
            action: async () => {
                try {
                    const data = scope === 'agent'
                        ? await fetchAgentFile(agentId, entry.path)
                        : await fetchFile(agentId, entry.path)
                    if (data.binary) {
                        toast.warning(tr('workspace.binaryFile'))
                        return
                    }
                    useChatInput().appendText(fenceContent(entry.path, data.content))
                    if (data.truncated) {
                        toast.warning(tr('workspace.menu.contentTruncated'))
                    } else {
                        toast.success(tr('workspace.menu.sentToChat'))
                    }
                } catch (e: any) {
                    // 封上动作语义：裸 "Network Error" 用户不知道是哪步失败
                    toast.error(`${tr('workspace.menu.sendContent')}: ${e?.message || String(e)}`)
                }
            },
        },
        {
            label: tr('workspace.menu.download'),
            icon: ArrowDownTrayIcon,
            disabled: !isFile,
            action: async () => {
                try {
                    const blob = await fetchDownload(agentId, entry.path, scope)
                    const savedPath = await saveBlob(blob, entry.name)
                    toast.success(`${tr('workspace.menu.downloaded')}: ${savedPath}`)
                } catch (e: any) {
                    toast.error(`${tr('workspace.menu.download')}: ${e?.message || String(e)}`)
                }
            },
        },
        // ── mutation：新建文件 / 新建目录（仅 dir entry） + 删除（所有 entry） ──
        {
            label: tr('workspace.menu.newFile'),
            icon: DocumentPlusIcon,
            separator: true,
            disabled: !isDir,
            action: () => runNewFileFlow({
                agentId, scope,
                parentPath: parentOf(entry),
                onMutated,
            }),
        },
        {
            label: tr('workspace.menu.newDir'),
            icon: FolderPlusIcon,
            disabled: !isDir,
            action: () => runNewDirFlow({
                agentId, scope,
                parentPath: parentOf(entry),
                onMutated,
            }),
        },
        // upload 仅 workspace scope：服务端只提供 /workspace/upload。agent 配置
        // 目录无对应端点——菜单项干脆不展示，而非让用户点到一个弹无意义 warning 的项。
        ...(scope === 'workspace' ? [{
            label: tr('workspace.menu.upload'),
            icon: ArrowUpOnSquareIcon,
            disabled: !isDir,
            action: () => runUploadFlow({
                agentId, scope,
                parentPath: parentOf(entry),
                onMutated,
            }),
        }] as ContextMenuItem[] : []),
        {
            label: tr('workspace.menu.rename'),
            icon: PencilSquareIcon,
            separator: true,
            action: async () => {
                const raw = window.prompt(tr('workspace.menu.renamePrompt'), entry.name)
                if (raw === null) return
                const name = raw.trim()
                // 纯改名：不允许路径分隔符与 . / ..（后端也拦，这里给即时反馈）。
                if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
                    toast.error(tr('workspace.menu.invalidRename'))
                    return
                }
                if (name === entry.name) return
                try {
                    await rename(agentId, entry.path, name)
                    // 重命名后旧路径失效，与删除同理：刷新原父目录 + 关闭旧 viewer。
                    await mutate(parentDir(entry.path))
                    if (onDeleted) await onDeleted(entry.path)
                    toast.success(tr('workspace.menu.renamed'))
                } catch (e: any) {
                    toast.error(`${tr('workspace.menu.rename')}: ${e?.message || String(e)}`)
                }
            },
        },
        {
            label: tr('workspace.menu.delete'),
            icon: TrashIcon,
            separator: true,
            danger: true,
            action: async () => {
                const msg = isDir
                    ? tr('workspace.menu.deleteDirConfirm')
                    : tr('workspace.menu.deleteFileConfirm')
                const ok = await confirm(`${msg}\n\n${entry.path}`, tr('workspace.menu.delete'))
                if (!ok) return
                try {
                    if (isDir) await rmDir(agentId, entry.path)
                    else await rmFile(agentId, entry.path)
                    // 关键：删除后需刷新被删者的**原父**，不是 parentOf(entry)。
                    // 对 dir 来说 parentOf 返回它自己（「在这里建子项」语义），但这个路径已不存在。
                    await mutate(parentDir(entry.path))
                    if (onDeleted) await onDeleted(entry.path)
                    toast.success(tr('workspace.menu.deleted'))
                } catch (e: any) {
                    toast.error(`${tr('workspace.menu.delete')}: ${e?.message || String(e)}`)
                }
            },
        },
        // 全量刷新：与面板右键菜单/Files 空白左键同一套 refreshAll
        {
            label: tr('common.refresh'),
            icon: ArrowPathIcon,
            separator: true,
            action: () => { void useWorkspaceRefresh().refreshAll(agentId) },
        },
    ]
}
