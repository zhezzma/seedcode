<script setup lang="ts">
/**
 * Workspace Panel 外壳：
 * - 提供 tab 切换 (Files / Git)，子组件用 :key=agentId 跨 agent 强制 remount
 * - 左侧 splitter 拖动调整宽度（240～600）；拖动时用本地 ref 实时刷新视觉，
 *   仅 mouseup 时一次性 persist 到 settings store，避免每像素一次 localStorage 写
 * - 刷新入口：桌面=面板右键菜单（刷新/新建）+ Files 空白左键 + 文件行菜单「刷新」
 *   （共用 useWorkspaceRefresh）；移动端 drawer 顶部保留 🔄/✕ 按钮（无悬浮窗口键，不重叠）
 * - Agent 切换时通过 ensureAgent 守护各 store 归属（条件 reset，同 agent 重挂不清 cache）
 *
 * 模板用单根 `<div class="contents">` 包裹 splitter + aside：Vue 3 多根 SFC 不会
 * fallthrough class 到子节点，外部传入的 `class="hidden lg:flex"` 会静默丢失。
 * `display:contents` 让 wrapper 不参与布局，splitter 与 aside 仍是父 flex 的 item。
 */
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { XMarkIcon, ArrowPathIcon, DocumentPlusIcon, FolderPlusIcon, ArrowUpOnSquareIcon, FolderIcon, CodeBracketIcon, PlusIcon, MinusIcon, ArrowUturnLeftIcon } from '@heroicons/vue/24/outline'
import { useI18n } from 'vue-i18n'
import { useContextMenu, type ContextMenuItem } from '../../composables/useContextMenu'
import { useWorkspaceRefresh } from '../../composables/useWorkspaceRefresh'
import { isDesktopTauri } from '../../utils/environment'
import { runNewFileFlow, runNewDirFlow, runUploadFlow } from '../../composables/useFileActions'
import { useWorkspacePanel, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH } from '../../composables/useWorkspacePanel'
import { useWorkspaceTree } from '../../composables/useWorkspaceTree'
import { useWorkspaceGit } from '../../composables/useWorkspaceGit'
import { useGitBulkActions } from '../../composables/useGitBulkActions'
import { useAgentFiles } from '../../composables/useAgentFiles'
import WorkspaceTabFiles from './WorkspaceTabFiles.vue'
import WorkspaceTabGit from './WorkspaceTabGit.vue'

const props = defineProps<{ agentId: string; mobile?: boolean }>()

const panel = useWorkspacePanel()
const tree = useWorkspaceTree()
const git = useWorkspaceGit()
const agentFiles = useAgentFiles()

// ─── Agent 切换隔离 ──────────────────────────────────────────────
// 数据所有权显式化：三个 store 各自记录 currentAgentId，调用 ensureAgent(id) 在跨 agent 访问
// 时主动 reset，不依赖 watch immediate / 其它实例。——这是唯一的清理路径。
//
// setup 同步调用：在子组件（:key=agentId）创建之前完成，子组件 onMounted 看到的总是属于
// 当前 agent 的 cache。这覆盖了“panel 关闭期间切 agent 后重开”场景（watch 未在场不会触发）。
tree.ensureAgent(props.agentId)
git.ensureAgent(props.agentId)
agentFiles.ensureAgent(props.agentId)

// agent 切换（panel 仍挂载）时走同一路径。flush:'pre' 让 ensureAgent 在子组件 :key 驱动的
// remount 之前完成，避免新组件 onMounted 拉的数据被随后的 reset 清掉。
watch(() => props.agentId, (id) => {
    tree.ensureAgent(id)
    git.ensureAgent(id)
    agentFiles.ensureAgent(id)
}, { flush: 'pre' })

// ─── splitter 拖动 ───────────────────────────────────────────────
// 拖动期间用 dragWidth 驱动 UI，避免每帧 persist 到 localStorage。
// dragWidth 为 null 表示未在拖动，使用 store 里的 width。
const isDragging = ref(false)
const dragWidth = ref<number | null>(null)
let dragStartX = 0
let dragStartWidth = 0

