<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useWorkspaceViewer } from '../../composables/useWorkspaceViewer'
import type { DeliverableFile, DeliverableSummary } from '../../composables/useChatMessages'

/**
 * 本轮产出物面板（deliverables custom kind，服务端 deliverables 扩展产出）。
 *
 * 数据形状（useChatMessages.DeliverableFile，服务端 ReportItem 对位；
 * repo/mode/ref 已由服务端 git 验证解析）：
 * - path：展示路径（repo 相对，正斜杠）或区域外绝对路径
 * - repo：repo relPath 键（"."/一级子目录/.worktrees/*）；null = git 区域外
 * - mode：fetchDiff 视图；null = 无 diff 可点（gitignore/区域外）→ openAbsolute
 * - ref：mode=commit 时的短哈希
 *
 * 布局：格子（grid），移动端两列 / 宽屏统一四列。
 * 点击链路复用 WorkspaceViewer：与 ToolInvocation.openPathWithDiff 同一宿主，
 * 但无需客户端再解析 agentId/fetchStatus——服务端 run_end 时已做 git 验证。
 */
const props = defineProps<{
    files: DeliverableFile[]
    summary: DeliverableSummary
}>()

const { t } = useI18n()
const wsViewer = useWorkspaceViewer()

const changeMeta = {
    created: { badge: '+', cls: 'badge-success' },
    modified: { badge: '~', cls: 'badge-warning' },
    renamed: { badge: '→', cls: 'badge-info' },
    deleted: { badge: '−', cls: 'badge-error' },
} as const

// 路径拆分：目录暗色小字 + 文件名主视觉（格子内两行布局的锚点）
const splitPath = (path: string): { dir: string; base: string } => {
    const idx = path.lastIndexOf('/')
    return idx >= 0 ? { dir: `${path.slice(0, idx + 1)}`, base: path.slice(idx + 1) } : { dir: '', base: path }
}

// 工作区相对展示路径：path 是仓相对（diff 的 file 参数语义），子仓（repo ≠ "."）
// 的根级文件直接拆 split 只剩裸文件名，位置上下文（scratch-dlv/）整个丢失
// （main-3427 首个反馈：5 个文件全是裸名）。展示时补仓名前缀；点击参数不变。
const displayPath = (item: DeliverableFile): string =>
    item.repo && item.repo !== '.' ? `${item.repo}/${item.path}` : item.path

/** 点击：有 git 状态 → diff（含删除/提交）；区域外/gitignore → 直接看文件 */
function open(item: DeliverableFile) {
    if (item.repo && item.mode) {
        wsViewer.openDiff({ repo: item.repo, mode: item.mode, file: item.path, ref: item.ref ?? undefined })
    } else {
        wsViewer.openAbsolute(item.abs)
    }
}

const viaTitle = (via: DeliverableFile['via'], tool: string | null): string => {
    const key = via === 'script' ? 'chat.deliverables.viaScript' : 'chat.deliverables.viaTool'
    return `${t(key)}${tool ? ` · ${tool}` : ''}`
}
</script>

<template>
    <div class="text-sm min-w-0">
        <!-- 标题行：图标 + 文案 + 计数徽章 -->
        <div class="flex items-center gap-2 flex-wrap select-none mb-2">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"
                stroke="currentColor" class="w-4 h-4 opacity-60 shrink-0">
                <path stroke-linecap="round" stroke-linejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <span class="text-xs font-medium opacity-70">{{ t('chat.deliverables.title') }}</span>
            <div class="flex items-center gap-1">
                <span v-if="summary.created > 0" class="badge badge-success badge-sm font-mono">{{ summary.created }}+</span>
                <span v-if="summary.modified > 0" class="badge badge-warning badge-sm font-mono">{{ summary.modified }}~</span>
                <span v-if="summary.renamed > 0" class="badge badge-info badge-sm font-mono">{{ summary.renamed }}→</span>
                <span v-if="summary.deleted > 0" class="badge badge-error badge-sm font-mono">{{ summary.deleted }}−</span>
            </div>
        </div>
        <!-- 格子：一文件一格，移动端两列 / 宽屏四列 -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div v-for="(item, i) in files" :key="`${item.change}-${i}`" role="button" tabindex="0"
                class="rounded-lg border border-base-300/60 bg-base-200 px-2.5 py-2 cursor-pointer hover:bg-base-200/80 hover:border-base-300 transition-colors focus:outline-none focus-visible:border-primary min-w-0"
                :title="viaTitle(item.via, item.tool)"
                @click="open(item)" @keydown.enter.prevent="open(item)" @keydown.space.prevent="open(item)">
                <div class="flex items-center gap-1.5 min-w-0">
                    <span class="badge badge-sm font-mono shrink-0" :class="changeMeta[item.change].cls">{{ changeMeta[item.change].badge }}</span>
                    <span class="font-mono text-xs font-semibold truncate"
                        :class="item.change === 'deleted' ? 'line-through opacity-60' : ''">{{ splitPath(displayPath(item)).base }}</span>
                    <svg v-if="item.repo && item.mode" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
                        stroke-width="1.5" stroke="currentColor" class="w-3 h-3 opacity-40 shrink-0 ml-auto">
                        <path stroke-linecap="round" stroke-linejoin="round"
                            d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 00-1.06.44z" />
                    </svg>
                </div>
                <div v-if="splitPath(displayPath(item)).dir || item.status || item.ref" class="flex items-center gap-1.5 mt-1 min-w-0">
                    <span class="font-mono text-[10px] opacity-40 truncate">{{ splitPath(displayPath(item)).dir }}</span>
                    <span v-if="item.status || item.ref" class="font-mono text-[10px] opacity-40 shrink-0 ml-auto">
                        {{ item.status }}{{ item.ref ? ` @${item.ref.slice(0, 7)}` : '' }}
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>
