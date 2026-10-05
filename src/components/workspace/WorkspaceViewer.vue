<script setup lang="ts">
/**
 * Viewer 模式容器：替换聊天区显示文件内容或 diff。
 *
 * 头部：
 * - 返回（带 dirty 确认）
 * - 面包屑（dirty 圆点提示）
 * - file 模式：Save 按钮（dirty 时高亮，readOnly 时禁用）
 * - diff 模式：unstaged/untracked 可编辑 → Save 按钮（dirty 高亮）；Split/Inline toggle
 *
 * 快捷键：
 * - Esc 关闭（带 dirty 确认）
 * - Ctrl/Cmd+S 保存（file 与可编辑 diff 均可：子组件 monaco command + viewer 级监听双路径处理）
 *
 * 路由：
 * - target.type === 'file' → WorkspaceFileView (默认就能编辑，VSCode 风格)
 * - target.type === 'diff' → WorkspaceDiffEditor (monaco diff editor)
 */
import { onMounted, onUnmounted, computed, ref, watch, nextTick, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
    ArrowLeftIcon,
    DocumentCheckIcon,
    EyeIcon,
    EyeSlashIcon,
    ViewColumnsIcon,
    Bars3Icon,
    ClipboardDocumentIcon,
} from '@heroicons/vue/24/outline'
import WorkspaceFileView from './WorkspaceFileView.vue'
import WorkspaceDiffEditor from './WorkspaceDiffEditor.vue'
import ViewHeader from '../ViewHeader.vue'
import { previewableExt } from '../../composables/workspace-api'
import { useWorkspaceViewer } from '../../composables/useWorkspaceViewer'
import { useConfirm } from '../../composables/useConfirm'
import { useToast } from '../../composables/useToast'
import { writeClipboard } from '../../utils/clipboard'

const props = defineProps<{
    agentId: string
    /** Workspace 面板可见时（占据窗口右侧全高），悬浮窗口键压在面板上而非 viewer 顶栏，无需预留（同 ChatHeader） */
    panelVisible?: boolean
}>()
const viewer = useWorkspaceViewer()
const { confirm } = useConfirm()
const { t } = useI18n()

const rootRef = ref<HTMLDivElement | null>(null)
const fileViewRef = useTemplateRef<InstanceType<typeof WorkspaceFileView>>('fileViewRef')
const diffViewRef = useTemplateRef<InstanceType<typeof WorkspaceDiffEditor>>('diffViewRef')

const target = computed(() => viewer.current.value)

const breadcrumb = computed(() => {
    const tgt = target.value
    if (!tgt) return ''
    if (tgt.type === 'file') return tgt.path
    if (tgt.type === 'agent-file') return `agent / ${tgt.path}`
    if (tgt.type === 'absolute') return tgt.path
    if (tgt.type === 'text') return tgt.title || t('fileViewer.preview')
    if (tgt.type === 'diff') {
        const sha = tgt.ref ? ` @ ${tgt.ref.slice(0, 7)}` : ''
        // 根仓库（"."）不显示 ". /" 前缀（repoJoin 同语义）；子仓保留 "repo / file" 排版
        return tgt.repo === '.' ? `${tgt.file}${sha}` : `${tgt.repo} / ${tgt.file}${sha}`
    }
    return ''
})

// ── file 模式按钮状态：通过 fileViewRef.value 直接读 expose 的 ref ──
const isFileMode = computed(() =>
    target.value?.type === 'file' || target.value?.type === 'agent-file' || target.value?.type === 'absolute',
)
const fileIsDirty = computed(() => fileViewRef.value?.isDirty ?? false)
const fileIsSaving = computed(() => fileViewRef.value?.isSaving ?? false)
const fileIsReadOnly = computed(() => fileViewRef.value?.isReadOnly ?? false)
const fileSaveDisabled = computed(() =>
    fileIsReadOnly.value || fileIsSaving.value || !fileIsDirty.value,
)

