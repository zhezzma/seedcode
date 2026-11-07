/**
 * Workspace Viewer 模式状态：决定聊天区是显示聊天还是显示 file/diff。
 *
 * 通过 useWorkspaceViewer().openFile() / openDiff() 进入；close() 退出。
 *
 * 路径语义：openFile(path) 传的是**相对于当前 agent workspace** 的路径；agentId 从
 * WorkspaceViewer 组件 props 接入，不编码进 target。
 */
import { computed, ref } from 'vue'
import { isBinaryExt, type DiffMode } from './workspace-api.ts'

export type ViewerTarget =
    | { type: 'file'; path: string }
    | { type: 'agent-file'; path: string }
    | { type: 'absolute'; path: string }
    | { type: 'text'; content: string; title?: string; language?: string }
    | { type: 'diff'; repo: string; mode: DiffMode; file: string; ref?: string }

const current = ref<ViewerTarget | null>(null)

/**
 * 全局 dirty 状态：WorkspaceFileView 在自己内容与 baseline 不一致时写入路径，清净时写 null。
 * 供跨组件（如 HomeView session 切换）检查有无未保存改动 + 提示丢弃。
 * 取 ref（而非仅依赖 fileView ref 链）是为了跨路由/跨 view 都能读到。
 */
const dirty = ref<{ path: string } | null>(null)

const _viewerState = {
    current,
    isActive: computed(() => current.value !== null),
    dirty,
    openFile(path: string) {
        current.value = { type: 'file', path }
    },
    /** 打开 agent 配置目录下的文件（agent-tree 点击）。 */
    openAgentFile(path: string) {
        current.value = { type: 'agent-file', path }
    },
    /** 打开任意绝对路径文件（工具调用返回的真实文件系统路径，或 /assets/ 开头的
     *  公开静态端点 URL）。与 openFile 的 workspace 相对路径不同：文本文件走
     *  /api/files/open（无 resolveSafe 越界保护），图片由 fetchRawFile 按前缀分流。 */
    openAbsolute(path: string) {
        current.value = { type: 'absolute', path }
    },
    /** 打开纯文本预览（工具结果 / 代码块全屏），只读展示，不落盘。
     *  language 可选：代码块全屏时传 markdown fence 的语言标签，让 monaco 按语言高亮
     *  （工具结果预览通常不传，回退到内容猜）。 */
    openText(content: string, title?: string, language?: string) {
        current.value = language !== undefined
            ? { type: 'text', content, title, language }
            : { type: 'text', content, title }
    },
    /** 打开 git diff 视图。所有 diff 入口（交付物面板 / git 面板 / 工具卡路径 /
     *  批量动作重开）都经此分流：
     *  二进制文件（按扩展名，isBinaryExt）统一改开文件预览——git 对二进制的 diff
     *  只有「binary files differ」占位，无信息量；openFile 里媒体走原生
     *  <img>/<audio>/<video>，其余二进制走 fetchFile 的 binary banner（与树上
     *  直接点开同一体验）。deleted 例外：文件已不在盘上，预览必 404，维持 diff
     *  至少可见删除事实（调用方知情时传入）。
     *  已知限制：mode=commit 预览的是当前工作区版本而非该提交版本（与
     *  openAbsolute 看盘上文件同语义）；文件已被后续提交删除时会 404 红字
     *  可感知——为保持「二进制一律不走 diff」的统一规则不做特判，需要精确
     *  历史版本时远期走 raw-at-ref 端点。 */
    openDiff(args: { repo: string; mode: DiffMode; file: string; ref?: string; deleted?: boolean }) {
        if (!args.deleted && isBinaryExt(args.file)) {
            // 根仓库（"."）不产生 "./" 前缀（repoJoin 同语义）
            this.openFile(args.repo === '.' ? args.file : `${args.repo}/${args.file}`)
            return
        }
        current.value = { type: 'diff', repo: args.repo, mode: args.mode, file: args.file, ref: args.ref }
    },
    /** WorkspaceFileView 专用：跟随自身 isDirty + path 同步。 */
    setDirty(path: string | null) {
        dirty.value = path ? { path } : null
    },
    close() {
        // 关闭仅清状态，不刷 git status：单纯查看（含 diff / agent-file）不会改磁盘，
        // 重拉是纯浪费。真正会改磁盘的入口（WorkspaceFileView.save）自己负责通知 git store。
        current.value = null
        dirty.value = null
    },
}

export const useWorkspaceViewer = () => _viewerState
