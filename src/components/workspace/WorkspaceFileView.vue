<script setup lang="ts">
/**
 * Workspace 专用文件编辑器，基于 monaco-editor。
 *
 * 设计原则（VSCode 体验）：
 * - 打开即可直接编辑，无 view/edit 模式切换
 * - Ctrl/Cmd+S 保存；父组件头部也提供 Save 按钮
 * - dirty 追踪：内容 vs baseline 比对，关闭/切换文件前由父组件 confirm
 * - 二进制 / 截断的文件强制 readOnly（编辑后保存会写入损坏 / 截断数据 → 安全约束，不是 UX 选项）
 * - 图片文件走专用 raw 端点（workspace / agent）拿 blob 后用 <img> 渲染，不走 monaco
 * - HTML 预览（previewMode）用 iframe srcdoc 盖在编辑器之上，内容跟 dirty buffer
 * - SVG 预览（previewMode）源码包成完整 HTML 文档走 iframe srcdoc + 空 sandbox
 *   （无 allow-scripts / allow-same-origin，内嵌脚本/事件处理器一律不执行，比 HTML 更严格）
 * - Markdown 预览（previewMode）复用 chat 的 MarkdownRenderer，与其共享同一个
 *   agent-output 信任边界：markdown-it 默认 html=false 转义裸 HTML / 禁 javascript: scheme，
 *   但 mermaid securityLevel:'loose'、v-html 渲染到主文档是已知风险点（跟 chat 等价）；
 *   相对路径图片不支持（显示破图）
 *
 * defineExpose 给父组件用：
 *   isDirty / isSaving / isBinary / isTruncated / isReadOnly / isImage
 *   previewMode / togglePreview / content / save
 */
import { ref, watch, onMounted, onBeforeUnmount, useTemplateRef, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
    fetchFile, saveFile,
    fetchAgentFile, saveAgentFile,
    fetchAbsoluteFile, saveAbsoluteFile,
    fetchRawFile, isImagePath, previewableExt,
} from '../../composables/workspace-api'
import { useToast } from '../../composables/useToast'
import { useWorkspaceViewer } from '../../composables/useWorkspaceViewer'
import { useWorkspaceGit } from '../../composables/useWorkspaceGit'
import { notifyGitFileSaved } from '../../utils/gitSaveRefresh'
import { monaco, languageFromPath, guessLanguageFromContent, resolveLanguageId, monacoThemeFromDaisy, MONACO_FILE_EDITOR_OPTIONS } from './monaco-setup'
import MarkdownRenderer from '../chat/MarkdownRenderer.vue'

const props = defineProps<{
    /** agentId：workspace/agent scope 需要（走 agent-scoped API）；absolute/text 不用（传空串）。 */
    agentId: string
    /** workspace 相对路径 (scope=workspace) 或 agentDir 相对路径 (scope=agent)。
     *  text 模式无路径，传空串（isTextMode 由 content 判定，不走 loadFile）。 */
    path: string
    /** 直接传入内容（text 只读预览模式），优先于 path：有 content 则跳过 fetch 直接展示。 */
    content?: string
    /** 默认 workspace；走 /file。agent 走 /agent-file，对应 paths.agentDir(id) 下的配置文件。
     *  absolute 走 /api/files/open，任意绝对路径（工具调用返回的真实文件系统路径）。 */
    scope?: 'workspace' | 'agent' | 'absolute'
    /** 强制只读（text 预览模式传 true）。默认 false，文件模式可编辑。 */
    readonly?: boolean
    /** text 模式的语言标签（markdown fence 的 info string，如 'python'）。
     *  优先于 guessLanguageFromContent：代码块全屏按声明的语言高亮，而非靠内容猜。 */
    language?: string
}>()

/** text 只读预览模式：传了 content 即走此分支，跳过 fetch/save/dirty/git。 */
const isTextMode = computed(() => props.content !== undefined)

const scope = computed(() => props.scope ?? 'workspace')
const fetchByScope = (id: string, p: string) =>
    scope.value === 'agent' ? fetchAgentFile(id, p)
        : scope.value === 'absolute' ? fetchAbsoluteFile(p)
            : fetchFile(id, p)
const saveByScope = (id: string, p: string, content: string) =>
    scope.value === 'agent' ? saveAgentFile(id, p, content)
        : scope.value === 'absolute' ? saveAbsoluteFile(p, content)
            : saveFile(id, p, content)

const { t } = useI18n()
const toast = useToast()
const viewer = useWorkspaceViewer()
const git = useWorkspaceGit()