// 预览按钮：仅在当前文件是 .html/.htm/.md/.markdown/.svg 时显示。
// 避免按钮常驻 disable 造成视觉噪音。
// previewableExt 从 workspace-api 导入，与子组件 togglePreview 共用同一权威源。
const previewKind = computed(() => {
    const tgt = target.value
    if (!tgt || (tgt.type !== 'file' && tgt.type !== 'agent-file' && tgt.type !== 'absolute')) return null
    return previewableExt(tgt.path)
})
const showPreviewButton = computed(() => previewKind.value !== null)
const filePreviewMode = computed(() => fileViewRef.value?.previewMode ?? false)

// ── diff 模式按钮状态 ──
const diffSideBySide = computed(() => diffViewRef.value?.sideBySide ?? true)
// diff 可编辑后的保存态（unstaged/untracked 才 expose isEditable=true）；
// 只读 diff（staged/commit）不显示 Save。与 file 模式同一套 disabled 逻辑。
const diffIsEditable = computed(() => diffViewRef.value?.isEditable ?? false)
const diffIsReadOnly = computed(() => diffViewRef.value?.isReadOnly ?? true)
const diffIsDirty = computed(() => diffViewRef.value?.isDirty ?? false)
const diffIsSaving = computed(() => diffViewRef.value?.isSaving ?? false)
const diffSaveDisabled = computed(() =>
    diffIsReadOnly.value || diffIsSaving.value || !diffIsDirty.value)

async function confirmDiscardIfDirty(): Promise<boolean> {
    if (isFileMode.value) {
        if (!fileIsDirty.value) return true
        return await confirm(t('workspace.unsavedChanges'), t('common.confirm'))
    }
    // diff 可编辑后（unstaged/untracked）同样有未保存改动，丢弃前必须确认
    if (target.value?.type === 'diff' && diffIsDirty.value) {
        return await confirm(t('workspace.unsavedChanges'), t('common.confirm'))
    }
    return true
}

async function close() {
    // 保存进行中先等落地：此时 isDirty 仍为 true，直接弹「丢弃确认」的话，
    // 用户确认丢弃的却是已写盘的改动（保存续体照常完成）—— 语义矛盾。
    // 轮询等待即可（本地保存通常亚秒级）；上限 10s 防网络挂起永久卡住关闭。
    // 快照发起关闭时的目标：等待期间用户可能已从树点开新文件（旧文件的 dirty
    // 确认后切 path）——关闭意图已被新操作取代，保存落地后不能把用户刚打开的
    // 新文件关掉。
    const startTarget = viewer.current.value
    let waitMs = 0
    while ((fileViewRef.value?.isSaving === true || diffViewRef.value?.isSaving === true) && waitMs < 10_000) {
        await new Promise(r => setTimeout(r, 50))
        waitMs += 50
        if (viewer.current.value !== startTarget) return
    }
    if (viewer.current.value !== startTarget) return
    if (!await confirmDiscardIfDirty()) return
    viewer.close()
}

async function onClickSave() {
    if (!fileViewRef.value) return
    await fileViewRef.value.save()
}

/** diff 模式保存（unstaged/untracked 的 modified 侧 → 工作区文件）。 */
async function onClickSaveDiff() {
    if (!diffViewRef.value) return
    await diffViewRef.value.save()
}

/** 复制当前内容到剪贴板（file 模式）。content 是编辑器实时内容，含未保存修改。 */
async function onClickCopy() {
    const text = fileViewRef.value?.content ?? ''
    if (!text) return
    try {
        await writeClipboard(text)
        useToast().success(t('common.copied'))
    } catch {
        // 剪贴板权限失败：静默即可（浏览器/WebView 受限场景罕见）
    }
}

function onClickPreview() {
    // .html / .md / .svg 都可切换；子组件根据当前文件选渲染分支。
    if (previewKind.value === null) return
    fileViewRef.value?.togglePreview()
}

function onClickToggleSplit() {
    diffViewRef.value?.toggleSideBySide()
}

