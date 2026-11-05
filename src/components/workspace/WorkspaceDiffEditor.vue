<script setup lang="ts">
/**
 * VSCode 风格 git diff 编辑器，基于 monaco.editor.createDiffEditor。
 *
 * 设计：
 * - 拉双侧完整文本（fetchFileVersions），交给 monaco 自己计算行级 diff，体验跟 VSCode 一致。
 * - 默认 split（并排）；支持 split / inline 切换，状态持久化在 localStorage（跨 viewer 复用）。
 * - unstaged / untracked 模式下 modified 侧可编辑（VSCode 风格）：右侧即工作区文件，
 *   Ctrl+S / 父组件 Save 按钮走 saveFile 写回；staged / commit 的右侧分别是 index /
 *   commit 内容（不是工作区文件）→ 保持只读。original 侧恒只读。
 * - binary：显示占位；不进入 diff editor。truncated：强制只读（写入截断内容 = 丢数据）。
 * - mode=untracked / 新增文件：原侧为空，monaco 会把整个文件标为新增，符合预期。
 * - props 变化（切换 file/ref）即重拉。
 * - 预览模式（previewMode）：渲染 after（新）侧内容替换 diff 编辑器（html/svg iframe、
 *   md 走 MarkdownRenderer），渲染分支与沙箱策略同 WorkspaceFileView 的 file 模式预览；
 *   内容跟 modified 侧实时值（可编辑 diff 含未保存编辑）。
 *
 * 没有 unified-text fallback：spec 明确要求与 VSCode 风格一致。
 */
import { ref, watch, onMounted, onBeforeUnmount, useTemplateRef, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
    fetchFileVersions,
    fetchDiff,
    saveFile,
    previewableExt,
    type DiffMode,
    type FileVersions,
} from '../../composables/workspace-api'
import { useWorkspaceGit } from '../../composables/useWorkspaceGit'
import { useToast } from '../../composables/useToast'
import { useWorkspaceViewer } from '../../composables/useWorkspaceViewer'
import { notifyGitFileSaved } from '../../utils/gitSaveRefresh'
import { monaco, languageFromPath, monacoThemeFromDaisy } from './monaco-setup'
import MarkdownRenderer from '../chat/MarkdownRenderer.vue'

const props = defineProps<{
    agentId: string
    repo: string
    mode: DiffMode
    file: string
    refSha?: string
}>()

const { t } = useI18n()
const toast = useToast()
const git = useWorkspaceGit()
const viewer = useWorkspaceViewer()

const containerRef = useTemplateRef<HTMLDivElement>('containerRef')
const loading = ref(false)
const error = ref<string | null>(null)
const result = ref<FileVersions | null>(null)

// split / inline 偏好持久化（跨 viewer 实例复用）
const RENDER_SIDE_BY_SIDE_KEY = 'workspace.diff.sideBySide'
function readSideBySidePref(): boolean {
    try {
        const v = localStorage.getItem(RENDER_SIDE_BY_SIDE_KEY)
        if (v === '0') return false
        if (v === '1') return true
    } catch { /* ignore */ }
    return true // default: split
}
const sideBySide = ref(readSideBySidePref())

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
let originalModel: monaco.editor.ITextModel | null = null
let modifiedModel: monaco.editor.ITextModel | null = null
let modifiedDisposer: monaco.IDisposable | null = null
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

// ── 编辑态（仅 editable 时有意义）──
const isSaving = ref(false)
const isDirty = ref(false)
/** 上一次 load / save 落地后的工作区侧内容；modified 侧与之比对得 dirty。 */
let baselineAfter = ''

/** 可编辑门控：仅 unstaged / untracked 的右侧是工作区文件（可写回）；
 *  staged / commit 的右侧分别是 index / commit 内容 → 保持只读（同 VSCode）。
 *  binary 不进编辑器；truncated 内容不完整，写入 = 丢数据 → 强制只读。 */
const editable = computed(() =>
    (props.mode === 'unstaged' || props.mode === 'untracked')
    && !!result.value && !result.value.binary && !result.value.truncated)