const containerRef = useTemplateRef<HTMLDivElement>('containerRef')
const loading = ref(false)
const error = ref<string | null>(null)

// 暴露给父组件的状态
const isSaving = ref(false)
const isBinary = ref(false)
const isTruncated = ref(false)
/** 图片预览：图片扩展名命中 → 走 raw 获取 blob URL 渲染 <img>（两个 scope 都支持）。 */
const isImage = ref(false)
const imageObjectUrl = ref<string | null>(null)
/** 预览模式（html/svg iframe、md 渲染器）—— true 时预览渲染替换编辑器。
 *  父组件通过 togglePreview() 控制。 */
const previewMode = ref(false)
/** 当前 model 的内容（响应式跟随 monaco onDidChangeModelContent 同步） */
const content = ref('')
/** 上一次 load/save 后的原始内容；用于 dirty 比对 */
const baselineContent = ref('')
const isDirty = computed(() => content.value !== baselineContent.value)
/** 只读条件：强制 readonly / 二进制 / 截断 / load 失败 / 图片 */
const isReadOnly = computed(() => props.readonly || isBinary.value || isTruncated.value || isImage.value || error.value !== null)

let editor: monaco.editor.IStandaloneCodeEditor | null = null
let modelChangeDisposer: monaco.IDisposable | null = null
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

function ensureEditor() {
    if (editor || !containerRef.value) return
    editor = monaco.editor.create(containerRef.value, {
        value: '',
        language: 'plaintext',
        theme: monacoThemeFromDaisy(),
        readOnly: false, // 默认就能编辑（VSCode 风格）
        ...MONACO_FILE_EDITOR_OPTIONS,
    })
    // Ctrl/Cmd+S → save。Monaco 默认会把 Ctrl+S 给 cmd palette 用，addCommand 直接覆盖。
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        save()
    })
}

function disposeEditor() {
    modelChangeDisposer?.dispose()
    modelChangeDisposer = null
    if (editor) {
        const model = editor.getModel()
        editor.dispose()
        model?.dispose()
        editor = null
    }
}

function attachModelChangeListener() {
    modelChangeDisposer?.dispose()
    if (!editor) return
    modelChangeDisposer = editor.onDidChangeModelContent(() => {
        if (!editor) return
        content.value = editor.getValue()
    })
}

/** text 只读预览模式：直接用 props.content 初始化 model，不 fetch、不 save、不 dirty。
 *  由 isTextMode 分支调用（工具结果预览 / 代码块全屏）。 */
function loadText() {
    ensureEditor()
    if (!editor) return
    const text = props.content ?? ''
    const lang = props.language ? resolveLanguageId(props.language) : guessLanguageFromContent(text)
    error.value = null
    isBinary.value = false
    isTruncated.value = false
    isImage.value = false
    previewMode.value = false
    const model = editor.getModel()
    if (model) {
        monaco.editor.setModelLanguage(model, lang)
        model.setValue(text)
    } else {
        editor.setModel(monaco.editor.createModel(text, lang))
    }
    attachModelChangeListener()
    content.value = text
    baselineContent.value = text
    editor.updateOptions({ readOnly: isReadOnly.value })
    editor.setScrollPosition({ scrollTop: 0 })
}