/** 复制 diff 模式的 unified diff 文本（git 原生输出，按需拉取）。 */
const isCopyingDiff = ref(false)
async function onClickCopyDiff() {
    if (!diffViewRef.value || isCopyingDiff.value) return
    isCopyingDiff.value = true
    try {
        const text = await diffViewRef.value.getUnifiedDiff()
        if (!text) return
        await writeClipboard(text)
        useToast().success(t('common.copied'))
    } catch {
        // 拉取 diff 走网络，失败给出可感知提示（与 file 复制仅剪贴板静默失败不同）
        useToast().error(t('common.networkError'))
    } finally {
        isCopyingDiff.value = false
    }
}

async function onEscape(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    if (e.isComposing) return
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    e.preventDefault()
    await close()
}

/** 全局 Ctrl/Cmd+S：monaco 的 addCommand 仅在 editor 获焦时生效，
 *  用户点过面包屑 / Save 按钮区 / 刚切完 tree 等场景下焦点不在 editor，
 *  默认 Ctrl+S 会被浏览器吃授成“保存网页”，这里在 viewer 范围内兼负。 */
async function onSaveShortcut(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey)) return
    if (e.key !== 's' && e.key !== 'S') return
    if (e.isComposing) return
    // 可编辑 diff 也要走 viewer 级 Ctrl+S：焦点不在 editor 时 monaco command 不生效
    if (!isFileMode.value && !diffIsEditable.value) return
    e.preventDefault()
    if (isFileMode.value) {
        await fileViewRef.value?.save()
    } else {
        await diffViewRef.value?.save()
    }
}

async function focusRoot() {
    await nextTick()
    rootRef.value?.focus()
}

onMounted(() => {
    document.addEventListener('keydown', onEscape)
    document.addEventListener('keydown', onSaveShortcut)
    focusRoot()
})
onUnmounted(() => {
    document.removeEventListener('keydown', onEscape)
    document.removeEventListener('keydown', onSaveShortcut)
})

// 切换 target 时重新 focus，避免中途用户点过 ChatInput textarea 导致 Esc 被 textarea 吞掉。
watch(target, () => {
    if (target.value) focusRoot()
})
</script>

