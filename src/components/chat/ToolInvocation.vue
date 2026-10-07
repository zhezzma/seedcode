<script lang="ts">
// 模块级缓存：跨所有 ToolInvocation 卡片共享（<script setup> 顶层是每实例的，
// 长对话每张卡会各自拉一遍 fetchTree/fetchRepos）。值为 Promise 兼做并发去重；
// 失败即从缓存删除，下次点击可重试。status 不缓存（diff 模式判定要新鲜数据）。
const wsRootCache = new Map<string, Promise<string>>()
const reposCache = new Map<string, Promise<{ path: string }[]>>()
</script>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
    WrenchScrewdriverIcon,
    CheckCircleIcon,
    ExclamationCircleIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    EyeIcon,
    CommandLineIcon
} from '@heroicons/vue/24/outline'
import { useWorkspaceViewer } from '../../composables/useWorkspaceViewer'
import { useSubagentTrace } from '../../composables/useSubagentTrace'
import { useChatState } from '../../composables/useChatState'
import { fetchRepos, fetchStatus, fetchTree } from '../../composables/workspace-api.ts'
import {
    extractArgsPaths,
    findRepoFor,
    isAbsolutePath,
    isAssetUrl,
    joinPath,
    pickDiffMode,
    toRepoRelative,
    toSlash,
    toWorkspaceRelative,
} from '../../utils/tool-file-paths.ts'

const props = defineProps<{
    toolName: string
    args: Record<string, any>
    result?: any
    state?: 'calling' | 'success' | 'error'
    errorMessage?: string
    details?: any  // subagent 进度详情
}>()

const { t } = useI18n()
const wsViewer = useWorkspaceViewer()
const traceViewer = useSubagentTrace()
const chatState = useChatState()

const isOpen = ref(false)

const toggleOpen = () => {
    isOpen.value = !isOpen.value
}

// ─── 终态判定（耗时展示用：终态且有 endedAt 显示静态耗时，否则计时）───
function isTerminalStatus(status?: string) {
    return status === 'completed' || status === 'error' || status === 'aborted'
}

// ─── Subagent 相关 ─────────────────────────
const isSubagentTool = computed(() => {
    return props.toolName === 'subagent'
})

/** 子代理结果列表 */
const subagentResults = computed(() => {
    return props.details?.results || []
})

/** 子代理整体状态文字 */
const subagentStatusText = computed(() => {
    return props.details?.statusText || ''
})

/** 子代理模式 */
const subagentMode = computed(() => {
    return props.details?.mode || 'single'
})

/** resume 清单（mode:"resume" 且无 agent/session 参数的只读列表调用）：无运行结果与轨迹，按普通工具卡展开显示（候选清单在文本结果里） */
const isResumeListing = computed(() => {
    return isSubagentTool.value && props.args?.mode === 'resume' && !props.args?.agent && !props.args?.session
})

/** 获取子代理状态对应的图标 */
function getStatusIcon(status?: string) {
    switch (status) {
        case 'pending': return '⏳'
        case 'initializing': return '⏳'
        case 'thinking': return '🧠'
        case 'tool_running': return '🔧'
        case 'completed': return '✅'
        case 'error': return '❌'
        case 'aborted': return '⛔'
        default: return '⏳'
    }
}

/** 获取状态对应的 CSS 颜色类 */
function getStatusColorClass(status?: string) {
    switch (status) {
        case 'thinking': return 'text-info'
        case 'tool_running': return 'text-warning'
        case 'completed': return 'text-success'
        case 'error': return 'text-error'
        case 'aborted': return 'text-error'
        default: return 'text-base-content/60'
    }
}

/** 格式化状态文字 */
function getStatusLabel(status?: string) {
    switch (status) {
        case 'pending': return '等待中'
        case 'initializing': return '初始化中'
        case 'thinking': return '思考中'
        case 'tool_running': return '执行工具'
        case 'completed': return '已完成'
        case 'error': return '出错'
        case 'aborted': return '已中止'
        default: return '运行中'
    }
}

/** 格式化耗时；endedAt 存在时显示静态时长（完成后不再随当前时间增长） */
function formatElapsed(startedAt?: number, endedAt?: number) {
    if (!startedAt) return ''
    const elapsed = Math.round(((endedAt ?? Date.now()) - startedAt) / 1000)
    if (elapsed < 60) return `${elapsed}s`
    const min = Math.floor(elapsed / 60)
    const sec = elapsed % 60
    return `${min}m ${sec}s`
}