async function loadFile(path: string) {
    if (!path) {
        if (editor) editor.setValue('')
        content.value = ''
        baselineContent.value = ''
        return
    }
    loading.value = true
    error.value = null
    isBinary.value = false
    isTruncated.value = false
    // 重置图片状态：切文件时上一张的 object URL 要释放，避免泄露。
    isImage.value = false
    if (imageObjectUrl.value) {
        URL.revokeObjectURL(imageObjectUrl.value)
        imageObjectUrl.value = null
    }
    // 在 fetch 期间临时强制只读：避免用户在 await 窗口内的输入被随后的 setValue 打丢。
    // load 末尾会按 isReadOnly.value 恢复。
    editor?.updateOptions({ readOnly: true })

    // 图片分支：扩展名命中即可，两个 scope 都走专用 raw 端点。
    //   workspace → /raw，agent → /agent-raw（后端带 workspace/sessions 顶层过滤）。
    //   SVG 不在白名单：避免含脚本的 SVG 在同源下被执行。
    if (isImagePath(path)) {
        try {
            const blob = await fetchRawFile(props.agentId, path, scope.value)
            if (path !== props.path) return
            isImage.value = true
            imageObjectUrl.value = URL.createObjectURL(blob)
            // 图片不过 monaco；baseline/content 置空以免误报 dirty。
            content.value = ''
            baselineContent.value = ''
            editor?.updateOptions({ readOnly: true })
            return
        } catch (e: any) {
            if (path !== props.path) return
            error.value = e?.message || String(e)
            return
        } finally {
            if (path === props.path) loading.value = false
        }
    }

    try {
        const data = await fetchByScope(props.agentId, path)
        // path 可能在 await 期间变化，比对最新 props 防过期响应
        if (path !== props.path) return
        ensureEditor()
        if (!editor) return
        const model = editor.getModel()
        const lang = languageFromPath(path)
        if (data.binary) {
            isBinary.value = true
            // 占位空内容 + 强制只读
            if (model) {
                monaco.editor.setModelLanguage(model, 'plaintext')
                model.setValue('')
            }
            content.value = ''
            baselineContent.value = ''
            editor.updateOptions({ readOnly: true })
            return
        }
        isTruncated.value = data.truncated
        if (model) {
            monaco.editor.setModelLanguage(model, lang)
            model.setValue(data.content)
        } else {
            editor.setModel(monaco.editor.createModel(data.content, lang))
        }
        attachModelChangeListener()
        content.value = data.content
        baselineContent.value = data.content
        // truncated 文件强制只读，正常文件可编辑
        editor.updateOptions({ readOnly: isReadOnly.value })
        editor.setScrollPosition({ scrollTop: 0 })
    } catch (e: any) {
        if (path !== props.path) return
        error.value = e?.message || String(e)
    } finally {
        if (path === props.path) loading.value = false
    }
}

