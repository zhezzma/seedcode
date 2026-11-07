<script setup lang="ts">
/**
 * 提交历史列表：
 * - 默认加载 50 条
 * - 点击 commit 行 → 就地展开列出此 commit 改动的文件，再点击文件打开 diff
 * - 底部 "load more" 翻页
 */
import {
    ChevronDownIcon, ChevronRightIcon, ClipboardDocumentIcon, DocumentIcon,
} from '@heroicons/vue/24/outline'
import { useI18n } from 'vue-i18n'
import { useWorkspaceGit, formatCommitInfo, repoJoin } from '../../../composables/useWorkspaceGit'
import { useContextMenu } from '../../../composables/useContextMenu'
import { useToast } from '../../../composables/useToast'
import { writeClipboard } from '../../../utils/clipboard'
import { buildGitFileMenu } from '../../../composables/useGitFileActions'
import { buildAbsolutePath } from '../../../composables/useFileActions'
import type { CommitFile, CommitMeta } from '../../../composables/workspace-api'

const props = defineProps<{
    agentId: string
    repo: string
    onOpenDiff: (args: { ref: string; file: string; deleted?: boolean }) => void
    /** 打开工作区当前版本文件（commit 文件行右键"打开文件"）。 */
    onOpenFile?: (file: string) => void
}>()

const git = useWorkspaceGit()
const ctxMenu = useContextMenu()
const toast = useToast()
const { t } = useI18n()

// expanded 状态提升到 store（commitExpandedData）：PC v-if 卸载重挂与移动端 drawer 关闭/重开
// 之后，之前点开的 commit 及其文件列表保持显示。agent 切换时由 git.reset() 统一清理。

async function toggleCommit(sha: string) {
    const opened = git.toggleCommitExpanded(sha)
    if (opened && !git.commitFiles.value[sha]) {
        await git.loadCommitFiles(props.agentId, props.repo, sha)
    }
}

function onCommitContextMenu(e: MouseEvent, commit: CommitMeta) {
    e.preventDefault()
    ctxMenu.openAt([
        {
            label: t('workspace.git.copyCommitInfo'),
            icon: ClipboardDocumentIcon,
            action: async () => {
                try {
                    await writeClipboard(formatCommitInfo(commit))
                    toast.success(t('workspace.menu.copied'))
                } catch (err: any) {
                    toast.error(`${t('workspace.git.copyCommitInfo')}: ${err?.message || err}`)
                }
            },
        },
    ], { x: e.clientX, y: e.clientY })
}

/** commit 文件行右键：复用通用 buildGitFileMenu（与工作区/暂存区共用打开/diff/复制路径）。 */
function onCommitFileContextMenu(e: MouseEvent, commit: CommitMeta, f: CommitFile) {
    e.preventDefault()
    const openFile = props.onOpenFile
    ctxMenu.openAt(buildGitFileMenu({
        onOpenDiff: () => props.onOpenDiff({ ref: commit.sha, file: f.path, deleted: f.status === 'D' }),
        onOpenFile: openFile ? () => openFile(f.path) : undefined,
        absolutePath: buildAbsolutePath(git.workspaceRoot.value, repoJoin(props.repo, f.path)),
        // commit 中被删除的文件在工作区不存在，禁用打开文件。
        openFileDisabled: f.status === 'D',
    }), { x: e.clientX, y: e.clientY })
}

/** 简单的相对时间显示（秒/分/时/天）；不引入额外依赖 */
function relativeTime(iso: string): string {
    const t = new Date(iso).getTime()
    if (isNaN(t)) return iso
    const diff = (Date.now() - t) / 1000
    if (diff < 60) return Math.floor(diff) + 's ago'
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago'
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago'
    return Math.floor(diff / 86400) + 'd ago'
}
</script>

<template>
    <div class="text-xs">
        <div v-if="git.commitsLoading.value && git.commits.value.length === 0"
            class="px-3 py-2 text-base-content/50">
            <span class="loading loading-spinner loading-xs" />
        </div>
        <div v-else-if="git.commitsError.value" class="px-3 py-2 text-error">
            {{ git.commitsError.value }}
        </div>
        <template v-else>
            <div v-for="commit in git.commits.value" :key="commit.sha">
                <button class="flex items-center gap-2 w-full text-left px-2 py-1 hover:bg-base-300"
                    :title="commit.subject" @click="toggleCommit(commit.sha)"
                    @contextmenu="onCommitContextMenu($event, commit)">
                    <ChevronDownIcon v-if="git.commitExpanded.value[commit.sha]" class="h-3 w-3 shrink-0" />
                    <ChevronRightIcon v-else class="h-3 w-3 shrink-0" />
                    <span class="font-mono text-base-content/60">●</span>
                    <span class="font-mono text-base-content/60 shrink-0">{{ commit.shortSha }}</span>
                    <span class="truncate flex-1">{{ commit.subject }}</span>
                    <span class="text-base-content/40 shrink-0">{{ relativeTime(commit.authorDate) }}</span>
                </button>
                <div v-if="git.commitExpanded.value[commit.sha]" class="pl-8 pb-1">
                    <div v-if="git.isCommitFilesLoading(commit.sha)" class="text-base-content/40">
                        <span class="loading loading-spinner loading-xs" />
                    </div>
                    <button v-for="f in git.commitFiles.value[commit.sha] || []" :key="f.path"
                        class="flex items-center gap-2 w-full text-left px-2 py-0.5 hover:bg-base-300 font-mono"
                        @click="onOpenDiff({ ref: commit.sha, file: f.path, deleted: f.status === 'D' })"
                        @contextmenu="onCommitFileContextMenu($event, commit, f)">
                        <DocumentIcon class="h-3 w-3 shrink-0 text-base-content/40" />
                        <span class="truncate">{{ f.path }}</span>
                    </button>
                </div>
            </div>
            <button v-if="git.commitsHasMore.value"
                class="w-full text-center px-2 py-1 text-base-content/60 hover:bg-base-300"
                :disabled="git.commitsLoading.value" @click="git.loadMoreLog(agentId, repo)">
                {{ git.commitsLoading.value ? $t('common.loading') : $t('workspace.loadMore') }}
            </button>
        </template>
    </div>
</template>
