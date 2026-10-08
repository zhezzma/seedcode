/**
 * Workspace 面板专用的强类型 API wrapper。
 *
 * 后端契约见：docs/superpowers/specs/2026-05-17-workspace-panel-design.md
 *
 * 设计考量：
 * - 不复用 ./api-client 是为了让 node:test 跳过测试时不依赖上游的 toast/store 链，
 *   也避免 workspace 面板的错误会被默认 toast 提醒污染。错误让上层 composable 自己
 *   决定如何呈现（内联在 panel 区域中）。
 */
import { useUiSettingsStore } from '../stores/setting.ts'

class WorkspaceApiError extends Error {
    code: number
    constructor(message: string, code: number) {
        super(message)
        this.name = 'WorkspaceApiError'
        this.code = code
    }
}

function baseUrl(): string {
    const settings = useUiSettingsStore()
    const url = settings.apiBaseUrl?.trim() || ''
    return url.replace(/\/+$/, '')
}

function authHeaders(): Record<string, string> {
    const settings = useUiSettingsStore()
    const headers: Record<string, string> = {}
    if (settings.token?.trim()) {
        headers['Authorization'] = `Bearer ${settings.token.trim()}`
    }
    return headers
}

async function wsGet<T>(path: string): Promise<T> {
    const url = `${baseUrl()}${path}`
    const response = await fetch(url, { method: 'GET', headers: authHeaders() })
    return await readResponse<T>(response)
}

async function wsPut<T>(path: string, body: unknown): Promise<T> {
    const url = `${baseUrl()}${path}`
    const response = await fetch(url, {
        method: 'PUT',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    return await readResponse<T>(response)
}

async function wsPost<T>(path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl()}${path}`
    const init: RequestInit = { method: 'POST', headers: { ...authHeaders() } }
    if (body !== undefined) {
        init.headers = { ...init.headers, 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
    }
    const response = await fetch(url, init)
    return await readResponse<T>(response)
}

async function wsDelete<T>(path: string): Promise<T> {
    const url = `${baseUrl()}${path}`
    const response = await fetch(url, { method: 'DELETE', headers: authHeaders() })
    return await readResponse<T>(response)
}

async function readResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
        let msg = `HTTP ${response.status}`
        try {
            const body = await response.json()
            if (body?.error) msg = body.error
        } catch { /* ignore */ }
        throw new WorkspaceApiError(msg, response.status)
    }
    const body = await response.json()
    if (body.ok === false) {
        throw new WorkspaceApiError(body.error || 'Unknown error', body.code || 500)
    }
    return body.payload as T
}

export type EntryType = 'dir' | 'file' | 'symlink'

export interface TreeEntry {
    name: string
    path: string
    type: EntryType
    size: number
    mtimeMs: number
    isGitRepo?: boolean
}

export interface TreeResult {
    root: string
    path: string
    entries: TreeEntry[]
    truncated?: true
}

export interface RepoSummary {
    name: string
    path: string
    branch: string | null
    head: string | null
    dirty: number
    ahead: number
    behind: number
    error?: string
}

export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '?'

export interface FileChange {
    path: string
    status: FileStatus
    oldPath?: string
}

export interface RepoStatus {
    branch: string | null
    upstream: string | null
    head: string | null
    ahead: number
    behind: number
    staged: FileChange[]
    unstaged: FileChange[]
    untracked: FileChange[]
}

export interface CommitMeta {
    sha: string
    shortSha: string
    author: string
    authorDate: string
    subject: string
    /** 提交正文（不含标题）；单行提交时为空。 */
    body?: string
}

export type DiffMode = 'unstaged' | 'staged' | 'commit' | 'untracked'

export interface DiffResult {
    mode: DiffMode
    file: string
    binary: boolean
    truncated: boolean
    diff: string
}

export interface CommitFile {
    path: string
    status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T'
    oldPath?: string
}

export interface FileContent {
    path: string
    binary: boolean
    truncated: boolean
    content: string
}

export interface FileVersions {
    mode: DiffMode
    file: string
    binary: boolean
    truncated: boolean
    /** before/after 为 null 表示该侧不存在（新增/删除）。binary=true 时两侧均为 null。 */
    before: string | null
    after: string | null
}

const base = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/workspace`

export function fetchTree(agentId: string, path: string): Promise<TreeResult> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : ''
    return wsGet<TreeResult>(`${base(agentId)}/tree${qs}`)
}

export function fetchRepos(
    agentId: string,
    opts?: { refresh?: boolean },
): Promise<{ repos: RepoSummary[] }> {
    // refresh=1：服务端先对各仓 git fetch 刷 upstream 再返回（走网络）。仅 git 面板
    // 挂载/手动刷新传；工具卡点击链路只用它做仓库发现，保持纯本地不碰网络。
    const qs = opts?.refresh ? "?refresh=1" : ""
    return wsGet(`${base(agentId)}/repos${qs}`)
}

export function fetchStatus(
    agentId: string,
    repo: string,
    opts?: { refresh?: boolean },
): Promise<RepoStatus> {
    const params = new URLSearchParams({ repo })
    // refresh=1：服务端先 git fetch 刷 upstream 再返回（走网络）。仅手动刷新时传，
    // 否则 ↓behind 永远基于上次 fetch 的本地 remote-tracking ref，恒为旧值。
    if (opts?.refresh) params.set('refresh', '1')
    return wsGet(`${base(agentId)}/repo/status?${params.toString()}`)
}

export function fetchLog(
    agentId: string,
    repo: string,
    opts?: { limit?: number; skip?: number },
): Promise<{ commits: CommitMeta[] }> {
    const params = new URLSearchParams({ repo })
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts?.skip !== undefined) params.set('skip', String(opts.skip))
    return wsGet(`${base(agentId)}/repo/log?${params.toString()}`)
}