/** expose 给父组件的只读态：门控不可编辑即只读（binary/truncated/其他 mode）。 */
const isReadOnly = computed(() => !editable.value)

/** dirty 标识路径（= workspace 相对路径，与 breadcrumb 同拼法）：全局 viewer 单槽
 *  用于切换/关闭前的丢弃确认；save 也用它把 repo 内相对的 props.file 转成
 *  saveFile 需要的 workspace 相对路径（嵌套仓库必须拼 repo 前缀）。 */
const dirtyPath = computed(() =>
    props.repo === '.' ? props.file : `${props.repo}/${props.file}`)

function ensureEditor() {
    if (diffEditor || !containerRef.value) return
    diffEditor = monaco.editor.createDiffEditor(containerRef.value, {
        theme: monacoThemeFromDaisy(),
        // 创建时 result 未到（editable=false）→ 只读；load 落地后按 editable 恢复。
        // fetch 期间保持只读，避免用户输入被随后的 setValue 打丢（同 WorkspaceFileView）。
        readOnly: !editable.value,
        originalEditable: false,
        renderSideBySide: sideBySide.value,
        automaticLayout: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        renderLineHighlight: 'line',
        wordWrap: 'off',
        smoothScrolling: true,
        // diff 专属
        ignoreTrimWhitespace: false,
        renderOverviewRuler: true,
    })
    // Ctrl/Cmd+S → save（绑 modified 侧；original 恒只读无需快捷键）。
    // Monaco 默认把 Ctrl+S 给 cmd palette 用，addCommand 直接覆盖。
    diffEditor.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void save()
    })
}

function disposeEditor() {
    modifiedDisposer?.dispose()
    modifiedDisposer = null
    if (diffEditor) {
        diffEditor.dispose()
        diffEditor = null
    }
    originalModel?.dispose()
    modifiedModel?.dispose()
    originalModel = null
    modifiedModel = null
}

async function load() {
    loading.value = true
    error.value = null
    result.value = null
    const localProps = {
        agentId: props.agentId,
        repo: props.repo,
        mode: props.mode,
        file: props.file,
        refSha: props.refSha,
    }
    try {
        const r = await fetchFileVersions(props.agentId, {
            repo: props.repo,
            mode: props.mode,
            file: props.file,
            ref: props.refSha,
        })
        if (!isCurrent(localProps)) return
        result.value = r
        content.value = r.binary ? '' : (r.after ?? '')
        if (r.binary) return // 二进制：模板走占位分支，不喂 diff editor

        ensureEditor()
        if (!diffEditor) return

        const lang = languageFromPath(props.file)
        // 每次重拉销毁旧 model，避免 dispose 时机不一致引发的 disposed model 异常
        originalModel?.dispose()
        modifiedModel?.dispose()
        originalModel = monaco.editor.createModel(r.before ?? '', lang)
        modifiedModel = monaco.editor.createModel(r.after ?? '', lang)
        diffEditor.setModel({ original: originalModel, modified: modifiedModel })
        // load 落地后按门控恢复可编辑（创建时是只读，fetch 期间输入不被打丢）
        diffEditor.updateOptions({ readOnly: !editable.value })
        // dirty 基线重置：新 load 的 after 即基线；监听须在 createModel 之后 attach，
        // 避免 createModel 之外的早期内容变化被当成编辑。
        baselineAfter = r.after ?? ''
        modifiedDisposer?.dispose()
        modifiedDisposer = modifiedModel.onDidChangeContent(() => {
            if (!modifiedModel) return
            content.value = modifiedModel.getValue()
            isDirty.value = content.value !== baselineAfter
        })
        isDirty.value = false
    } catch (e: any) {
        if (!isCurrent(localProps)) return
        error.value = e?.message || String(e)
    } finally {
        if (isCurrent(localProps)) loading.value = false
    }
}

function isCurrent(snapshot: {
    agentId: string; repo: string; mode: DiffMode; file: string; refSha?: string
}): boolean {
    return snapshot.agentId === props.agentId
        && snapshot.repo === props.repo
        && snapshot.mode === props.mode
        && snapshot.file === props.file
        && snapshot.refSha === props.refSha
}

