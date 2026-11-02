<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import md from '../../utils/markdown/markdown'
import { resolveMarkdownResourceUrls } from '../../utils/media-url'
import { useUiSettingsStore } from '../../stores/setting'
import { useMediaPreview } from '../../composables/useMediaPreview'
import { reservedImageStyle, recordImageElementDimensions } from '../../utils/imageDimensions'

const props = defineProps<{
    content: string
}>()

const settings = useUiSettingsStore()
const { t } = useI18n()
const { openLightbox, downloadImage } = useMediaPreview()
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

const setRenderedHtml = async (html: string) => {
    renderedHtml.value = resolveMarkdownResourceUrls(html, settings.apiBaseUrl)
    await nextTick()
    enhanceRenderedImages()
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
