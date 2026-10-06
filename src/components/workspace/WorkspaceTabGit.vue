<script setup lang="ts">
/**
 * Git Tab 容器（VSCode Source Control 风格）：
 * - 顶部：RepoSelector + Commit Bar（textarea 一行 + 提交按钮另起一行）
 * - 中部：Status (Changes / Staged / Untracked) — 每组 header 带分组级 actions，
 *         每行有 hover 行内按钮 (PC) / 始终可见 (mobile)，右键弹完整菜单
 * - 底部：可折叠 History 区
 */
import { onMounted, computed, ref, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import {
    PlusIcon, MinusIcon, CheckIcon,
    ArrowUturnLeftIcon, ArrowPathRoundedSquareIcon
} from '@heroicons/vue/24/outline'
import RepoSelector from './git/RepoSelector.vue'
import StatusGroup from './git/StatusGroup.vue'
import HistoryList from './git/HistoryList.vue'
import CollapsibleSection from './CollapsibleSection.vue'
import { useWorkspaceGit, repoJoin } from '../../composables/useWorkspaceGit'
import { useWorkspacePanel, HISTORY_MIN_HEIGHT } from '../../composables/useWorkspacePanel'
import { useWorkspaceViewer } from '../../composables/useWorkspaceViewer'
import { useToast } from '../../composables/useToast'
import { useConfirm } from '../../composables/useConfirm'
import {
    buildGitFileMenuItems, buildGitInlineActions,
    type GitGroup,
} from '../../composables/useGitFileActions'
import { useGitBulkActions } from '../../composables/useGitBulkActions'
import { buildAbsolutePath } from '../../composables/useFileActions'
import type { FileChange } from '../../composables/workspace-api'

const props = defineProps<{ agentId: string }>()
const git = useWorkspaceGit()
const panel = useWorkspacePanel()
const viewer = useWorkspaceViewer()
const toast = useToast()
const { confirm } = useConfirm()
const { t } = useI18n()

const selectedRepo = computed(() => panel.getRepoForAgent(props.agentId))

async function loadAll(repo: string) {
    await Promise.all([
        // 带 refresh=1 同步真实远程 behind/ahead（主人拍板：tab 打开/切仓即自动 fetch）；
        // 服务端 upstream fetch 已降级容错，离线不会 500，只返回过期值
        git.loadStatus(props.agentId, repo, { refresh: true }),
        git.loadLog(props.agentId, repo),
    ])
}

onMounted(async () => {
    // workspaceRoot 用于拼 git 文件的绝对路径（右键复制路径）；有缓存则跳过。
    void git.loadWorkspaceRoot(props.agentId)
    if (git.repos.value.length === 0) {
        // 不跳过在飞请求：前一次挂载发起的 loadRepos 完成后没有任何代码补跑选仓
        // 逻辑（onMounted 不会重跑），tab 会停在「只有下拉、无选中无状态无历史」
        // 的空壳直到用户手动点一次仓库。重发一次请求的代价可接受（store 的 seq
        // 保证后发者胜，旧响应不会覆盖新数据）。
        await git.loadRepos(props.agentId)
    } else {
        // 缓存命中也后台重拉：agent / 终端可能已在面板外改过 git 状态，
        // tab 切换是用户最自然的「看一眼最新」时机（首屏仍用缓存零等待）。
        void git.loadRepos(props.agentId)
    }
    // 归属守护：await 期间可能已切 agent（store 被 ensureAgent 接管、repos 里是
    // 新 agent 的数据）。旧实例的续体不得用新 agent 的 repos[0] 写旧 agent 的
    // 持久化仓库选择（panel.setRepoForAgent），否则切回旧 agent 时对着不存在
    // 路径报错且不自动回退（嵌套仓保留策略）。
    if (git.currentAgentId !== props.agentId) return
    let repo = selectedRepo.value
    if (!repo) {
        repo = git.repos.value[0]?.path ?? null
        if (repo) panel.setRepoForAgent(props.agentId, repo)
    }
    // 显式选过的仓库即使不在 /repos 列表里也保留：后端只扫顶层 + .worktrees，
    // 而嵌套仓库（Files 树徽章对任意含 .git 的目录显示）是有效选择；若在这里
    // 静默回退 repos[0]，嵌套仓库永远选不中。真正失效的选择由 loadStatus 的
    // 错误条目诚实暴露（下拉切换 / 手动刷新可恢复）。
    if (!repo) return
    const needStatus = !git.status.value || git.statusRepo !== repo
    const needLog = git.commits.value.length === 0 || git.commitsRepo !== repo
    if (needStatus || needLog) {
        await loadAll(repo)
    } else {
        // 同上：缓存命中也后台重拉 status + log
        void loadAll(repo)
    }
})

// 注意：viewer.close() 不再触发 status 重拉。真正会改动磁盘的入口
//   （WorkspaceFileView.save / stage / unstage / discard / commit）自己重拉。

function onPickRepo(repo: string) {
    panel.setRepoForAgent(props.agentId, repo)
    loadAll(repo)
}

// ── 空白区点击刷新（点状态列表下方的空白 = “看一眼最新”）──
// 每次点击都会重拉（loadStatus 带 refresh=1 会 git fetch）。
// @click.self 只响应容器自身的空白点击，列表行/按钮/输入框不受影响。
// 拖拽选中文本时 mousedown 在子元素、mouseup 在空白处 → click 落在公共祖先（本容器），
// .self 挡不住；记录 pointerdown 起点，位移超过阈值视为拖拽，不触发刷新。
let blankPointerDownAt: { x: number; y: number } | null = null
function onBlankAreaPointerDown(e: PointerEvent) {
    blankPointerDownAt = { x: e.clientX, y: e.clientY }
}
function onBlankAreaClick(e: MouseEvent) {
    const down = blankPointerDownAt
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
    const repo = selectedRepo.value
    if (!repo) return
    void loadAll(repo)
}

/** 换 diff/file 目标前统一拦截：viewer 有未保存改动（含可编辑 diff 的脏 buffer）时拦
 *  confirm，同 WorkspaceTabFiles.confirmIfDirty—— diff 可编辑后，静默换目标 = 丢编辑。 */
async function confirmIfDirty(): Promise<boolean> {
    if (!viewer.dirty.value) return true
    return await confirm(t('workspace.unsavedChanges'), t('common.confirm'))
}

async function openDiff(group: GitGroup, change: FileChange) {
    if (!await confirmIfDirty()) return
    const repo = selectedRepo.value
    if (!repo) return
    viewer.openDiff({ repo, mode: group, file: change.path })
}

/** 在 unstaged 与 untracked 合并后，单文件 diff 需要看 file.status 决定 mode：
 *  '?' → untracked（服务端走 git diff --no-index）；其余 → unstaged（git diff）。 */
async function openUnstagedDiff(change: FileChange) {
    if (!await confirmIfDirty()) return
    const repo = selectedRepo.value
    if (!repo) return
    const mode = change.status === '?' ? 'untracked' : 'unstaged'
    viewer.openDiff({ repo, mode, file: change.path })
}

/** 在 viewer 里打开"工作区当前文件"（VSCode 风格 Open File）。
 *  路径需要 workspace 相对路径：repoPath + '/' + entry.path（根仓库 relPath "." 时
 *  由 repoJoin 直接用 entry.path，避免 "./" 前缀）。
 *  staged 模式 + deleted 状态：文件可能不在 worktree，调用方靠 disabledFor 屏蔽。 */
async function openFile(change: FileChange) {
    if (!await confirmIfDirty()) return
    const repo = selectedRepo.value
    if (!repo) return
    const wsRelPath = repoJoin(repo, change.path)
    viewer.openFile(wsRelPath)
}

async function openCommitDiff(args: { ref: string; file: string }) {
    if (!await confirmIfDirty()) return
    const repo = selectedRepo.value
    if (!repo) return
    viewer.openDiff({ repo, mode: 'commit', ref: args.ref, file: args.file })
}

/** commit 文件行右键"打开文件"：打开工作区当前版本（workspace 相对路径 repo/file）。 */
async function openCommitFile(file: string) {
    if (!await confirmIfDirty()) return
    const repo = selectedRepo.value
    if (!repo) return
    viewer.openFile(repoJoin(repo, file))
}

const commitsCount = computed(() => git.commits.value.length || null)

// ── 分组级批量动作（stage all / unstage all / discard all）与面板空白右键菜单共用 ──
// 实现在 useGitBulkActions（含 discard 的树缓存失效 / viewer 重载副作用同步）。
// 解构重命名保持模板绑定不变；单行 onDiscard 闭包也复用这里的 stagedAddsSnapshot / afterDiscard。
const {
    unstagedAndUntracked,
    stagedAddsSnapshot,
    afterDiscard,
    stageAll: onStageAllChanges,
    unstageAll: onUnstageAll,
    discardAll: onDiscardAllChanges,
} = useGitBulkActions({
    agentId: () => props.agentId,
    repo: () => selectedRepo.value,
})

// ── 共用：构造单行的 callback 集合（行内按钮和右键菜单都拿同一份） ──
function callbacksFor(group: GitGroup, change: FileChange) {
    // 调用方（buildItemsFor / buildInlineFor）已在 repo 为空时返回 []；?? '' 仅兜底类型
    const repo = selectedRepo.value ?? ''
    return {
        file: change,
        group,
        // unstaged 组：diff 按 status 选 mode；staged 组依然走 staged mode。
        onOpenDiff: () => group === 'unstaged' ? openUnstagedDiff(change) : openDiff(group, change),
        onOpenFile: () => openFile(change),
        // 绝对路径 = workspaceRoot + repoJoin(repo, change.path)；root 未就绪时退回相对路径。
        absolutePath: buildAbsolutePath(git.workspaceRoot.value, repoJoin(repo, change.path)),
        // git 服务端会区分 tracked / untracked，这里一起传就行。
        onStage: group === 'unstaged' && repo
            ? () => git.stage(props.agentId, repo, [change.path])
            : undefined,
        onUnstage: group === 'staged' && repo
            ? () => git.unstage(props.agentId, repo, [change.path])
            : undefined,
        onDiscard: group === 'unstaged' && repo
            ? async () => {
                const stagedAdds = stagedAddsSnapshot()
                const r = await git.discard(props.agentId, repo, [change.path])
                // epoch 失配（切 agent / 改绑 workspace）：树与 viewer 已指向新世界，
                // 旧 workspace 的路径表不能拿来失效目录 / 关 viewer。
                if (r.stale) return
                await afterDiscard([change], repo, stagedAdds)
            }
            : undefined,
        // 右键菜单「刷新」：与空白左键刷新同语义（status+log，带 refresh=1）
        onRefresh: repo ? () => { void loadAll(repo) } : undefined,
    }
}

function buildItemsFor(group: GitGroup, change: FileChange) {
    const repo = selectedRepo.value
    if (!repo) return []
    return buildGitFileMenuItems(callbacksFor(group, change))
}

function buildInlineFor(group: GitGroup, change: FileChange) {
    const repo = selectedRepo.value
    if (!repo) return []
    return buildGitInlineActions(callbacksFor(group, change))
}

// ── Commit bar ──
const commitMessage = computed({
    get: () => selectedRepo.value ? git.getCommitMessage(selectedRepo.value) : '',
    set: (v: string) => { if (selectedRepo.value) git.setCommitMessage(selectedRepo.value, v) },
})
const stagedCount = computed(() => git.status.value?.staged.length ?? 0)
const aheadCount = computed(() => git.status.value?.ahead ?? 0)
const canCommit = computed(() => {
    if (git.mutating.value) return false
    if (!selectedRepo.value) return false
    if (commitMessage.value.trim().length === 0) return false
    return stagedCount.value > 0
})

/** 主按钮三态：暂存有文件→提交；暂存空且有未推送提交→同步；其余禁用。 */
const primaryMode = computed<'commit' | 'sync' | 'disabled'>(() => {
    if (stagedCount.value > 0) return 'commit'
    if (aheadCount.value > 0) return 'sync'
    return 'disabled'
})

/** 主按钮是否可点：commit 模式需 message 非空；sync 模式只需非 mutating。 */
const canPrimary = computed(() => {
    if (git.mutating.value) return false
    if (!selectedRepo.value) return false
    if (primaryMode.value === 'disabled') return false
    if (primaryMode.value === 'commit' && commitMessage.value.trim().length === 0) return false
    return true
})

const textareaRef = ref<HTMLTextAreaElement | null>(null)

async function onCommit() {
    const repo = selectedRepo.value
    if (!repo) return
    if (!canCommit.value) return
    const msg = commitMessage.value
    try {
        const r = await git.commit(props.agentId, repo, msg)
        // agent 中途切换时 store 返回 stale：提交确实发生在旧 agent，
        // 但在新 agent 的界面里弹「已提交」会误导归属，跳过。
        if (!r.stale) toast.success(t('workspace.git.committed', { sha: r.head?.slice(0, 7) ?? '' }))
        await nextTick()
        textareaRef.value?.focus()
    } catch (e: any) {
        toast.error(`${t('workspace.git.commit')}: ${e?.message || e}`)
    }
}

function onCommitKeydown(e: KeyboardEvent) {
    // VSCode: Ctrl/Cmd+Enter 提交
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        onCommit()
    }
}