export interface DiffArgs {
    repo: string
    mode: DiffMode
    file: string
    ref?: string
}

export function fetchDiff(agentId: string, args: DiffArgs): Promise<DiffResult> {
    const params = new URLSearchParams({
        repo: args.repo,
        mode: args.mode,
        file: args.file,
    })
    if (args.ref) params.set('ref', args.ref)
    return wsGet(`${base(agentId)}/repo/diff?${params.toString()}`)
}

export function fetchCommitFiles(
    agentId: string,
    repo: string,
    ref: string,
): Promise<{ ref: string; files: CommitFile[] }> {
    return wsGet(`${base(agentId)}/repo/commit/files?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`)
}

/** 读取单个文件内容（agent-scoped，resolveSafe 保护）。 */
export function fetchFile(agentId: string, path: string): Promise<FileContent> {
    return wsGet<FileContent>(`${base(agentId)}/file?path=${encodeURIComponent(path)}`)
}

/** 拉取文件的原始字节（仅服务端白名单内的图片扩展名）。scope 决定端点：
 *  workspace → /raw，agent → /agent-raw（后端带 workspace/sessions 顶层过滤），
 *  absolute → 真实绝对路径走 /api/files/raw，/assets/ 前缀直连公开静态端点（见内部分支注释）。
 *  与 fetchDownload 同样的 scope 复用模式。返回 Blob，调用方负责转为 object URL
 *  并在不用时 revokeObjectURL。 */