function toggleSideBySide() {
    sideBySide.value = !sideBySide.value
    try { localStorage.setItem(RENDER_SIDE_BY_SIDE_KEY, sideBySide.value ? '1' : '0') } catch { /* ignore */ }
    diffEditor?.updateOptions({ renderSideBySide: sideBySide.value })
}

// ── 预览（html/svg iframe、md 渲染器）──
/** 预览模式：预览渲染替换 diff 编辑器，父组件通过 togglePreview() 控制。
 *  预览 after（新）侧：unstaged/untracked 是工作区文件（含未保存编辑，同 file 模式
 *  预览跟 dirty buffer 的语义）；staged/commit 是 index/commit 版本。 */
const previewMode = ref(false)
/** modified 侧实时内容（onDidChangeContent 同步），预览渲染用。 */
const content = ref('')
// 预览切换：父组件 Preview 按钮调用；file 是 repo 相对路径，扩展名命中即可预览。
const previewKind = computed(() => previewableExt(props.file))

/** SVG 预览的 srcdoc：把 SVG 源码包成完整 HTML 文档（同 WorkspaceFileView）。
 *  计算属性避免在模板里写多行模板字符串（vue-tsc 对 <template> 内反引号解析易断）。 */
const svgSrcDoc = computed(() => {
    if (previewKind.value !== 'svg') return ''
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;height:100%;background:white;overflow:hidden;display:flex;align-items:center;justify-content:center;">${content.value}</body></html>`
})
function togglePreview() {
    if (previewKind.value === null) return
    previewMode.value = !previewMode.value
}

/** 保存 modified 侧内容回工作区文件（仅 editable 且 dirty 时有效）。
 *  快照防过期：save 网络往返期间可能切文件 / 切 agent，落地前必须校验 props 未变，
 *  否则旧内容会覆到新路径（静默数据损坏，同 WorkspaceFileView.save 的防护）。 */
async function save(): Promise<boolean> {
    if (!diffEditor || !editable.value || isSaving.value || loading.value) return false
    if (!modifiedModel) return false
    const next = modifiedModel.getValue()
    if (next === baselineAfter) return true
    const agentAtStart = props.agentId
    const wsPathAtStart = dirtyPath.value
    isSaving.value = true
    try {
        await saveFile(agentAtStart, wsPathAtStart, next)
        if (agentAtStart === props.agentId && wsPathAtStart === dirtyPath.value) {
            baselineAfter = next
            isDirty.value = modifiedModel.getValue() !== baselineAfter
            // git 刷新守门同 WorkspaceFileView：save 往返期间可能已切 agent
            // （ensureAgent → reset 过），旧 agent 的刷新不得写进新 agent 的 store。
            if (git.currentAgentId === agentAtStart) {
                notifyGitFileSaved({ git, agentId: agentAtStart, path: wsPathAtStart })
            }
        }
        toast.success(t('workspace.fileSaved'))
        return true
    } catch (e: any) {
        toast.error(e?.message || String(e))
        return false
    } finally {
        isSaving.value = false
    }
}

function setupThemeObserver() {
    themeObserver = new MutationObserver(() => {
        if (diffEditor) monaco.editor.setTheme(monacoThemeFromDaisy())
    })
    themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
    })
}

function setupResizeObserver() {
    if (!containerRef.value) return
    resizeObserver = new ResizeObserver(() => diffEditor?.layout())
    resizeObserver.observe(containerRef.value)
}

const showEmptyDiff = computed(() => {
    if (!result.value) return false
    if (result.value.binary) return false
    return (result.value.before ?? '') === (result.value.after ?? '')
})

onMounted(() => {
    ensureEditor()
    setupResizeObserver()
    setupThemeObserver()
    load()
})