const effectiveWidth = computed(() => dragWidth.value ?? panel.width.value)

function clamp(w: number): number {
    return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.round(w)))
}

function onSplitterMouseDown(e: MouseEvent) {
    isDragging.value = true
    dragStartX = e.clientX
    dragStartWidth = panel.width.value
    dragWidth.value = dragStartWidth
    document.body.style.cursor = 'col-resize'
    e.preventDefault()
}
function onMouseMove(e: MouseEvent) {
    if (!isDragging.value) return
    // panel 在右侧：鼠标向左 → 宽度增加
    const delta = dragStartX - e.clientX
    dragWidth.value = clamp(dragStartWidth + delta)
}
function onMouseUp() {
    if (!isDragging.value) return
    isDragging.value = false
    document.body.style.cursor = ''
    if (dragWidth.value !== null) {
        // 仅在拖动结束时 persist 一次
        panel.setWidth(dragWidth.value)
        dragWidth.value = null
    }
}
function onSplitterDblClick() {
    panel.resetWidth()
    dragWidth.value = null
}

onMounted(() => {
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
})
onUnmounted(() => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    // 防 mid-drag 时面板被退出（Ctrl+B / agent 删除）造成全局鼠标塑形残留
    document.body.style.cursor = ''
})

// ─── 面板刷新（原顶部 🔄 按钮已删：与悬浮窗口键重叠）───
// 全量刷新逻辑抽到 useWorkspaceRefresh（面板右键菜单 / Files tab 空白左键 / 文件行菜单「刷新」共用）
const { isRefreshing, refreshAll } = useWorkspaceRefresh()

// ─── 面板右键菜单 ───
// 文件树行自带右键菜单（行 handler 已 preventDefault），这里用 defaultPrevented
// 区分：只响应面板空白处/git 行的右键，不覆盖行菜单。
// Files tab 下补充根目录新建 / 上传入口；Git tab 下补充暂存所有 / 取消所有暂存 / 丢弃所有
// —— 全面板只有空白菜单 + 文件行菜单两种。
const { t } = useI18n()
const ctxMenu = useContextMenu()

// Git tab 空白菜单的三个批量动作与 WorkspaceTabGit 分组头按钮共用同一实现
//（useGitBulkActions 内含 discard 的树缓存失效 / viewer 重载副作用同步）。
const gitBulk = useGitBulkActions({
    agentId: () => props.agentId,
    repo: () => panel.getRepoForAgent(props.agentId),
})

function onPanelContextMenu(e: MouseEvent) {
    if (props.mobile || e.defaultPrevented) return
    e.preventDefault()
    const items: ContextMenuItem[] = [{
        label: t('common.refresh'),
        icon: ArrowPathIcon,
        action: () => refreshAll(props.agentId, () => props.agentId),
    }]
    if (panel.activeTab.value === 'files') {
        items.push(
            {
                label: t('workspace.menu.newFile'),
                icon: DocumentPlusIcon,
                separator: true,
                action: () => runNewFileFlow({
                    agentId: props.agentId, scope: 'workspace', parentPath: '',
                    onMutated: () => refreshAll(props.agentId, () => props.agentId),
                }),
            },
            {
                label: t('workspace.menu.newDir'),
                icon: FolderPlusIcon,
                action: () => runNewDirFlow({
                    agentId: props.agentId, scope: 'workspace', parentPath: '',
                    onMutated: () => refreshAll(props.agentId, () => props.agentId),
                }),
            },
            {
                label: t('workspace.menu.upload'),
                icon: ArrowUpOnSquareIcon,
                action: () => runUploadFlow({
                    agentId: props.agentId, scope: 'workspace', parentPath: '',
                    onMutated: () => refreshAll(props.agentId, () => props.agentId),
                }),
            },
        )
    } else if (panel.activeTab.value === 'git') {
        items.push(
            {
                label: t('workspace.git.stageAll'),
                icon: PlusIcon,
                separator: true,
                action: () => gitBulk.stageAll(),
            },
            {
                label: t('workspace.git.unstageAll'),
                icon: MinusIcon,
                action: () => gitBulk.unstageAll(),
            },
            {
                label: t('workspace.git.discardAll'),
                icon: ArrowUturnLeftIcon,
                danger: true,
                action: () => gitBulk.discardAll(),
            },
        )
    }
    ctxMenu.openAt(items, { x: e.clientX, y: e.clientY })
}
</script>