async function save(): Promise<boolean> {
    // load 期间拒绝 save：此时 content/baseline 还是上一个文件的，但 props.path 已是新文件，
    // 直接取 editor.getValue() 写出去会把旧内容覆到新路径 → 静默数据损坏。
    if (!editor || isSaving.value || loading.value) return false
    if (isReadOnly.value) return false
    if (!isDirty.value) return true
    // 三联快照：仅当 await 后 props 未变，才可以把中途的 next 记录为新 baseline。
    const pathAtStart = props.path
    const agentAtStart = props.agentId
    const scopeAtStart = scope.value
    const next = editor.getValue()
    isSaving.value = true
    try {
        await saveByScope(agentAtStart, pathAtStart, next)
        if (
            pathAtStart === props.path
            && agentAtStart === props.agentId
            && scopeAtStart === scope.value
        ) {
            baselineContent.value = next
            content.value = next
            // 通知 git store：保存改了 worktree → status 与 repos 下拉摘要都可能变。
            // 守门：仅 workspace scope（agent scope 与 git 无关）且 store 仍归属本
            // agent（save 网络往返期间可能已切 agent，此时组件已卸载、props 冻结）。
            // 归属门控与 fire-and-forget 语义见 notifyGitFileSaved（utils/gitSaveRefresh）。
            if (scopeAtStart === 'workspace' && git.currentAgentId === agentAtStart) {
                notifyGitFileSaved({ git, agentId: agentAtStart, path: pathAtStart })
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

// 主题跟随 daisyUI：监听 html data-theme 属性变化
function setupThemeObserver() {
    themeObserver = new MutationObserver(() => {
        if (editor) monaco.editor.setTheme(monacoThemeFromDaisy())
    })
    themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
    })
}

// 预览切换：父组件 Preview 按钮调用。
// .html/.md/.svg 都可切换；渲染分支由模板按 previewKind 选择。
const previewKind = computed(() => previewableExt(props.path))

/** SVG 预览的 srcdoc：把 SVG 源码包成完整 HTML 文档。
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

// 容器尺寸变化时（splitter 拖动 / 父级 flex 变化）通知 monaco 重排
function setupResizeObserver() {
    if (!containerRef.value) return
    resizeObserver = new ResizeObserver(() => editor?.layout())
    resizeObserver.observe(containerRef.value)
}

onMounted(() => {
    ensureEditor()
    setupResizeObserver()
    setupThemeObserver()
    if (isTextMode.value) loadText()
    else loadFile(props.path)
})

// path / agentId / scope 变化即重拉
// 同步重置 content/baseline：避免上一个文件的 dirty 状态在 fetch await 窗口内被
// `[isDirty, props.path]` watcher 误认为新文件的 dirty → viewer.dirty 错挂。
// 预览模式也重置：避免从 html 切到别的文件后 Preview 按钮消失但 iframe 残留。
watch(() => [props.agentId, props.path, scope.value], () => {
    if (isTextMode.value) return // text 模式不 fetch
    content.value = ''
    baselineContent.value = ''
    previewMode.value = false
    loadFile(props.path)
})

// text 模式：content 变化重新展示（不 fetch）
watch(() => props.content, () => {
    if (!isTextMode.value) return
    loadText()
})

// 向全局 viewer dirty 同步：跨组件（HomeView session 切换 / workspace tree 切文件）检查未保存丢弃。
// path 变化同步重置，避免上一个文件的 dirty 状态泄露到新文件。
// viewer 是单槽语义（同一时刻只开一个文件），所有 scope（含 absolute）都写全局 store，
// 这样切文件 / session 时 confirm 才能拦住未保存改动；close() 会清理。
watch(
    [isDirty, () => props.path],
    ([dirty, path]) => {
        viewer.setDirty(dirty ? path : null)
    },
    { immediate: true },
)

onBeforeUnmount(() => {
    // 组件卸载（viewer.close 或切出 diff）时主动清一次；
    // viewer.close() 本身也会干这件事，这里是底，防不走 close 路径的卸载场景。
    viewer.setDirty(null)
    resizeObserver?.disconnect()
    themeObserver?.disconnect()
    if (imageObjectUrl.value) {
        URL.revokeObjectURL(imageObjectUrl.value)
        imageObjectUrl.value = null
    }
    disposeEditor()
})

defineExpose({
    isDirty,
    isSaving,
    isBinary,
    isTruncated,
    isReadOnly,
    isImage,
    previewMode,
    togglePreview,
    content,
    save,
})
</script>

<template>
    <div class="relative h-full w-full flex flex-col">
        <!-- 截断 / 二进制 banner：图片不展示 banner（图片需要走专用分支） -->
        <div v-if="isBinary && !isImage" class="bg-warning/10 text-warning text-xs px-3 py-2 border-b border-warning/30 shrink-0">
            ⚠ {{ $t('workspace.binaryFile') }}
        </div>
        <div v-else-if="isTruncated"
            class="bg-warning/10 text-warning text-xs px-3 py-2 border-b border-warning/30 shrink-0">
            ⚠ {{ $t('workspace.fileTruncated') }}
        </div>

        <div class="relative flex-1 min-h-0">
            <!-- 图片：独占容器，居中、等比缩放 -->
            <div v-if="isImage && imageObjectUrl"
                class="absolute inset-0 flex items-center justify-center overflow-auto p-4">
                <img :src="imageObjectUrl" :alt="path"
                    class="max-w-full max-h-full object-contain" />
            </div>

            <!-- HTML 预览：用当前 dirty buffer 走 iframe srcdoc，allow-scripts 但不允许同源。
                 脚本可执行（用户预览自己的文件属预期功能）；沙箱无 allow-same-origin →
                 拿不到主文档/存储，隔离面仍然成立。 -->
            <iframe v-else-if="previewMode && previewKind === 'html'" :srcdoc="content" sandbox="allow-scripts"
                class="absolute inset-0 h-full w-full bg-white border-0"
                :title="path" />

            <!-- SVG 预览：把 SVG 源码包成完整 HTML 文档走 iframe srcdoc。
                 sandbox 不加 allow-scripts → 内嵌 <script> / event handler 一律不执行，消除 SVG XSS 面；
                 同时不加 allow-same-origin → 也无法访问主文档。
                 与 HTML 预览形成对比：SVG 是纯展示，无交互需求，故比 HTML 更严格。 -->
            <iframe v-else-if="previewMode && previewKind === 'svg'"
                :srcdoc="svgSrcDoc"
                sandbox=""
                class="absolute inset-0 h-full w-full bg-white border-0"
                :title="path" />

            <!-- Markdown 预览：复用 chat 的 MarkdownRenderer；v-html 渲染但 markdown-it 默认转义 inline HTML -->
            <div v-else-if="previewMode && previewKind === 'md'"
                class="absolute inset-0 overflow-auto bg-base-100 p-6">
                <MarkdownRenderer :content="content" />
            </div>

            <!-- 编辑器：默认容器；isImage / previewMode 时隐藏，不卸载以避免重创建成本 -->
            <div ref="containerRef" class="h-full w-full"
                :class="{ hidden: isBinary || isImage || previewMode }" />

            <!-- loading 半透明覆盖（不卸载 editor 容器，避免 layout 抖动）-->
            <div v-if="loading"
                class="absolute inset-0 flex items-center justify-center bg-base-100/60 pointer-events-none">
                <span class="loading loading-spinner loading-md text-primary" />
            </div>

            <div v-else-if="error" class="absolute inset-0 flex items-center justify-center p-4 bg-base-100">
                <div class="text-error text-sm font-mono">{{ error }}</div>
            </div>
        </div>
    </div>
</template>