export async function fetchRawFile(
    agentId: string,
    path: string,
    scope: 'workspace' | 'agent' | 'absolute' = 'workspace',
): Promise<Blob> {
    // absolute scope：任意绝对路径，走 /api/files/raw（与 workspace/agent 的 raw 端点不同）。
    // 例外：/assets/ 前缀不是文件系统路径，而是服务端公开静态端点的 URL（image-gen 等
    // 工具结果返回的 session 图片地址）；/api/files/raw 只认真实文件系统绝对路径
    // （existsSync 直接查盘），故直接请求公开端点，无需 auth（与 Markdown 图片的
    // resolveMediaUrl 拼 origin 策略一致）。前提：path 是调用方已提取的纯路径，
    // 不做二次编码——与 resolveMediaUrl 同策略。
    if (scope === 'absolute') {
        const isAssetUrl = path.startsWith('/assets/')
        const url = isAssetUrl
            ? `${baseUrl()}${path}`
            : `${baseUrl()}/api/files/raw?path=${encodeURIComponent(path)}`
        const response = await fetch(url, {
            method: 'GET',
            headers: isAssetUrl ? undefined : authHeaders(),
        })
        if (!response.ok) {
            let msg = `HTTP ${response.status}`
            try {
                const body = await response.json()
                if (body?.error) msg = body.error
            } catch { /* 二进制响应不是 JSON，忽略 */ }
            throw new WorkspaceApiError(msg, response.status)
        }
        return await response.blob()
    }
    const endpoint = scope === 'agent' ? 'agent-raw' : 'raw'
    const url = `${baseUrl()}${base(agentId)}/${endpoint}?path=${encodeURIComponent(path)}`
    const response = await fetch(url, { method: 'GET', headers: authHeaders() })
    if (!response.ok) {
        let msg = `HTTP ${response.status}`
        try {
            const body = await response.json()
            if (body?.error) msg = body.error
        } catch { /* 二进制响应不是 JSON，忽略 */ }
        throw new WorkspaceApiError(msg, response.status)
    }
    return await response.blob()
}

/** 下载任意文件的原始字节（attachment）。scope 决定走 workspace 还是 agent 配置目录。
 *  与 fetchRawFile 不同：不限扩展名、不设 5MB 上限，后端走流式返回。
 *  返回 Blob，调用方负责落盘 / 触发浏览器下载。 */
export async function fetchDownload(
    agentId: string,
    path: string,
    scope: 'workspace' | 'agent' = 'workspace',
): Promise<Blob> {
    const endpoint = scope === 'agent' ? 'agent-download' : 'download'
    const url = `${baseUrl()}${base(agentId)}/${endpoint}?path=${encodeURIComponent(path)}`
    const response = await fetch(url, { method: 'GET', headers: authHeaders() })
    if (!response.ok) {
        let msg = `HTTP ${response.status}`
        try {
            const body = await response.json()
            if (body?.error) msg = body.error
        } catch { /* 二进制响应不是 JSON，忽略 */ }
        throw new WorkspaceApiError(msg, response.status)
    }
    return await response.blob()
}

/** 上传单个文件到 workspace 下指定父目录（multipart `file` 字段）。
 *  parentPath 为相对 workspace 根的目录路径（"" 表示根）。name 取自 file.name，
 *  目标已存在则服务端返回 409（不静默覆写）。
 *  与 fetchRawFile 一样绕过 wsPost：multipart 不走 JSON。 */
export async function uploadFile(
    agentId: string,
    parentPath: string,
    file: File,
): Promise<{ path: string; bytes: number }> {
    const qs = parentPath ? `?path=${encodeURIComponent(parentPath)}` : ''
    const url = `${baseUrl()}${base(agentId)}/upload${qs}`
    const form = new FormData()
    form.append('file', file)
    const response = await fetch(url, { method: 'POST', headers: authHeaders(), body: form })
    return await readResponse<{ path: string; bytes: number }>(response)
}

/** 按扩展名判断是否为可渲染的图片。需与后端 /workspace/raw 的白名单保持一致。
 *  SVG 不在名单：避免含脚本的 SVG 在同源下被执行。 */
export function isImagePath(path: string): boolean {
    const i = path.lastIndexOf('.')
    if (i < 0) return false
    const ext = path.slice(i + 1).toLowerCase()
    return ext === 'png' || ext === 'jpg' || ext === 'jpeg'
        || ext === 'gif' || ext === 'webp'
        || ext === 'bmp' || ext === 'ico'
}