/** 格式化 token 数量 */
function formatTokens(count: number) {
    if (count < 1000) return count.toString()
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`
    return `${Math.round(count / 1000)}k`
}

const statusText = computed(() => {
    // 对 subagent 工具始终显示富状态（运行中与完成后保持一致的结构与文案）
    if (isSubagentTool.value && subagentResults.value.length > 0) {
        const results = subagentResults.value

        if (subagentMode.value === 'parallel') {
            const done = results.filter((r: any) => r.exitCode !== -1 && r.status === 'completed').length
            const summary = props.state === 'calling' ? '并行执行中' : props.state === 'error' ? '并行失败' : '并行完成'
            return `${props.toolName} — ${summary} ${done}/${results.length}`
        }

        const r = results[results.length - 1]
        const icon = getStatusIcon(r?.status)
        const label = getStatusLabel(r?.status)
        return `${icon} ${props.toolName}: ${r?.agent || ''} ${label}`
    }
    if (isSubagentTool.value && props.state === 'calling') return t('tool.calling', { toolName: props.toolName })
    switch (props.state) {
        case 'calling':
            return t('tool.calling', { toolName: props.toolName })
        case 'success':
            return t('tool.used', { toolName: props.toolName })
        case 'error':
            return t('tool.failed', { toolName: props.toolName })
        default:
            return props.toolName
    }
})

const formatJson = (data: any) => {
    try {
        if (typeof data === 'string') {
            // Try to parse if it looks like JSON object/array
            if (data.trim().startsWith('{') || data.trim().startsWith('[')) {
                return JSON.stringify(JSON.parse(data), null, 2)
            }
            return data
        }
        return JSON.stringify(data, null, 2)
    } catch (e) {
        return String(data)
    }
}

/**
 * 判断结果是否为特定格式：[{ "type": "text", "text": "..." }, ...]
 * 如果是，则提取其文本内容直接显示。
 */
const textResultContent = computed(() => {
    if (!props.result) return null

    // 如果 result 是数组
    if (Array.isArray(props.result)) {
        // 检查是否每一项都是 { type: 'text', text: '...' }
        const isAllText = props.result.every(item =>
            item &&
            typeof item === 'object' &&
            item.type === 'text' &&
            typeof item.text === 'string'
        )

        if (isAllText && props.result.length > 0) {
            return props.result.map(item => item.text).join('\n')
        }

        // view_image 工具返回 image 块（含几 MB base64），提取文本部分，
        // 避免把 base64 JSON 序列化渲染。
        if (props.toolName === 'view_image') {
            const imageCount = props.result.filter(item => item?.type === 'image').length
            const textParts = props.result
                .filter(item => item?.type === 'text' && typeof item.text === 'string')
                .map(item => item.text)
            const prefix = `[${imageCount} 张图片]`
            return textParts.length > 0 ? `${prefix}\n${textParts.join('\n')}` : prefix
        }
    }

    // 如果 result 本身就是单一的 { type: 'text', text: '...' }
    if (props.result && typeof props.result === 'object' && props.result.type === 'text' && typeof props.result.text === 'string') {
        return props.result.text
    }

    return null
})

/**
 * 从文本中提取合法的文件路径（支持 Unix 和 Windows 路径）
 * Unix:    /home/user/file.txt
 * Windows: D:\folder\file.ts  D:\\folder\\file.ts  D:/folder/file.ts
 * 排除 URL 和 JSON 转义序列（\n \t \r 等）
 */
function extractPaths(text: string): string[] {
    if (!text) return []
    // 1. 移除 URL，防止 URL 路径被误提取
    let cleaned = text.replace(/(?:https?|ftp|wss?):\/\/[^\s"'`,;[\]{}()]+/gi, '')
    // 2. 移除 JSON 转义序列（\n \t \r 等），防止 \n 被视为路径
    //    使用负向后瞻 (?<!\\) 确保不会破坏路径中的 \\t (如 \\test_xxx.txt)
    //    注意：不包含 0，因为 \0 在路径中常见（如 \00-剧情总纲.md）
    cleaned = cleaned.replace(/(?<!\\)\\[nrtbfv]/g, ' ')
    const patterns = [
        // Windows: D:\ or D:\\ or D:/ 后跟路径段，最终以 .ext 结尾（文件名）
        /[A-Za-z]:[\\\/](?:[^\s"'`,;\[\]{}()]*[\\\/])*[^\s"'`,;\[\]{}()\\\/]+\.[A-Za-z0-9_]{1,20}/g,
        // Unix absolute: /xxx/... 至少 1 段目录，支持 Unicode（如中文），lookbehind 防止误匹配 a/b/c
        /(?<=^|[\s"'`,;\[\]{}()])\/(?:[\w.\-@\p{L}]+\/)+\.?[\w\-@\p{L}]+(?:\.[\w]{1,20})?/gmu,
    ]
    const results = new Set<string>()
    for (const regex of patterns) {
        const matches = cleaned.match(regex) || []
        for (const m of matches) {
            // 清理尾部的标点符号（但保留 .ext）
            const trimmed = m.replace(/[,;:!?)\]]+$/, '')
            // 确保仍然有扩展名，或者是 .dotfile（以点开头的文件名，如 .env .todos.json）
            if (trimmed.length > 2 && (/\.\w+$/.test(trimmed) || /\/\.\w/.test(trimmed))) results.add(trimmed)
        }
    }
    return [...results]
}

/** 获取路径的文件名（basename） */
function basename(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || path
}

/** Args 中按参数键名提取的路径（path / url / images[]，不做正则文本扫描） */
const argsPaths = computed(() => {
    return extractArgsPaths(props.args)
})

/** Result 中提取到的路径 */
const resultPaths = computed(() => {
    const text = textResultContent.value ?? formatJson(props.result)
    return extractPaths(text)
})

/** 点击路径按钮 — 全屏打开（复用 WorkspaceViewer，与 workspace 打开文件体验一致；结果路径按钮用）*/
function openFilePath(path: string) {
    wsViewer.openAbsolute(path)
}

// ─── args 路径 → git diff 优先打开 ─────────────────────────

function ensureWorkspaceRoot(agentId: string): Promise<string> {
    let p = wsRootCache.get(agentId)
    if (!p) {
        p = fetchTree(agentId, '').then(t => {
            const root = t.root || ''
            if (!root) throw new Error('workspace root unavailable')
            return root
        })
        wsRootCache.set(agentId, p)
        p.catch(() => wsRootCache.delete(agentId))
    }
    return p
}

function ensureRepos(agentId: string): Promise<{ path: string }[]> {
    let p = reposCache.get(agentId)
    if (!p) {
        p = fetchRepos(agentId).then(r => r.repos || [])
        reposCache.set(agentId, p)
        p.catch(() => reposCache.delete(agentId))
    }
    return p
}

/**
 * 点击 args 路径按钮：优先打开该文件的 git 工作区 diff（agent 改了什么）；
 * 不可 diff（/assets URL / 在 workspace 外 / 不在任何 repo / 文件干净）或接口失败时回退直接打开。
 */
async function openPathWithDiff(rawPath: string) {
    const agentId = chatState.agentsSelectedId || ''
    // /assets/... 是公开静态 URL（generate_image 产物），不是 workspace 文件
    if (isAssetUrl(rawPath) || !agentId) {
        wsViewer.openAbsolute(rawPath)
        return
    }
    try {
        const root = await ensureWorkspaceRoot(agentId)
        const abs = isAbsolutePath(rawPath) ? toSlash(rawPath) : joinPath(root, rawPath)
        const wsRel = toWorkspaceRelative(root, abs)
        if (!wsRel) {
            wsViewer.openAbsolute(abs) // workspace 外
            return
        }
        const repo = findRepoFor(wsRel, await ensureRepos(agentId))
        if (!repo) {
            wsViewer.openAbsolute(abs) // 不在任何 git 仓库
            return
        }
        const repoRel = toRepoRelative(repo, wsRel)
        const mode = pickDiffMode(await fetchStatus(agentId, repo), repoRel)
        if (!mode) {
            wsViewer.openAbsolute(abs) // 文件干净，无 diff 可看
            return
        }
        // 多次 await 期间用户可能已切到别的 agent：diff 视图按当前选中 agent 的 workspace
        // 解析 repo/file，旧 agent 的解析结果会张冠李戴 → 回退 agent 无关的直接打开
        if (chatState.agentsSelectedId !== agentId) {
            wsViewer.openAbsolute(abs)
            return
        }
        wsViewer.openDiff({ repo, mode, file: repoRel })
    } catch {
        // 接口失败回退：绝对路径直接打开；相对路径退 workspace 作用域打开
        // （此时 agent 已切换则放弃 —— openFile 按当前 agent 的 workspace 解析会错位）
        if (isAbsolutePath(rawPath)) wsViewer.openAbsolute(toSlash(rawPath))
        else if (chatState.agentsSelectedId === agentId) wsViewer.openFile(toSlash(rawPath))
    }
}

/** 预览内容 — 全屏只读展示（复用 WorkspaceViewer 的 text 模式，与打开文件体验一致）*/
function previewContent(content: string) {
    wsViewer.openText(content)
}

// ─── 子代理轨迹查看 ─────────────────────────
/** 任一子代理带回 subagentSessionId 即可查看落盘轨迹 */
const canViewTrace = computed(() => {
    return isSubagentTool.value && subagentResults.value.some((r: any) => r?.subagentSessionId)
})

/** 打开轨迹抽屉（全局状态，抽屉在 HomeView 挂载；点在哪个子代理行上就定位哪个 tab） */
function openTrace(subId?: string) {
    // 优先用服务端随 details 下发的 sessionId（轨迹真实落盘归属）：会话树内切分支后
    // 当前会话 id（树根）与工具运行的分支 conversation id 会分叉，旧卡片无此字段时
    // 回落当前会话 id（根分支场景两者一致，兼容历史）
    const parentSessionId = props.details?.sessionId || chatState.currentSession?.id
    if (!parentSessionId) return
    traceViewer.open(parentSessionId, subagentResults.value, subId)
}

/** subagent 卡无可打开轨迹且失败时的兜底：允许展开查看错误信息（否则错误无处可看） */
const subagentErrorExpandable = computed(() => {
    return isSubagentTool.value && props.state === 'error' && !canViewTrace.value
})

/** 头部点击：resume 清单卡按普通工具卡展开/收起；subagent 运行卡直接打开轨迹（失败且无轨迹时回退展开错误详情）；其他工具卡展开/收起 */
function onHeaderClick() {
    if (isSubagentTool.value) {
        if (isResumeListing.value) {
            toggleOpen()
            return
        }
        if (canViewTrace.value) openTrace()
        else if (subagentErrorExpandable.value) toggleOpen()
        return
    }
    toggleOpen()
}
</script>

<template>
    <div class="card   bg-base-200  overflow-hidden  ">
        <!-- Header（subagent 卡点击直接打开轨迹，无展开内容） -->
        <div @click="onHeaderClick"
            class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none  bg-base-200  text-sm">
            <!-- Status Icon -->
            <div class="flex-none">
                <span v-if="state === 'calling'" class="loading loading-spinner loading-xs text-primary"></span>
                <CheckCircleIcon v-else-if="state === 'success'" class="w-5 h-5 text-success" />
                <ExclamationCircleIcon v-else-if="state === 'error'" class="w-5 h-5 text-error" />
                <WrenchScrewdriverIcon v-else class="w-5 h-5 text-base-content/70" />
            </div>

            <!-- Title（min-w-0 允许被长 agent 名压缩，否则 flex 默认 min-width:auto 会把右侧按钮挤出容器） -->
            <div class="flex-1 min-w-0 break-words font-medium text-base-content/80">
                {{ statusText }}
            </div>

            <!-- Toggle Icon（subagent 运行卡无展开内容，不显示；resume 清单卡按普通卡展开；失败且无轨迹时可展开错误详情） -->
            <div v-if="!isSubagentTool || subagentErrorExpandable || isResumeListing" class="flex-none text-base-content/50">
                <ChevronDownIcon v-if="isOpen" class="w-4 h-4" />
                <ChevronRightIcon v-else class="w-4 h-4" />
            </div>
        </div>

        <!-- Subagent Progress (运行中与完成后均可见，保持一致结构) -->
        <div v-if="isSubagentTool && subagentResults.length > 0" class="px-3 py-2 pt-0">
            <div v-for="(r, idx) in subagentResults" :key="idx"
                class="flex items-center gap-2 py-1" :class="{ 'border-t border-base-300 mt-1 pt-1': Number(idx) > 0 }">
                <!-- Status icon -->
                <span class="text-sm flex-none">{{ getStatusIcon(r.status) }}</span>
                <!-- Agent name（min-w-0 + break-all：长名收缩换行，保住右侧状态/耗时/轨迹入口） -->
                <span class="font-mono text-xs font-semibold min-w-0 break-all" :class="getStatusColorClass(r.status)">{{ r.agent }}</span>
                <!-- Status label -->
                <span class="text-xs" :class="getStatusColorClass(r.status)">{{ getStatusLabel(r.status) }}</span>
                <!-- 恢复来源徽标（mode:"resume" 续跑的子代理） -->
                <span v-if="r.resumedFrom" class="text-xs text-info/80 flex-none"
                    :title="$t('tool.resumedFrom') + ' ' + r.resumedFrom">↻ {{ r.resumedFrom }}</span>
                <!-- Current tool (if running) -->
                <span v-if="r.status === 'tool_running' && r.currentTool" class="text-xs text-warning/80 font-mono">→ {{ r.currentTool }}</span>
                <!-- Turn info -->
                <span v-if="Number(r.usage?.turns) > 0" class="text-xs text-base-content/40">Turn {{ r.usage.turns }}</span>
                <!-- Elapsed（终态且有 endedAt 显示静态时长；历史数据无 endedAt 则隐藏，避免计时器无限增长） -->
                <span v-if="r.startedAt && (!isTerminalStatus(r.status) || r.endedAt)" class="text-xs text-base-content/40 ml-auto">{{ formatElapsed(r.startedAt, r.endedAt) }}</span>
                <!-- 轨迹入口：点击直接定位到该子代理的 tab -->
                <button v-if="r.subagentSessionId"
                    class="btn btn-ghost btn-xs btn-circle flex-none text-base-content/40 hover:text-primary"
                    :title="$t('subagentTrace.viewAgentTrace', { agent: r.agent })" @click.stop="openTrace(r.subagentSessionId)">
                    <CommandLineIcon class="w-3 h-3" />
                </button>
            </div>
            <!-- Streaming text preview -->
            <div v-if="subagentResults.length === 1 && subagentResults[0].streamingText && subagentResults[0].status === 'thinking'"
                class="mt-1 text-xs text-base-content/50 font-mono truncate max-w-full">
                <span class="opacity-60">▸ </span>{{ subagentResults[0].streamingText.slice(-150) }}
            </div>
        </div>

        <!-- Details Body（subagent 运行卡只看轨迹，resume 清单卡按普通卡展开；失败且无轨迹时兜底展开错误） -->
        <div v-if="isOpen && (!isSubagentTool || subagentErrorExpandable || isResumeListing)" class="px-3 py-2 pt-0 space-y-2" >
                <!-- Arguments -->
                <div>
                    <div class="flex items-center gap-2 mb-1 flex-wrap">
                        <div class="text-xs font-semibold text-base-content/50 uppercase tracking-wider">{{
                            $t('tool.args') }}</div>
                        <!-- Preview button -->
                        <button class="btn btn-ghost btn-xs gap-0.5 text-base-content/50 hover:text-primary"
                            @click="previewContent(formatJson(args))" :title="$t('tool.preview')">
                            <EyeIcon class="w-3.5 h-3.5" />
                        </button>
                        <!-- Path buttons（点击优先 git diff，回退直接打开） -->
                        <button v-for="p in argsPaths" :key="p"
                            class="btn btn-ghost btn-xs font-mono text-primary/80 hover:text-primary hover:bg-primary/10"
                            :title="p" @click="openPathWithDiff(p)">
                            {{ basename(p) }}
                        </button>
                    </div>
                    <pre
                        class="bg-base-300 p-2 rounded text-xs font-mono overflow-x-auto">{{ formatJson(args) }}</pre>
                </div>

                <!-- Result -->
                <div v-if="result">
                    <div class="flex items-center gap-2 mb-1 flex-wrap">
                        <div class="text-xs font-semibold text-base-content/50 uppercase tracking-wider">{{
                            $t('tool.result') }}</div>
                        <!-- Preview button -->
                        <button class="btn btn-ghost btn-xs gap-0.5 text-base-content/50 hover:text-primary"
                            @click="previewContent(textResultContent ?? formatJson(result))"
                            :title="$t('tool.preview')">
                            <EyeIcon class="w-3.5 h-3.5" />
                        </button>
                        <!-- Path buttons -->
                        <button v-for="p in resultPaths" :key="p"
                            class="btn btn-ghost btn-xs font-mono text-primary/80 hover:text-primary hover:bg-primary/10"
                            :title="p" @click="openFilePath(p)">
                            {{ basename(p) }}
                        </button>
                    </div>

                    <!-- 优化：如果包含纯文本结果，直接展示 -->
                    <div v-if="textResultContent !== null"
                        class="bg-base-300 p-2 rounded text-xs text-base-content/80 whitespace-pre-wrap break-words leading-relaxed overflow-x-auto max-h-96">
                        {{ textResultContent }}
                    </div>

                    <!-- 否则显示原始 JSON 格式 -->
                    <pre v-else
                        class="bg-base-300 p-2 rounded text-xs font-mono overflow-x-auto max-h-60">{{ formatJson(result) }}</pre>
                </div>

                <!-- Error -->
                <div v-if="errorMessage">
                    <div class="text-xs font-semibold text-error mb-1 uppercase tracking-wider">{{ $t('tool.error') }}
                    </div>
                    <pre
                        class="bg-error/10 text-error p-2 rounded text-xs font-mono overflow-x-auto">{{ errorMessage }}</pre>
                </div>
        </div>
    </div>
</template>