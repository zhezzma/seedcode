<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import md from '../../utils/markdown/markdown'
import { resolveMarkdownResourceUrls } from '../../utils/media-url'
import { useUiSettingsStore } from '../../stores/setting'
import { useMediaPreview } from '../../composables/useMediaPreview'
import { mediaKindFromPath } from '../../composables/workspace-api'
import { reservedImageStyle, recordImageElementDimensions } from '../../utils/imageDimensions'

const props = defineProps<{
    content: string
}>()

const settings = useUiSettingsStore()
const { t } = useI18n()
const { openLightbox, downloadImage, downloadMedia } = useMediaPreview()
const renderedHtml = ref('')
const isRendering = ref(false)
const contentElement = ref<HTMLElement | null>(null)

const downloadIcon = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>'

const enhanceRenderedImages = () => {
    const container = contentElement.value
    if (!container) return

    container.querySelectorAll<HTMLImageElement>('img').forEach(image => {
        // 尺寸缓存：v-html 每次重渲染都是全新 <img>，从 0 高度重新异步加载——
        // 不预留空间会让行高在 0 → 全高之间跳变（图片密集会话滚动被拽的根因）。
        // 已加载完的记录尺寸；未加载的挂一次性 load 记录；命中缓存立即预留。
        if (image.complete && image.naturalWidth > 0) {
            recordImageElementDimensions(image)
        } else {
            image.addEventListener('load', () => {
                recordImageElementDimensions(image)
                // 同 src 被复用但内容重生成（自然尺寸变化）：用新比率即时修正
                // inline 预留，避免过期 aspect-ratio 拉伸变形直到下次重渲染
                const fresh = reservedImageStyle(image.currentSrc || image.src)
                image.style.aspectRatio = fresh ? fresh.aspectRatio : ''
            }, { once: true })
        }
        const reserved = reservedImageStyle(image.currentSrc || image.src)
        if (reserved) image.style.aspectRatio = reserved.aspectRatio

        if (image.closest('.markdown-image-preview')) return

        const linkedImage = image.closest('a')
        const previewTarget = linkedImage || image
        const parent = previewTarget.parentNode
        if (!parent) return

        const wrapper = document.createElement('span')
        wrapper.className = 'markdown-image-preview'
        parent.insertBefore(wrapper, previewTarget)
        wrapper.appendChild(previewTarget)

        if (!linkedImage) {
            image.tabIndex = 0
            image.setAttribute('role', 'button')
            image.setAttribute('aria-label', image.alt || t('common.clickToView'))
        }

        const downloadButton = document.createElement('button')
        downloadButton.type = 'button'
        downloadButton.dataset.markdownImageDownload = ''
        downloadButton.setAttribute('aria-label', t('chat.downloadImage'))
        downloadButton.innerHTML = downloadIcon
        wrapper.appendChild(downloadButton)
    })
}

/** 流式重渲染的播放续接快照：v-html 重写会销毁重建 <audio>/<video>（流式期间
 *  每个 chunk 一次、同步/异步渲染双发），正在播放的媒体被打断从 0 重播。
 *  赋值 renderedHtml 前从旧 DOM 取快照，新 DOM 升级完成后按 src 续接
 *  （进度 + 恢复播放；无手势环境下 play() 可能被拒，至少进度保住）。 */
interface PlayingMediaSnapshot {
    src: string
    time: number
}

const snapshotPlayingMedia = (): PlayingMediaSnapshot[] => {
    const container = contentElement.value
    if (!container) return []
    return Array.from(container.querySelectorAll<HTMLMediaElement>('.markdown-body audio, .markdown-body video'))
        .filter(el => !el.paused)
        .map(el => ({ src: el.currentSrc || el.src, time: el.currentTime }))
}

const restorePlayingMedia = (snapshots: PlayingMediaSnapshot[]) => {
    if (snapshots.length === 0) return
    const container = contentElement.value
    if (!container) return
    for (const snapshot of snapshots) {
        const media = Array.from(container.querySelectorAll<HTMLMediaElement>('.markdown-body audio, .markdown-body video'))
            .find(el => (el.currentSrc || el.src) === snapshot.src)
        if (!media) continue
        media.currentTime = snapshot.time
        void media.play().catch(() => {
            // DOM 重建后新元素未被用户手势「祝福」，自动续播被拒绝：保持暂停在原进度
        })
    }
}

