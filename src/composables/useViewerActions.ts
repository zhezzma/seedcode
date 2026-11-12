/**
 * Workspace Viewer 顶栏「⋮ 更多」菜单工厂。
 *
 * 与 useFileActions.buildFileMenuItems（文件树右键）同构：返回 ContextMenuItem[]，
 * 由调用方交给单例 ContextMenu（useContextMenu.openAtElement）渲染，不自造菜单 UI。
 * 区别在于输入不是 TreeEntry，而是 viewer 当前 target + 编辑器实时内容 getter：
 *
 * - file / agent-file / absolute：复制路径（绝对，root 缺失退回相对）/ 复制内容
 *   （编辑器实时值，含未保存修改）/ 复制文件名 / 发送 @引用 / 发送内容 / 下载
 *   （absolute 无 download 端点 → 隐藏）/ 本地打开三件套（/assets URL 不是真实
 *   文件系统路径 → 隐藏）
 * - diff：复制路径 / 复制 diff（git 原生 unified，按需拉取）/ 复制内容（modified 侧
 *   实时值）；发送 @引用 与本地打开仅 unstaged/untracked（staged/commit 的右侧是
 *   index/commit 内容，不是工作区文件）；下载 .patch（可直接 git apply）
 * - text：仅复制内容（工具结果 / 代码块全屏预览此前零按钮）
 *
 * 发送类动作完成后经注入的 onClose 关 viewer 回聊天：onClose 是组件的 confirm-aware
 * close，dirty buffer 不会被静默丢弃。root 来源：agentsList 按 agentId 查
 * （useAppInit 启动即加载，比 tree 缓存 / git store 更可靠）。
 */
import { useChatInput } from './useChatInput'
import { useToast } from './useToast'
import { writeClipboard } from '../utils/clipboard'
import { fetchDownload } from './workspace-api'
import { saveBlob } from '../utils/fileDownload'
import type { ContextMenuItem } from './useContextMenu'
import { isTauri } from './notify-server-connection'
import { effectiveGatewayMode } from './local-server'
import { i18n } from '../i18n'
import {
    buildAbsolutePath, fenceContent, parentDir,
    runOpenerAction, shouldShowLocalOpenItems, openInTerminalAt,
} from './useFileActions'
import { repoJoin } from './useWorkspaceGit'
import type { ViewerTarget } from './useWorkspaceViewer'
import { useAgentsState } from './useAgentsState'
import {
    DocumentDuplicateIcon,
    ClipboardDocumentIcon,
    PaperAirplaneIcon,
    DocumentTextIcon,
    ArrowDownTrayIcon,
    ArrowTopRightOnSquareIcon,
    EyeIcon,
    CommandLineIcon,
} from '@heroicons/vue/24/outline'

/** 在不引入对 vue-i18n 的强耦合下取译文（同 useFileActions 的 tr）。 */
function tr(key: string): string {
    return (i18n.global as any).t(key)
}

/** 路径最后一段（文件名）；/ 与 \ 都处理（absolute scope 可能是 Windows 反斜杠路径）。 */
function basenameOf(p: string): string {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    return i === -1 ? p : p.slice(i + 1)
}

export interface ViewerMenuArgs {
    agentId: string
    target: ViewerTarget
    /** file/text 模式：编辑器实时内容（含未保存修改）；空串 = 不可复制（binary/媒体/loading）。 */
    fileContent: () => string
    /** diff 模式：modified 侧实时内容（onDidChangeContent 同步）。 */
    diffContent: () => string
    /** diff 模式：按需拉 git 原生 unified diff 文本（失败抛错，与编辑器行级 diff 无关）。 */
    getUnifiedDiff: () => Promise<string>
    /** 发送类动作完成后的关闭回调：组件注入 confirm-aware close（dirty 不静默丢弃）。 */
    onClose: () => Promise<void>
}

/** 下载文件（workspace/agent scope）：常驻 info toast 提示进行中（同 useFileActions.download）。 */
async function downloadFlow(agentId: string, path: string, scope: 'workspace' | 'agent', name: string) {
    const toast = useToast()
    const downloadingId = toast.info(tr('workspace.menu.downloading'), 0)
    try {
        const blob = await fetchDownload(agentId, path, scope)
        const savedPath = await saveBlob(blob, name)
        toast.remove(downloadingId)
        toast.success(`${tr('workspace.menu.downloaded')}: ${savedPath}`)
    } catch (e: any) {
        toast.remove(downloadingId)
        toast.error(`${tr('workspace.menu.download')}: ${e?.message || String(e)}`)
    }
}

