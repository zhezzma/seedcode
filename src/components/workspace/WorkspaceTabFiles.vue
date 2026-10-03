<script setup lang="ts">
/**
 * Files Tab：以 workspace 根为树根的懒加载目录树。
 *
 * 布局（VSCode 风格）：
 * - 顶部 Workspace section header：左侧标题 + 右侧 + 文件 / + 目录
 * - 主区：workspace 目录树（flex-1 + 内部滚动）
 * - 底部：可折叠 "Agent Files" 区，header 同样带 + 文件 / + 目录 actions
 *
 * 点击文件 → 进入 Viewer 模式（替换聊天主区）。
 * 点击 git 仓库徽章 → 切到 Git tab 并选中此仓库。
 *
 * Toolbar 提供根目录下的「新建文件 / 新建目录」入口，与右键菜单走同一组 runNew* 流程。
 */
import { onMounted, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { DocumentPlusIcon, FolderPlusIcon, ArrowUpOnSquareIcon } from '@heroicons/vue/24/outline'
import { useWorkspaceTree } from '../../composables/useWorkspaceTree'
import { useAgentFiles } from '../../composables/useAgentFiles'
import { useWorkspaceViewer } from '../../composables/useWorkspaceViewer'
import { useWorkspacePanel, AGENT_FILES_MIN_HEIGHT } from '../../composables/useWorkspacePanel'
import { useWorkspaceRefresh } from '../../composables/useWorkspaceRefresh'
import { useWorkspaceGit } from '../../composables/useWorkspaceGit'
import { useToast } from '../../composables/useToast'
import { useConfirm } from '../../composables/useConfirm'
import { runNewFileFlow, runNewDirFlow, runUploadFlow } from '../../composables/useFileActions'
import type { TreeEntry } from '../../composables/workspace-api'
import FileTreeNode from './FileTreeNode.vue'
import AgentFileTreeNode from './AgentFileTreeNode.vue'
import CollapsibleSection from './CollapsibleSection.vue'

const props = defineProps<{ agentId: string }>()
const tree = useWorkspaceTree()
const agentFiles = useAgentFiles()
const viewer = useWorkspaceViewer()
const panel = useWorkspacePanel()
const git = useWorkspaceGit()
const toast = useToast()
const { confirm } = useConfirm()
const { t } = useI18n()
// 空白左键刷新与面板右键菜单/文件行菜单共用同一套全量刷新
const { refreshAll } = useWorkspaceRefresh()

onMounted(() => {
    tree.loadPath(props.agentId, '')
})

// 折叠区展开时按需懒加载 agent 配置目录根（spec: 默认折叠避免无意义请求）
watch(
    () => panel.bottomSections.value.agentFiles,
    (open) => {
        if (open && !agentFiles.entriesAt('') && !agentFiles.isLoading('')) {
            agentFiles.loadPath(props.agentId, '')
        }
    },
    { immediate: true },
)

/** 切文件前统一拦截：仅在 viewer 为该文件有未保存改动时拦 confirm。 */
async function confirmIfDirty(): Promise<boolean> {
    if (!viewer.dirty.value) return true
    return await confirm(t('workspace.unsavedChanges'), t('common.confirm'))
}

async function onClickEntry(entry: TreeEntry) {
    if (entry.type === 'symlink') {
        toast.warning(t('workspace.symlinkBlocked'))
        return
    }
    if (entry.type === 'dir') {
        tree.toggleExpand(entry.path)
        if (tree.isExpanded(entry.path)) {
            tree.loadPath(props.agentId, entry.path)
        }
        return
    }
    // file → viewer：切文件前询问丢弃（WorkspaceViewer.close 只拦 back/Esc，这里补充 tree 路径）。
    // 传递相对 workspace 路径，后端 agent-scoped /file 接口 resolveSafe 负责拼绝对路径。
    if (!await confirmIfDirty()) return
    viewer.openFile(entry.path)
}

function onClickRepoBadge(entry: TreeEntry) {
    panel.setTab('git')
    panel.setRepoForAgent(props.agentId, entry.path)
}

async function onClickAgentEntry(entry: TreeEntry) {
    if (entry.type === 'symlink') {
        toast.warning(t('workspace.symlinkBlocked'))
        return
    }
    if (entry.type === 'dir') {
        agentFiles.toggleExpand(entry.path)
        if (agentFiles.isExpanded(entry.path)) {
            agentFiles.loadPath(props.agentId, entry.path)
        }
        return
    }
    if (!await confirmIfDirty()) return
    viewer.openAgentFile(entry.path)
}

const rootResult = computed(() => tree.entriesAt(''))
const agentRootResult = computed(() => agentFiles.entriesAt(''))
const agentFilesCount = computed(() => agentRootResult.value?.entries.length ?? null)
const workspaceFilesCount = computed(() => rootResult.value?.entries.length ?? null)

// ── 根目录 toolbar：runNew* 由 useFileActions 暴露，与右键菜单共用一套流程。
//    onMutated 在本组件内的 composable 实例上 invalidate + loadPath，避免 HMR singleton 分裂。
async function onMutatedWorkspace(parent: string) {
    tree.invalidate(parent)
    await tree.loadPath(props.agentId, parent)
    // workspace 磁盘变了 → git status / repos 下拉摘要可能变（新建=untracked、
    // 删除/改名=条目消失）。未打开过 Git tab 时 refreshWorktreeState 内部 no-op。
    void git.refreshWorktreeState(props.agentId)
}
async function onMutatedAgent(parent: string) {
    agentFiles.invalidate(parent)
    await agentFiles.loadPath(props.agentId, parent)
}
function onNewWorkspaceFile() {
    runNewFileFlow({ agentId: props.agentId, scope: 'workspace', parentPath: '', onMutated: onMutatedWorkspace })
}
function onNewWorkspaceDir() {
    runNewDirFlow({ agentId: props.agentId, scope: 'workspace', parentPath: '', onMutated: onMutatedWorkspace })
}
function onUploadWorkspace() {
    runUploadFlow({ agentId: props.agentId, scope: 'workspace', parentPath: '', onMutated: onMutatedWorkspace })
}
function onNewAgentFile() {
    runNewFileFlow({ agentId: props.agentId, scope: 'agent', parentPath: '', onMutated: onMutatedAgent })
}
function onNewAgentDir() {
    runNewDirFlow({ agentId: props.agentId, scope: 'agent', parentPath: '', onMutated: onMutatedAgent })
}

// ── 空白区点击刷新（与 Git tab 同语义：点目录树空白 = “看一眼最新”）──
// 拖拽选中文本（位移 > 4px）不触发。
let blankPointerDownAt: { x: number; y: number } | null = null
function onBlankAreaPointerDown(e: PointerEvent) {
    blankPointerDownAt = { x: e.clientX, y: e.clientY }
}
function onBlankAreaClick(e: MouseEvent) {
    const down = blankPointerDownAt
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
    void refreshAll(props.agentId, () => props.agentId)
}
</script>

<template>
    <div class="flex flex-col h-full text-sm">
        <!-- Workspace section header：左侧标题 + 右侧 + 文件 / + 目录。
             视觉与底部 CollapsibleSection 的 header 一致，让两块感觉成对。 -->
        <div class="flex items-stretch bg-base-300/50 border-b border-base-300 shrink-0">
            <div
                class="flex-1 flex items-center gap-1 px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-base-content/70 select-none">
                <span class="flex-1 text-left truncate">{{ $t('workspace.workspace') }}</span>
                <span v-if="workspaceFilesCount !== null && workspaceFilesCount > 0"
                    class="text-[10px] font-mono normal-case text-base-content/50 shrink-0">
                    {{ workspaceFilesCount }}
                </span>
            </div>
            <div class="flex items-center gap-0.5 pr-1 shrink-0">
                <button type="button" class="btn btn-ghost btn-xs btn-square"
                    :aria-label="$t('workspace.menu.newFile')" :title="$t('workspace.menu.newFile')"
                    @click="onNewWorkspaceFile">
                    <DocumentPlusIcon class="h-4 w-4" />
                </button>
                <button type="button" class="btn btn-ghost btn-xs btn-square"
                    :aria-label="$t('workspace.menu.newDir')" :title="$t('workspace.menu.newDir')"
                    @click="onNewWorkspaceDir">
                    <FolderPlusIcon class="h-4 w-4" />
                </button>
                <button type="button" class="btn btn-ghost btn-xs btn-square"
                    :aria-label="$t('workspace.menu.upload')" :title="$t('workspace.menu.upload')"
                    @click="onUploadWorkspace">
                    <ArrowUpOnSquareIcon class="h-4 w-4" />
                </button>
            </div>
        </div>

        <!-- 主区：workspace 目录树（flex-1 + 内部滚动）；点空白处刷新 -->
        <div class="flex-1 min-h-0 overflow-y-auto" @pointerdown="onBlankAreaPointerDown"
            @click.self="onBlankAreaClick">
            <div v-if="tree.isLoading('')" class="p-3 text-base-content/60">
                <span class="loading loading-spinner loading-xs mr-2" />{{ $t('common.loading') }}
            </div>
            <div v-else-if="tree.errorAt('')" class="p-3 text-error text-xs">
                {{ tree.errorAt('') }}
            </div>
            <div v-else-if="rootResult">
                <FileTreeNode v-for="entry in rootResult.entries" :key="entry.path" :entry="entry" :agent-id="agentId"
                    :on-click="onClickEntry" :on-click-repo-badge="onClickRepoBadge" :depth="0" />
                <div v-if="rootResult.truncated" class="px-3 py-2 text-xs text-warning">
                    ⚠ {{ $t('workspace.truncated') }}
                </div>
            </div>
        </div>

        <!-- 底部：Agent 配置目录折叠区，actions slot 把 + 文件 / + 目录 放进 header；
             resizable = 顶部 handle 可拖动调整高度（持久化到 settings store），与 Git tab History 区同模式 -->
        <CollapsibleSection :title="$t('workspace.agentFiles')"
            :open="panel.bottomSections.value.agentFiles" :count="agentFilesCount"
            :height="panel.agentFilesHeight.value" :min-height="AGENT_FILES_MIN_HEIGHT" resizable
            @toggle="(o: boolean) => panel.setBottomSection('agentFiles', o)"
            @resize="(h: number) => panel.setAgentFilesHeight(h)">
            <template #actions>
                <button type="button" class="btn btn-ghost btn-xs btn-square"
                    :aria-label="$t('workspace.menu.newFile')" :title="$t('workspace.menu.newFile')"
                    @click="onNewAgentFile">
                    <DocumentPlusIcon class="h-4 w-4" />
                </button>
                <button type="button" class="btn btn-ghost btn-xs btn-square"
                    :aria-label="$t('workspace.menu.newDir')" :title="$t('workspace.menu.newDir')"
                    @click="onNewAgentDir">
                    <FolderPlusIcon class="h-4 w-4" />
                </button>
            </template>

            <div v-if="agentFiles.isLoading('')" class="p-3 text-base-content/60">
                <span class="loading loading-spinner loading-xs mr-2" />{{ $t('common.loading') }}
            </div>
            <div v-else-if="agentFiles.errorAt('')" class="p-3 text-error text-xs">
                {{ agentFiles.errorAt('') }}
            </div>
            <div v-else-if="agentRootResult">
                <AgentFileTreeNode v-for="entry in agentRootResult.entries" :key="entry.path" :entry="entry"
                    :agent-id="agentId" :on-click="onClickAgentEntry" :depth="0" />
                <div v-if="agentRootResult.truncated" class="px-3 py-2 text-xs text-warning">
                    ⚠ {{ $t('workspace.truncated') }}
                </div>
                <div v-else-if="agentRootResult.entries.length === 0"
                    class="px-3 py-2 text-xs text-base-content/40">
                    {{ $t('workspace.noAgentFiles') }}
                </div>
            </div>
        </CollapsibleSection>
    </div>
</template>