// ── Sync ──
const syncing = ref(false)

async function onSync() {
    const repo = selectedRepo.value
    if (!repo || git.mutating.value) return
    syncing.value = true
    try {
        const r = await git.sync(props.agentId, repo)
        if (!r.stale) toast.success(r.pushed ? t('workspace.git.syncedPushed') : t('workspace.git.synced'))
    } catch (e: any) {
        toast.error(`${t('workspace.git.sync')}: ${e?.message || e}`)
    } finally {
        syncing.value = false
    }
}

/** 主按钮点击：按当前模式分流到提交或同步。 */
async function onPrimary() {
    if (primaryMode.value === 'commit') {
        await onCommit()
    } else if (primaryMode.value === 'sync') {
        await onSync()
    }
}
</script>

<template>
    <div class="flex flex-col h-full">
        <!-- 顶部：RepoSelector + Commit Bar — flex-1 内部滚动；点空白处刷新 -->
        <div class="flex-1 min-h-0 overflow-y-auto" @pointerdown="onBlankAreaPointerDown"
            @click.self="onBlankAreaClick">
            <RepoSelector :selected-repo="selectedRepo" @select="onPickRepo" />

            <!-- Commit bar：消息 textarea 在上，提交按钮另起一行 — VSCode 风格 -->
            <div v-if="selectedRepo" class="px-2 pt-2 pb-1 border-b border-base-300">
                <textarea ref="textareaRef" v-model="commitMessage" rows="2"
                    class="textarea textarea-bordered textarea-xs w-full min-h-[2.5rem] resize-y leading-snug font-mono"
                    :aria-label="$t('workspace.git.messagePlaceholder')"
                    :placeholder="$t('workspace.git.messagePlaceholder')" :disabled="git.mutating.value"
                    @keydown="onCommitKeydown" />
                <div class="flex gap-1 mt-1">
                    <button type="button" class="btn btn-primary btn-sm flex-1 gap-1"
                        :class="{ 'btn-disabled': !canPrimary }" :disabled="!canPrimary"
                        :title="primaryMode === 'sync' ? $t('workspace.git.syncTip') : $t('workspace.git.commitTip')"
                        @click="onPrimary">
                        <template v-if="primaryMode === 'commit'">
                            <CheckIcon class="h-4 w-4" />
                            <span>
                                {{ $t('workspace.git.commit') }}
                                <span class="opacity-70">({{ stagedCount }})</span>
                            </span>
                        </template>
                        <template v-else-if="primaryMode === 'sync'">
                            <ArrowPathRoundedSquareIcon class="h-4 w-4" :class="{ 'animate-spin': syncing }" />
                            <span>{{ $t('workspace.git.syncChanges') }} {{ aheadCount }}↑</span>
                        </template>
                        <template v-else>
                            <CheckIcon class="h-4 w-4" />
                            <span>{{ $t('workspace.git.commit') }}</span>
                        </template>
                    </button>
                    <button type="button" class="btn   btn-sm px-2 gap-1"
                        :class="{ 'btn-disabled': git.mutating.value || !selectedRepo }"
                        :disabled="git.mutating.value || !selectedRepo"
                        :title="$t('workspace.git.syncTip')" @click="onSync">
                        <ArrowPathRoundedSquareIcon class="h-4 w-4" :class="{ 'animate-spin': syncing }" />
                    </button>
                </div>
            </div>

            <div v-if="git.statusLoading.value && !git.status.value" class="px-3 py-2 text-xs text-base-content/50">
                <span class="loading loading-spinner loading-xs mr-2" />{{ $t('common.loading') }}
            </div>
            <div v-else-if="git.statusError.value" class="px-3 py-2 text-xs text-error">
                {{ git.statusError.value }}
            </div>
            <template v-else-if="git.status.value">
                <!-- Staged 在最上面（VSCode 顺序：暂存区 → 工作区改动 → 未跟踪）。
                     unstage all。受控展开状态 跳出到 panel.statusGroups。 -->
                <StatusGroup :title="$t('workspace.staged')" :changes="git.status.value.staged"
                    :open="panel.statusGroups.value.staged"
                    :on-click="(c) => openDiff('staged', c)"
                    :build-items="(c) => buildItemsFor('staged', c)"
                    :build-inline-actions="(c) => buildInlineFor('staged', c)"
                    @toggle="(o: boolean) => panel.setStatusGroup('staged', o)">
                    <template #actions>
                        <button type="button" class="btn btn-ghost btn-xs btn-square"
                            :disabled="git.mutating.value" :aria-label="$t('workspace.git.unstageAll')"
                            :title="$t('workspace.git.unstageAll')" @click="onUnstageAll">
                            <MinusIcon class="h-3.5 w-3.5" />
                        </button>
                    </template>
                </StatusGroup>
                <!-- Changes：合并 unstaged + untracked（VSCode 风格），始终显示。
                     discard all (撤销/删) / stage all。 -->
                <StatusGroup :title="$t('workspace.changes')" :changes="unstagedAndUntracked"
                    :always-show="true"
                    :open="panel.statusGroups.value.unstaged"
                    :on-click="openUnstagedDiff"
                    :build-items="(c) => buildItemsFor('unstaged', c)"
                    :build-inline-actions="(c) => buildInlineFor('unstaged', c)"
                    @toggle="(o: boolean) => panel.setStatusGroup('unstaged', o)">
                    <template #actions>
                        <button type="button" class="btn btn-ghost btn-xs btn-square"
                            :disabled="git.mutating.value || unstagedAndUntracked.length === 0"
                            :aria-label="$t('workspace.git.discardAll')"
                            :title="$t('workspace.git.discardAll')" @click="onDiscardAllChanges">
                            <ArrowUturnLeftIcon class="h-3.5 w-3.5" />
                        </button>
                        <button type="button" class="btn btn-ghost btn-xs btn-square"
                            :disabled="git.mutating.value || unstagedAndUntracked.length === 0"
                            :aria-label="$t('workspace.git.stageAll')"
                            :title="$t('workspace.git.stageAll')" @click="onStageAllChanges">
                            <PlusIcon class="h-3.5 w-3.5" />
                        </button>
                    </template>
                </StatusGroup>
                <div v-if="!git.status.value.staged.length && unstagedAndUntracked.length === 0"
                    class="px-3 py-3 text-xs text-base-content/50">
                    {{ $t('workspace.workingTreeClean') }}
                </div>
            </template>
        </div>

        <!-- 底部：History 折叠区；resizable = 顶部 handle 可拖动调整高度（持久化到 settings store） -->
        <CollapsibleSection v-if="selectedRepo" :title="$t('workspace.history')"
            :open="panel.bottomSections.value.history" :count="commitsCount"
            :height="panel.historyHeight.value" :min-height="HISTORY_MIN_HEIGHT" resizable
            @toggle="(o: boolean) => panel.setBottomSection('history', o)"
            @resize="(h: number) => panel.setHistoryHeight(h)">
            <HistoryList :agent-id="agentId" :repo="selectedRepo" :on-open-diff="openCommitDiff"
                :on-open-file="openCommitFile" />
        </CollapsibleSection>
    </div>
</template>