export function buildViewerMenuItems(args: ViewerMenuArgs): ContextMenuItem[] {
    const { agentId, target, fileContent, diffContent, getUnifiedDiff, onClose } = args
    const toast = useToast()
    const agents = useAgentsState()
    const agent = agents.agentsList.find(a => a.id === agentId)

    const copyWith = async (text: string) => {
        await writeClipboard(text)
        toast.success(tr('workspace.menu.copied'))
    }

    // text 只读预览：无路径 / 无落盘语义，仅复制内容（补全屏预览零按钮的缺口）
    if (target.type === 'text') {
        return [{
            label: tr('workspace.menu.copyContent'),
            icon: ClipboardDocumentIcon,
            disabled: !fileContent(),
            action: () => copyWith(fileContent()),
        }]
    }

    // 本地打开三件套（门控与文件树右键一致：仅 Tauri 桌面 + local 网关）
    const showLocalOpen = shouldShowLocalOpenItems(isTauri, effectiveGatewayMode())
    const localOpenItems = (absPath: string): ContextMenuItem[] => [
        {
            label: tr('workspace.menu.openLocally'),
            icon: ArrowTopRightOnSquareIcon,
            separator: true,
            action: () => runOpenerAction('workspace.menu.openLocally', o => o.openPath(absPath)),
        },
        {
            label: tr('workspace.menu.revealInFileManager'),
            icon: EyeIcon,
            action: () => runOpenerAction('workspace.menu.revealInFileManager', o => o.revealItemInDir(absPath)),
        },
        {
            label: tr('workspace.menu.openInTerminal'),
            icon: CommandLineIcon,
            // 终端只能 cd 进目录：打开文件所在目录（parentDir 分隔符无关，
            // Windows 反斜杠绝对路径同样能取父目录）
            action: () => openInTerminalAt(parentDir(absPath)),
        },
    ]

    // 发送 @引用到聊天：追加绝对路径引用，回聊天继续输入 → 关 viewer
    const sendMentionItem = (absPath: string): ContextMenuItem => ({
        label: tr('workspace.menu.sendMention'),
        icon: PaperAirplaneIcon,
        separator: true,
        action: async () => {
            useChatInput().appendText(`@${absPath}`)
            toast.success(tr('workspace.menu.sentToChat'))
            await onClose()
        },
    })

    if (target.type === 'file' || target.type === 'agent-file' || target.type === 'absolute') {
        const scope: 'workspace' | 'agent' | 'absolute'
            = target.type === 'file' ? 'workspace' : target.type === 'agent-file' ? 'agent' : 'absolute'
        const root = scope === 'workspace' ? agent?.workspaceDir : scope === 'agent' ? agent?.agentDir : null
        // absolute 的 path 本身即绝对路径（或 /assets URL）；其余拼 root，
        // root 缺失退回相对路径（复制仍可用；本地打开不展示，同文件树 disabled:!root 语义）
        const absPath = scope === 'absolute' ? target.path : buildAbsolutePath(root ?? null, target.path)
        const name = basenameOf(target.path)
        // /assets URL 不是真实文件系统路径，openPath/reveal 必失败 → 整组隐藏
        const canLocalOpen = showLocalOpen && !target.path.startsWith('/assets') && (scope === 'absolute' || !!root)
        return [
            {
                label: tr('workspace.menu.copyPath'),
                icon: DocumentDuplicateIcon,
                action: () => copyWith(absPath),
            },
            {
                label: tr('workspace.menu.copyContent'),
                icon: ClipboardDocumentIcon,
                disabled: !fileContent(),
                action: () => copyWith(fileContent()),
            },
            {
                label: tr('workspace.menu.copyName'),
                icon: DocumentDuplicateIcon,
                action: () => copyWith(name),
            },
            sendMentionItem(absPath),
            {
                label: tr('workspace.menu.sendContent'),
                icon: DocumentTextIcon,
                disabled: !fileContent(),
                action: async () => {
                    useChatInput().appendText(fenceContent(target.path, fileContent()))
                    toast.success(tr('workspace.menu.sentToChat'))
                    await onClose()
                },
            },
            // 下载仅 workspace/agent scope：absolute 走 /api/files/open，无 download 端点
            ...(scope !== 'absolute' ? [{
                label: tr('workspace.menu.download'),
                icon: ArrowDownTrayIcon,
                separator: true,
                action: () => downloadFlow(agentId, target.path, scope as 'workspace' | 'agent', name),
            }] as ContextMenuItem[] : []),
            ...(canLocalOpen ? localOpenItems(absPath) : []),
        ]
    }

    // ── diff 模式：file 是 repo 相对路径；右侧是否工作区文件决定发送/本地打开门控 ──
    const wsPath = repoJoin(target.repo, target.file)
    const absPath = buildAbsolutePath(agent?.workspaceDir ?? null, wsPath)
    // 仅 unstaged/untracked 的右侧是工作区文件；staged/commit 分别是 index/commit 内容
    const inWorktree = target.mode === 'unstaged' || target.mode === 'untracked'
    const canLocalOpen = showLocalOpen && inWorktree && !!agent?.workspaceDir
    return [
        {
            label: tr('workspace.menu.copyPath'),
            icon: DocumentDuplicateIcon,
            action: () => copyWith(absPath),
        },
        {
            label: tr('workspace.menu.copyDiff'),
            icon: ClipboardDocumentIcon,
            action: async () => {
                try {
                    const text = await getUnifiedDiff()
                    if (!text) return
                    await copyWith(text)
                } catch {
                    // 拉取走网络，失败可感知（与纯剪贴板动作不同）
                    toast.error(tr('common.networkError'))
                }
            },
        },
        {
            label: tr('workspace.menu.copyContent'),
            icon: DocumentTextIcon,
            disabled: !diffContent(),
            action: () => copyWith(diffContent()),
        },
        ...(inWorktree ? [sendMentionItem(absPath)] : []),
        {
            label: tr('workspace.menu.downloadPatch'),
            icon: ArrowDownTrayIcon,
            separator: true,
            action: async () => {
                try {
                    const text = await getUnifiedDiff()
                    if (!text) return
                    const blob = new Blob([text], { type: 'text/plain' })
                    const savedPath = await saveBlob(blob, `${basenameOf(target.file)}.patch`)
                    toast.success(`${tr('workspace.menu.downloaded')}: ${savedPath}`)
                } catch {
                    toast.error(tr('common.networkError'))
                }
            },
        },
        ...(canLocalOpen ? localOpenItems(absPath) : []),
    ]
}