watch(
    () => [props.agentId, props.repo, props.mode, props.file, props.refSha],
    () => {
        // 同步重置 dirty/baseline：避免上一个文件的 dirty 在 fetch await 窗口内
        // 以新路径写进全局 dirty 槽（fetch 失败时不重置则永久残留）。重拉落地后
        // 按新 baseline 重算。WorkspaceFileView 修过一模一样的 bug（同款防护）。
        isDirty.value = false
        baselineAfter = ''
        // 预览模式与内容同步重置：避免切到不可预览文件后 Preview 按钮消失但 iframe 残留
        //（同 WorkspaceFileView 的 path 切换重置）。
        previewMode.value = false
        content.value = ''
        load()
    },
)

// dirty 接入全局 viewer 单槽：跨组件（session 切换 / workspace 树切换）检查未保存丢弃。
// props 变化（切文件）时 load() 会重置 isDirty → watch 同步清槽。
watch(
    [isDirty, dirtyPath],
    () => {
        viewer.setDirty(isDirty.value ? dirtyPath.value : null)
    },
    { immediate: true },
)

onBeforeUnmount(() => {
    // 组件卸载时主动清一次全局 dirty 槽（viewer.close() 也会干，这里是底）。
    viewer.setDirty(null)
    resizeObserver?.disconnect()
    themeObserver?.disconnect()
    disposeEditor()
})

/** 复制用：按需拉取 git 原生 unified diff 文本（与编辑器内的行级 diff 计算无关，
 *  以 git 输出为准）。失败抛错由调用方提示；后端有字节上限截断保护。 */
async function getUnifiedDiff(): Promise<string> {
    const r = await fetchDiff(props.agentId, {
        repo: props.repo,
        mode: props.mode,
        file: props.file,
        ref: props.refSha,
    })
    return r.diff ?? ''
}

defineExpose({
    sideBySide,
    toggleSideBySide,
    previewMode,
    togglePreview,
    getUnifiedDiff,
    isDirty,
    isSaving,
    save,
    isEditable: editable,
    isReadOnly,
})
</script>

<template>
    <div class="relative h-full w-full flex flex-col">
        <!-- 顶部 banner -->
        <div v-if="result?.binary" class="bg-warning/10 text-warning text-xs px-3 py-2 border-b border-warning/30 shrink-0">
            ⚠ {{ t('workspace.binaryFile') }}
        </div>
        <div v-else-if="result?.truncated"
            class="bg-warning/10 text-warning text-xs px-3 py-2 border-b border-warning/30 shrink-0">
            ⚠ {{ t('workspace.fileTruncated') }}
        </div>

        <div class="relative flex-1 min-h-0">
            <!-- 预览（after 侧实时内容，可编辑 diff 含未保存编辑）：渲染分支与沙箱策略
                 同 WorkspaceFileView 的 file 模式预览。 -->
            <iframe v-if="previewMode && previewKind === 'html'" :srcdoc="content" sandbox="allow-scripts"
                class="absolute inset-0 h-full w-full bg-white border-0"
                :title="file" />
            <iframe v-else-if="previewMode && previewKind === 'svg'" :srcdoc="svgSrcDoc" sandbox=""
                class="absolute inset-0 h-full w-full bg-white border-0"
                :title="file" />
            <div v-else-if="previewMode && previewKind === 'md'"
                class="absolute inset-0 overflow-auto bg-base-100 p-6">
                <MarkdownRenderer :content="content" />
            </div>

            <div ref="containerRef" class="h-full w-full" :class="{ hidden: result?.binary || previewMode }" />

            <div v-if="loading"
                class="absolute inset-0 flex items-center justify-center bg-base-100/60 pointer-events-none">
                <span class="loading loading-spinner loading-md text-primary" />
            </div>

            <div v-else-if="error" class="absolute inset-0 flex items-center justify-center p-4 bg-base-100">
                <div class="text-error text-sm font-mono">{{ error }}</div>
            </div>

            <div v-else-if="result?.binary"
                class="absolute inset-0 flex items-center justify-center text-base-content/60 text-sm">
                {{ t('workspace.binaryFile') }}
            </div>

            <div v-else-if="showEmptyDiff"
                class="absolute inset-0 flex items-center justify-center text-base-content/60 text-sm pointer-events-none">
                {{ t('workspace.diffNoChanges') }}
            </div>
        </div>
    </div>
</template>