/** Markdown 音视频链接就地升级为原生播放器（generate_sound 产物 / 会话里粘贴的
 *  媒体 URL）。图片靠 <img> 原生渲染 + enhanceRenderedImages 包装；音视频链接若
 *  保持 <a target=_blank> 形态，点击会跳出聊天上下文——这里换成 <audio>/<video>
 *  控件直接长在气泡里：preload=metadata 翻历史不拉全量字节、/assets 不可变强缓存
 *  二次播放瞬时命中、判定复用 workspace-api 的 mediaKindFromPath（与后端
 *  media-whitelist 同步的清单）。与图片共用 .markdown-image-preview 包装，
 *  复用同一套 hover 下载按钮样式与交互。 */
const enhanceRenderedMedia = () => {
    // apiBaseUrl 为空时保持 <a> 链接形态：升级成 <audio src> 会拼出指向当前
    // origin（tauri://localhost）的死链，链接至少可见可诊断（与图片渲染同等待遇）
    if (!settings.apiBaseUrl.trim()) return
    const container = contentElement.value
    if (!container) return

    container.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(link => {
        // 已包装的链接图片（enhanceRenderedImages 先跑）不在此列
        if (link.closest('.markdown-image-preview')) return
        const kind = mediaKindFromPath(link.getAttribute('href') || '')
        // 仅音视频：图片链接（[文本](x.png)）交给 enhanceRenderedImages 的 linked-image
        // 分支（lightbox 预览），不在这里内联——createElement('image') 是无效标签
        if (kind !== 'audio' && kind !== 'video') return

        // href 已过 resolveMarkdownResourceUrls（apiBaseUrl 拼接）；DOM property
        // 再由浏览器按当前 origin 归一为绝对地址，与图片 enhance 的 src 同源语义
        const src = link.href
        const media = document.createElement(kind)
        media.src = src
        media.controls = true
        media.preload = 'metadata'
        if (media instanceof HTMLVideoElement) media.playsInline = true
        media.setAttribute('aria-label', link.textContent?.trim() || kind)
        // 一次只播一个：暂停同文档所有 markdown 容器（.markdown-body）里的其他媒体——
        // 选择器是 document 作用域，跨 MarkdownRenderer 实例（主聊天、引用预览等）
        // 都会互斥；聊天外的音频元素（语音聊天等）不受影响。全局单播是预期 UX。
        media.addEventListener('play', () => {
            document.querySelectorAll<HTMLMediaElement>('.markdown-body audio, .markdown-body video').forEach(el => {
                if (el !== media && !el.paused) el.pause()
            })
        })

        const wrapper = document.createElement('span')
        // 额外标记类：音视频 wrapper 转 block（CSS .markdown-media-preview）。
        // 根因：inline-block shrink-to-fit 与 audio width:100% 循环参照，播放器
        // 塌缩成 ~30px 的内在最小宽度（preload=metadata 未加载时尤甚）→ 界面呈现
        // 为一片空白；block 让 width:100% 拿到确定的参照宽度（气泡内容宽）。
        wrapper.className = 'markdown-image-preview markdown-media-preview'
        link.parentNode?.insertBefore(wrapper, link)
        wrapper.appendChild(media)

        const downloadButton = document.createElement('button')
        downloadButton.type = 'button'
        downloadButton.dataset.markdownImageDownload = ''
        downloadButton.setAttribute('aria-label', t('chat.downloadMedia'))
        downloadButton.innerHTML = downloadIcon
        wrapper.appendChild(downloadButton)

        // 链接使命完成（链接文本转为播放器 aria-label），避免重复升级（a 不存在即幂等）
        link.remove()
    })
}

const setRenderedHtml = async (html: string) => {
    // 快照必须在 v-html 重写前取（旧 DOM 还在）；新 DOM 升级完成后按 src 续接播放
    const playing = snapshotPlayingMedia()
    renderedHtml.value = resolveMarkdownResourceUrls(html, settings.apiBaseUrl)
    await nextTick()
    enhanceRenderedImages()
    enhanceRenderedMedia()
    restorePlayingMedia(playing)
}

const handleContentClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const downloadButton = target.closest('[data-markdown-image-download]')
    if (downloadButton) {
        event.preventDefault()
        event.stopPropagation()
        const image = downloadButton.parentElement?.querySelector('img')
        if (image instanceof HTMLImageElement) {
            downloadImage(image.currentSrc || image.src)
            return
        }
        // 音视频播放器同款按钮：img 之后回退查 <audio>/<video>（media.src 为已解析的绝对地址）
        const media = downloadButton.parentElement?.querySelector('audio, video')
        if (media instanceof HTMLMediaElement) {
            downloadMedia(media.currentSrc || media.src)
        }
        return
    }

    if (!(target instanceof HTMLImageElement)) return

    event.preventDefault()
    openLightbox(target.currentSrc || target.src)
}

const handleContentKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return

    const target = event.target
    if (!(target instanceof Element) || target.closest('[data-markdown-image-download]')) return

    const image = target instanceof HTMLImageElement
        ? target
        : target instanceof HTMLAnchorElement && target.parentElement?.classList.contains('markdown-image-preview')
            ? target.querySelector('img')
            : null
    if (!(image instanceof HTMLImageElement)) return

    event.preventDefault()
    openLightbox(image.currentSrc || image.src)
}

const renderContent = async (text: string) => {
    isRendering.value = true
    try {
        // First pass: synchronous render to avoid layout shift/flash
        // This ensures content is visible immediately
        const syncHtml = md.renderSync(text || '')

        // Use sync render immediately to feel responsive
        if (syncHtml) {
            await setRenderedHtml(syncHtml)
        }

        // Second pass: async worker render (if needed for complex features or just to be safe)
        // In many cases sync render is enough, but worker might have more features enabled
        const workerHtml = await md.render(text || '')
        if (workerHtml && workerHtml !== syncHtml) {
            await setRenderedHtml(workerHtml)
        }
    } catch (error) {
        console.error('Markdown render error:', error)
        // Fallback to basic text or sync render
        await setRenderedHtml(md.renderSync(text || ''))
    } finally {
        isRendering.value = false
    }
}

watch([() => props.content, () => settings.apiBaseUrl], ([newContent]) => {
    renderContent(newContent)
}, { immediate: true })

onMounted(() => {
    renderContent(props.content)
})
</script>

<template>
    <div ref="contentElement" class="markdown-body" v-html="renderedHtml" @click="handleContentClick"
        @keydown="handleContentKeydown"></div>
</template>

<style scoped>
.markdown-body :deep(.markdown-image-preview) {
    position: relative;
    display: inline-block;
    max-width: 100%;
    vertical-align: top;
}

.markdown-body :deep(.markdown-image-preview img) {
    display: block;
    cursor: pointer;
}

/* 音视频 wrapper 转 block：inline-block 的 shrink-to-fit 会与 audio 的 width:100%
   循环参照，播放器塌缩到内在最小宽度（手机上呈现为空白）；block 撑满气泡内容宽。
   图片 wrapper 维持 inline-block（与文字混排语义）。 */
.markdown-body :deep(.markdown-media-preview) {
    display: block;
}

/* 音视频内嵌播放器：宽度跟随气泡、限制最大宽度避免长播放条撜满整行；
   高度固定（audio ~54px），不像图片有 0→全高跳变，无需 aspect-ratio 预留 */
.markdown-body :deep(.markdown-image-preview audio) {
    display: block;
    width: 100%;
    max-width: 26rem;
}

.markdown-body :deep(.markdown-image-preview video) {
    display: block;
    width: 100%;
    max-width: 35rem;
    border-radius: 0.5rem;
}

.markdown-body :deep([data-markdown-image-download]) {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 10;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0.375rem;
    border: 1px solid rgb(255 255 255 / 20%);
    border-radius: 9999px;
    color: white;
    background: rgb(0 0 0 / 40%);
    backdrop-filter: blur(4px);
    cursor: pointer;
    transition: opacity 0.2s, background-color 0.2s;
}

.markdown-body :deep([data-markdown-image-download] svg) {
    width: 1rem;
    height: 1rem;
}

.markdown-body :deep([data-markdown-image-download]:hover) {
    background: rgb(0 0 0 / 60%);
}

@media (min-width: 768px) {
    .markdown-body :deep([data-markdown-image-download]) {
        opacity: 0;
    }

    .markdown-body :deep(.markdown-image-preview:hover [data-markdown-image-download]),
    .markdown-body :deep(.markdown-image-preview:focus-within [data-markdown-image-download]) {
        opacity: 1;
    }
}
</style>