<template>
    <div ref="rootRef" tabindex="-1" role="region" :aria-label="breadcrumb || $t('workspace.tabFiles')"
        class="flex flex-col h-full bg-base-100 outline-none">
        <!-- 顶栏复用 ViewHeader：wcPad 避让右上角悬浮窗口键组（pr-[144px]），
             桌面端自带 drag region（拖动/双击最大化），规格与全局顶栏统一 -->
        <ViewHeader :wc-pad="!panelVisible">
            <template #left>
                <button class="btn btn-ghost btn-sm btn-circle" :title="$t('common.back')" @click="close()">
                    <ArrowLeftIcon class="h-5 w-5" />
                </button>
            </template>
            <template #title>
                <!-- max-w：移动端标题视觉上限（同 ChatHeader）；正确性由 ViewHeader 左区容器
                     min-w-0 兜底（容器可缩 → 截断必生效，按钮不会被挤出视口）。
                     dirty 点放 truncate 元素外（shrink-0），路径截断时不被一起裁掉 -->
                <div class="flex-1 min-w-0 flex items-center gap-1 max-w-[150px] lg:max-w-none">
                    <span class="min-w-0 truncate text-sm font-mono text-base-content/70" :title="breadcrumb">{{ breadcrumb }}</span>
                    <span v-if="(isFileMode && fileIsDirty) || diffIsDirty" class="text-warning shrink-0">●</span>
                </div>
            </template>
            <template #actions>
                <!-- file 模式：Save + （按需）Preview；workspace 与 agent 两种 scope 共用 -->
                <template v-if="isFileMode">
                    <button v-if="showPreviewButton" class="btn btn-sm gap-1"
                        :class="filePreviewMode ? 'btn-primary' : 'btn-ghost'"
                        :title="filePreviewMode ? $t('workspace.previewExit') : $t('workspace.preview')"
                        @click="onClickPreview">
                        <EyeSlashIcon v-if="filePreviewMode" class="h-4 w-4" />
                        <EyeIcon v-else class="h-4 w-4" />
                        <span class="hidden md:inline text-xs">
                            {{ filePreviewMode ? $t('workspace.previewExit') : $t('workspace.preview') }}
                        </span>
                    </button>
                    <button class="btn btn-ghost btn-sm gap-1" :title="$t('common.copy')"
                        :disabled="!fileViewRef?.content" @click="onClickCopy">
                        <ClipboardDocumentIcon class="h-4 w-4" />
                        <span class="hidden md:inline text-xs">{{ $t('common.copy') }}</span>
                    </button>
                    <button class="btn btn-sm gap-1"
                        :class="fileIsDirty && !fileIsReadOnly ? 'btn-primary' : 'btn-ghost'"
                        :disabled="fileSaveDisabled" :title="$t('workspace.save') + ' (Ctrl+S)'"
                        @click="onClickSave">
                        <DocumentCheckIcon class="h-4 w-4" />
                        <span class="hidden md:inline text-xs">
                            {{ fileIsSaving ? $t('workspace.saving') : $t('workspace.save') }}
                        </span>
                    </button>
                </template>

                <!-- diff 模式按钮：Save（仅可编辑）+ Copy unified diff + Split / Inline 切换 -->
                <template v-else-if="target?.type === 'diff'">
                    <button v-if="diffIsEditable" class="btn btn-sm gap-1"
                        :class="diffIsDirty && !diffIsReadOnly ? 'btn-primary' : 'btn-ghost'"
                        :disabled="diffSaveDisabled" :title="$t('workspace.save') + ' (Ctrl+S)'"
                        @click="onClickSaveDiff">
                        <DocumentCheckIcon class="h-4 w-4" />
                        <span class="hidden md:inline text-xs">
                            {{ diffIsSaving ? $t('workspace.saving') : $t('workspace.save') }}
                        </span>
                    </button>
                    <button class="btn btn-ghost btn-sm gap-1" :title="$t('common.copy')"
                        :disabled="isCopyingDiff" @click="onClickCopyDiff">
                        <ClipboardDocumentIcon class="h-4 w-4" />
                        <span class="hidden md:inline text-xs">{{ $t('common.copy') }}</span>
                    </button>
                    <button class="btn btn-ghost btn-sm gap-1"
                        :title="diffSideBySide ? $t('workspace.diffInline') : $t('workspace.diffSplit')"
                        @click="onClickToggleSplit">
                        <ViewColumnsIcon v-if="!diffSideBySide" class="h-4 w-4" />
                        <Bars3Icon v-else class="h-4 w-4" />
                        <span class="hidden md:inline text-xs">
                            {{ diffSideBySide ? $t('workspace.diffInline') : $t('workspace.diffSplit') }}
                        </span>
                    </button>
                </template>
            </template>
        </ViewHeader>

        <div class="flex-1 min-h-0 overflow-hidden">
            <WorkspaceFileView v-if="target?.type === 'file'" ref="fileViewRef" :agent-id="agentId"
                :path="target.path" scope="workspace" />
            <WorkspaceFileView v-else-if="target?.type === 'agent-file'" ref="fileViewRef" :agent-id="agentId"
                :path="target.path" scope="agent" />
            <!-- absolute：任意绝对路径（工具调用返回）或 /assets URL，不需要 agentId；
                 文本走 /api/files/open，图片由 fetchRawFile 分流（/assets 直连公开端点） -->
            <WorkspaceFileView v-else-if="target?.type === 'absolute'" ref="fileViewRef" agent-id=""
                :path="target.path" scope="absolute" />
            <!-- text：纯文本只读预览（工具结果 / 代码块全屏），复用 WorkspaceFileView + readonly，无路径/agentId -->
            <WorkspaceFileView v-else-if="target?.type === 'text'" ref="fileViewRef" agent-id="" path="" :content="target.content" :language="target.language" readonly />
            <WorkspaceDiffEditor v-else-if="target?.type === 'diff'" ref="diffViewRef" :agent-id="agentId"
                :repo="target.repo" :mode="target.mode" :file="target.file" :ref-sha="target.ref" />
        </div>
    </div>
</template>