/** 按扩展名判断是否为可预览文件。返回类型供调用方区分 html / md / svg 各预览分支；
 *  null 表示不可预览。父子组件共同的唯一权威源，避免两处各写一份正则失同。 */
export function previewableExt(path: string): 'html' | 'md' | 'svg' | null {
    if (/\.html?$/i.test(path)) return 'html'
    if (/\.(md|markdown)$/i.test(path)) return 'md'
    if (/\.svg$/i.test(path)) return 'svg'
    return null
}

/** 覆写已存在的文件（agent-scoped，拒绝创建、拒绝写目录/越界）。 */
export function saveFile(
    agentId: string,
    path: string,
    content: string,
): Promise<{ path: string; bytes: number }> {
    return wsPut(`${base(agentId)}/file?path=${encodeURIComponent(path)}`, { content })
}

/** 创建新文件（workspace scope）。content 默认 ""，路径已存在 → 409。 */
export function createFile(
    agentId: string,
    path: string,
    content?: string,
): Promise<{ path: string; bytes: number }> {
    return wsPost(`${base(agentId)}/file?path=${encodeURIComponent(path)}`, { content: content ?? '' })
}

/** 创建目录（workspace scope）。mkdir -p 语义，已存在 idempotent。 */
export function createDir(
    agentId: string,
    path: string,
): Promise<{ path: string; alreadyExists: boolean }> {
    return wsPost(`${base(agentId)}/dir?path=${encodeURIComponent(path)}`)
}

/** 删除普通文件（workspace scope）。 */
export function deleteFile(agentId: string, path: string): Promise<{ path: string }> {
    return wsDelete(`${base(agentId)}/file?path=${encodeURIComponent(path)}`)
}

/** 递归删除目录（workspace scope）。 */
export function deleteDir(agentId: string, path: string): Promise<{ path: string }> {
    return wsDelete(`${base(agentId)}/dir?path=${encodeURIComponent(path)}`)
}

/** 同目录内重命名文件或目录（workspace scope）。newName 须为单个路径段。
 *  返回新旧相对路径，调用方据此刷新树 / 关闭旧 viewer。 */
export function renameEntry(
    agentId: string,
    path: string,
    newName: string,
): Promise<{ path: string; oldPath: string }> {
    return wsPost(`${base(agentId)}/rename?path=${encodeURIComponent(path)}`, { newName })
}

/** 读 agent 配置目录子项 (workspace/sessions 在顶层被后端过滤)。 */
export function fetchAgentTree(agentId: string, path: string): Promise<TreeResult> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : ''
    return wsGet<TreeResult>(`${base(agentId)}/agent-tree${qs}`)
}

/** 读任意绝对路径文件（工具调用返回的真实文件系统路径，不属于任何 agent 沙箱）。
 *  走 /api/files/open，无 resolveSafe 越界保护（与 workspace scope 的语义不同）。
 *  后端已复用 workspace 的二进制检测 / 5MB 截断，返回完整 FileContent 契约，这里直接透传。 */
export function fetchAbsoluteFile(path: string): Promise<FileContent> {
    return wsPost<FileContent>(`/api/files/open`, { path })
}

/** 覆写任意绝对路径文件。走 /api/files/save。 */
export function saveAbsoluteFile(
    path: string,
    content: string,
): Promise<{ success: true }> {
    return wsPost(`/api/files/save`, { path, content })
}

/** 读 agent 配置目录下的文件。 */
export function fetchAgentFile(agentId: string, path: string): Promise<FileContent> {
    return wsGet<FileContent>(`${base(agentId)}/agent-file?path=${encodeURIComponent(path)}`)
}

/** 覆写 agent 配置目录下已存在的文件。 */
export function saveAgentFile(
    agentId: string,
    path: string,
    content: string,
): Promise<{ path: string; bytes: number }> {
    return wsPut(`${base(agentId)}/agent-file?path=${encodeURIComponent(path)}`, { content })
}