<template>
    <!-- 单根 contents wrapper：让外部 class（如 hidden lg:flex）能正确 fallthrough，
         同时不破坏父级 flex 布局——splitter 与 aside 仍直接是 flex item。
         移动端 (mobile=true) 在 daisyUI drawer-side 内嵌套：不需 splitter，宽度由 drawer 控制。 -->
    <div :class="mobile ? 'flex h-full w-full bg-base-200' : 'contents'">
        <!-- splitter：仅 PC 布局需要 -->
        <div v-if="!mobile" class="w-1 cursor-col-resize hover:bg-primary/40 transition-colors shrink-0"
            :class="{ 'bg-primary/40': isDragging }" @mousedown="onSplitterMouseDown" @dblclick="onSplitterDblClick" />

        <!-- panel -->
        <aside class="bg-base-200 flex flex-col shrink-0 overflow-hidden"
            :class="mobile ? 'flex-1 w-full' : 'border-l border-base-300'"
            :style="mobile ? undefined : { width: effectiveWidth + 'px' }"
            @contextmenu="onPanelContextMenu">
            <!-- header: tabs。桌面右侧留白给悬浮窗口键（deep 拖拽使头部空白可拖动窗口/双击最大化）；
                 移动端 drawer 保留刷新/关闭按钮 -->
            <div class="flex items-center justify-between border-b border-base-300 px-2 py-2 shrink-0"
                :data-tauri-drag-region="isDesktopTauri ? 'deep' : undefined">
                <div class="tabs tabs-sm">
                    <a class="tab tab-bordered gap-1" :class="{ 'tab-active': panel.activeTab.value === 'files' }"
                        @click="panel.setTab('files')">
                        <FolderIcon class="h-4 w-4" />
                        <span>{{ $t('workspace.tabFiles') }}</span>
                    </a>
                    <a class="tab tab-bordered gap-1" :class="{ 'tab-active': panel.activeTab.value === 'git' }"
                        @click="panel.setTab('git')">
                        <CodeBracketIcon class="h-4 w-4" />
                        <span>{{ $t('workspace.tabGit') }}</span>
                    </a>
                </div>
                <!-- 仅移动端：桌面端该位置被悬浮窗口键占用 -->
                <div v-if="mobile" class="flex items-center gap-0">
                    <button class="btn btn-ghost btn-xs btn-circle" :title="$t('common.refresh')"
                        :disabled="isRefreshing" @click="refreshAll(props.agentId, () => props.agentId)">
                        <ArrowPathIcon class="h-4 w-4" :class="{ 'animate-spin': isRefreshing }" />
                    </button>
                    <button class="btn btn-ghost btn-xs btn-circle" :title="$t('common.close')" @click="panel.close()">
                        <XMarkIcon class="h-4 w-4" />
                    </button>
                </div>
            </div>

            <!-- content: tab 切换重新挂载组件，但数据在模块级单例中缓存，
                 子组件 onMounted 会检查缓存后决定是否重拉（spec §6.4 “不刷新”）。
                 不用 KeepAlive：避免跨 agent reset 后旧实例 reactivate 读到新 agent 数据交叉污染。
                 滑动管控下放到 tab 内部：history / agent-files 等顶底区需要在 tab 内加 sticky，
                 所以外层不能走 overflow-y-auto。 -->
            <div class="flex-1 min-h-0 overflow-hidden">
                <WorkspaceTabFiles v-if="panel.activeTab.value === 'files'" :key="'files-' + agentId"
                    :agent-id="agentId" />
                <WorkspaceTabGit v-else :key="'git-' + agentId" :agent-id="agentId" />
            </div>
        </aside>
    </div>
</template>