/** 创建新文件（agent scope）。顶层拒 workspace/ 与 sessions/。 */
export function createAgentFile(
    agentId: string,
    path: string,
    content?: string,
): Promise<{ path: string; bytes: number }> {
    return wsPost(`${base(agentId)}/agent-file?path=${encodeURIComponent(path)}`, { content: content ?? '' })
}

/** 创建目录（agent scope）。 */
export function createAgentDir(
    agentId: string,
    path: string,
): Promise<{ path: string; alreadyExists: boolean }> {
    return wsPost(`${base(agentId)}/agent-dir?path=${encodeURIComponent(path)}`)
}

/** 删除普通文件（agent scope）。 */
export function deleteAgentFile(agentId: string, path: string): Promise<{ path: string }> {
    return wsDelete(`${base(agentId)}/agent-file?path=${encodeURIComponent(path)}`)
}

/** 递归删除目录（agent scope）。 */
export function deleteAgentDir(agentId: string, path: string): Promise<{ path: string }> {
    return wsDelete(`${base(agentId)}/agent-dir?path=${encodeURIComponent(path)}`)
}

/** 同目录内重命名文件或目录（agent scope）。顶层拒 workspace/ 与 sessions/。 */
export function renameAgentEntry(
    agentId: string,
    path: string,
    newName: string,
): Promise<{ path: string; oldPath: string }> {
    return wsPost(`${base(agentId)}/agent-rename?path=${encodeURIComponent(path)}`, { newName })
}

// ── Git 仓库 mutation: stage / unstage / discard / commit ──
// files 缺省 = 全部；discard 是危险操作，调用者负责 confirm。

/** git add -A。files 为空指全部（unstaged + untracked + deleted）。 */
export function stageFiles(agentId: string, repo: string, files?: string[]): Promise<{ ok: true }> {
    return wsPost(
        `${base(agentId)}/repo/stage?repo=${encodeURIComponent(repo)}`,
        files === undefined ? undefined : { files },
    )
}

/** git reset HEAD --。files 为空指取消全部暂存。 */
export function unstageFiles(agentId: string, repo: string, files?: string[]): Promise<{ ok: true }> {
    return wsPost(
        `${base(agentId)}/repo/unstage?repo=${encodeURIComponent(repo)}`,
        files === undefined ? undefined : { files },
    )
}

/** 丢弃修改。全部：chekout -- . + clean -fd；指定：tracked 走 restore，untracked 删文件。 */
export function discardFiles(agentId: string, repo: string, files?: string[]): Promise<{ ok: true }> {
    return wsPost(
        `${base(agentId)}/repo/discard?repo=${encodeURIComponent(repo)}`,
        files === undefined ? undefined : { files },
    )
}

/** git commit -m。message 为空 / 空白 → 400；nothing-to-commit 等错误 → 400 + 消息透明。 */
export function commitChanges(
    agentId: string,
    repo: string,
    message: string,
): Promise<{ ok: true; head: string | null; output: string }> {
    return wsPost(
        `${base(agentId)}/repo/commit?repo=${encodeURIComponent(repo)}`,
        { message },
    )
}

/** 同步仓库：git pull 整合远程更改 + 本地领先则 git push。
 *  无上游分支 → 400；pull 冲突 → stderr 首行透明返回。 */
export function syncRepo(
    agentId: string,
    repo: string,
): Promise<{ ok: true; head: string | null; pulled: string; pushed: boolean; pushOutput: string }> {
    return wsPost(`${base(agentId)}/repo/sync?repo=${encodeURIComponent(repo)}`)
}

/** 拉 diff 两侧完整文本，供 monaco diff editor 使用。 */
export function fetchFileVersions(agentId: string, args: DiffArgs): Promise<FileVersions> {
    const params = new URLSearchParams({
        repo: args.repo,
        mode: args.mode,
        file: args.file,
    })
    if (args.ref) params.set('ref', args.ref)
    return wsGet<FileVersions>(`${base(agentId)}/repo/file-versions?${params.toString()}`)
}
