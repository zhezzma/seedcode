import { computed, ref } from 'vue'
import { ensureFileExtension, getImageExtension, saveBlob } from '../utils/fileDownload.ts'
import { useToast } from './useToast.ts'
import { isTauri } from '../utils/clipboard.ts'

// ==================== Image Lightbox State ====================

const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

const lightboxOpen = ref(false)
const lightboxSrc = ref('')
const sessionImageSources = ref<string[]>([])
const lightboxSources = ref<string[]>([])
const lightboxIndex = ref(-1)
const canNavigateLightbox = computed(() => lightboxSources.value.length > 1)

const imgScale = ref(1)
const imgTranslateX = ref(0)
const imgTranslateY = ref(0)
const isDragging = ref(false)

// Zoom & Pan state variables
let lastDistance = 0
let lastX = 0
let lastY = 0
let lastTap = 0
// Mobile Safari / Chromium may emit a synthetic dblclick right after a touch double tap.
// Track the touch-driven zoom time so we can ignore that follow-up event without affecting desktop dblclick.
let lastTouchDoubleTapAt = 0
const isMouseDragging = ref(false)
let lastMouseX = 0
let lastMouseY = 0

const resetZoomState = () => {
    imgScale.value = 1
    imgTranslateX.value = 0
    imgTranslateY.value = 0
    isDragging.value = false
    isMouseDragging.value = false
}

const toggleZoom = () => {
    if (imgScale.value > 1) {
        resetZoomState()
    } else {
        imgScale.value = 2.5
    }
}

const setLightboxSources = (sources: string[]) => {
    sessionImageSources.value = Array.from(new Set(sources.filter(Boolean)))

    if (!lightboxOpen.value) return

    const currentIndex = sessionImageSources.value.indexOf(lightboxSrc.value)
    if (currentIndex >= 0) {
        lightboxSources.value = sessionImageSources.value
        lightboxIndex.value = currentIndex
    }
}

const openLightbox = (src: string) => {
    resetZoomState()

    const sessionIndex = sessionImageSources.value.indexOf(src)
    lightboxSources.value = sessionIndex >= 0
        ? sessionImageSources.value
        : [src]
    lightboxIndex.value = sessionIndex >= 0 ? sessionIndex : 0
    lightboxSrc.value = src
    lightboxOpen.value = true
}

const switchLightboxImage = (offset: -1 | 1) => {
    if (!canNavigateLightbox.value) return

    const imageCount = lightboxSources.value.length
    const nextIndex = (lightboxIndex.value + offset + imageCount) % imageCount
    lightboxIndex.value = nextIndex
    lightboxSrc.value = lightboxSources.value[nextIndex]
    resetZoomState()
}

const showPreviousImage = () => switchLightboxImage(-1)
const showNextImage = () => switchLightboxImage(1)

const handleLightboxKeydown = (event: KeyboardEvent) => {
    if (!lightboxOpen.value || !canNavigateLightbox.value) return

    if (event.key === 'ArrowLeft') {
        event.preventDefault()
        showPreviousImage()
    } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        showNextImage()
    }
}

const closeLightbox = () => {
    lightboxOpen.value = false
    lightboxSrc.value = ''
    lightboxSources.value = []
    lightboxIndex.value = -1
    resetZoomState()
}

// ==================== Image Share (Web Share API) ====================

/** 能力检测：桌面（WebView2/WKWebView/浏览器）有 Web Share API 就用它；
 *  Android WebView 不实现 navigator.share（iOS WKWebView 弱实现），
 *  移动 Tauri 走 sharekit 原生分享面板（按钮显示条件包含原生路径可用性）。 */
const canShareImage =
    (typeof navigator !== 'undefined' && typeof navigator.share === 'function') ||
    (isTauri() && isMobileDevice)

/** 从图片 src 提取底部展示与分享共用的文件名：http(s) 取 URL 路径末段；
 *  data URL 按 MIME 推扩展名，命名沿用 downloadImage 的 image-{timestamp} 规则。
 *  两处共用本函数，保证分享出去的名字与界面显示一致。纯函数，便于测试。 */
export const getLightboxImageName = (src: string): string => {
    if (/^https?:/i.test(src)) {
        try {
            const { pathname } = new URL(src)
            // 以 / 结尾指向目录而非文件，直接走兜底命名
            if (!pathname.endsWith('/')) {
                const lastSegment = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '')
                if (lastSegment) return lastSegment
            }
        } catch {
            // 非法 URL 落入下方兜底命名
        }
    }
    const mime = /^data:([^;,]+)/.exec(src)?.[1]
    const extension = mime && mime.startsWith('image/') ? getImageExtension(mime) : 'png'
    return `image-${Date.now()}.${extension}`
}

const lightboxImageName = computed(() => getLightboxImageName(lightboxSrc.value))

/** Tauri 移动端原生分享：Android WebView 无 navigator.share，落盘缓存目录后
 *  走 sharekit 系统分享面板（Android Sharesheet / iOS Share Pane）。
 *  插件 Android 侧会把文件拷入 app cacheDir 并经 FileProvider 转 content://
 *  （gen/android 模板的 file_paths.xml 已声明 cache-path），传规范 file:// URL
 *  兼容 iOS URL(string:) 与 Android Uri.parse 两种解析。 */
const shareImageNative = async (src: string) => {
    const [{ shareFile }, { writeFile }, { appCacheDir, join }] = await Promise.all([
        import('@choochmeque/tauri-plugin-sharekit-api'),
        import('@tauri-apps/plugin-fs'),
        import('@tauri-apps/api/path'),
    ])

    const response = await fetch(src)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    // 展示名与分享名共用同一来源（见 getLightboxImageName）；落盘名剥离分隔符，
    // 防 URL 末段解码后含 / 或 .. 造成路径穿越（join 是 PathBuf::push 语义，不规范化 ..）
    const displayName = src === lightboxSrc.value ? lightboxImageName.value : getLightboxImageName(src)
    const fileName = displayName.replace(/[\\/]+/g, '_')
    const filePath = await join(await appCacheDir(), fileName)
    await writeFile(filePath, new Uint8Array(await blob.arrayBuffer()))
    // file:// URL 按段百分号编码：裸空格/# 会截断 iOS URL(string:) 与 Android Uri.parse 的路径；
    // 平台端解析后解码回原名，与落盘文件严格一致
    const fileUrl = 'file://' + filePath.split('/').map(encodeURIComponent).join('/')
    await shareFile(fileUrl, { mimeType: blob.type || 'image/png', title: fileName })
}

const shareImage = async (src: string) => {
    const toast = useToast()
    // 注意需带 index.ts：本函数会被 node 单测直接执行，node ESM 不支持目录导入（Vite 两者皆可）
    const { i18n } = await import('../i18n/index.ts')
    const _t = (key: string) => i18n.global.t(key)

    try {
        if (isTauri() && isMobileDevice) {
            await shareImageNative(src)
            return
        }

        if (/^https?:/i.test(src)) {
            await navigator.share({ url: src })
            return
        }

        const response = await fetch(src)
        const blob = await response.blob()
        // 展示名（computed 随 src 缓存）与分享名共用，避免兜底命名两次 Date.now() 不一致
        const fileName = src === lightboxSrc.value ? lightboxImageName.value : getLightboxImageName(src)
        const file = new File([blob], fileName, { type: blob.type })
        // canShare({ files }) 复检：部分 WebView 只支持 share() 文本/链接，不支持文件分享
        if (!navigator.canShare?.({ files: [file] })) {
            throw new Error('File sharing is not supported in this context')
        }
        await navigator.share({ files: [file] })
    } catch (error) {
        // 用户在系统分享面板主动取消不算失败，不打错误 toast
        // （Web Share 抛 AbortError；sharekit 原生端 Android/iOS 均 reject "Share cancelled" 字符串）
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof Error ? error.message : String(error)
        if (/share cancelled/i.test(message)) {
            console.info('[lightbox] share cancelled by user')
            return
        }
        console.error('Share image failed:', error)
        toast.error(_t('chat.shareImageFailed'))
    }
}

const getDistance = (touches: TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.sqrt(dx * dx + dy * dy)
}

const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
        lastDistance = getDistance(e.touches)
    } else if (e.touches.length === 1) {
        isDragging.value = true
        lastX = e.touches[0].clientX
        lastY = e.touches[0].clientY
    }
}

const handleTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 2) {
        const currentDistance = getDistance(e.touches)
        const scaleChange = currentDistance / lastDistance
        imgScale.value = Math.min(Math.max(1, imgScale.value * scaleChange), 5)
        lastDistance = currentDistance
    } else if (e.touches.length === 1 && isDragging.value && imgScale.value > 1) {
        const currentX = e.touches[0].clientX
        const currentY = e.touches[0].clientY
        imgTranslateX.value += currentX - lastX
        imgTranslateY.value += currentY - lastY
        lastX = currentX
        lastY = currentY
    }
}

const handleTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) {
        lastDistance = 0
    }
    if (e.touches.length === 0) {
        isDragging.value = false
        if (imgScale.value <= 1) {
            resetZoomState()
        }

        // Handle double tap
        const currentTime = Date.now()
        const tapLength = currentTime - lastTap
        if (tapLength < 300 && tapLength > 0) {
            toggleZoom()
            lastTouchDoubleTapAt = currentTime
        }
        lastTap = currentTime
    }
}

const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    const zoomIntensity = 0.1
    let newScale = imgScale.value + (e.deltaY < 0 ? -zoomIntensity : zoomIntensity)
    imgScale.value = Math.min(Math.max(1, newScale), 5)
    if (imgScale.value <= 1) {
        resetZoomState()
    }
}

const handleImageDblClick = (e: Event) => {
    e.stopPropagation()

    // Ignore the synthetic dblclick some mobile browsers dispatch immediately
    // after touch-based double tap, otherwise the zoom toggles twice and flickers.
    if (Date.now() - lastTouchDoubleTapAt < 350) {
        return
    }

    toggleZoom()
}

const handleMouseDown = (e: MouseEvent) => {
    e.stopPropagation()
    if (imgScale.value > 1) {
        isMouseDragging.value = true
        lastMouseX = e.clientX
        lastMouseY = e.clientY
    }
}

const handleMouseMove = (e: MouseEvent) => {
    if (isMouseDragging.value && imgScale.value > 1) {
        e.preventDefault()
        const currentX = e.clientX
        const currentY = e.clientY
        imgTranslateX.value += currentX - lastMouseX
        imgTranslateY.value += currentY - lastMouseY
        lastMouseX = currentX
        lastMouseY = currentY
    }
}

const handleMouseUp = (_e: MouseEvent) => {
    if (isMouseDragging.value) {
        isMouseDragging.value = false
    }
}

const downloadImage = async (src: string, defaultName?: string) => {
    const toast = useToast()
    const { i18n } = await import('../i18n')
    const _t = (key: string, named?: Record<string, unknown>) => named ? i18n.global.t(key, named) : i18n.global.t(key)

    try {
        const response = await fetch(src)
        const blob = await response.blob()
        const extension = getImageExtension(blob.type)
        const fileName = ensureFileExtension(defaultName || `image-${Date.now()}`, extension)
        // 落盘逻辑与任意文件下载共用 saveBlob：Tauri 写 Download 目录、浏览器走锚点。
        const savedPath = await saveBlob(blob, fileName)
        toast.success(_t('chat.downloadImageSuccess', { path: savedPath }))
    } catch (error) {
        console.error('Download failed:', error)
        toast.error(_t('chat.downloadImageFailed'))
    }
}

// Tauri 桌面端走原生剪贴板写入（WebView 的 Clipboard API 写入不进 Windows 剪贴板历史）。
const writeImageToClipboardNative = async (blob: Blob) => {
    const bitmap = await createImageBitmap(blob)
    try {
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('write_clipboard_image', {
            rgba: new Uint8Array(imageData.data.buffer),
            width: imageData.width,
            height: imageData.height,
        })
    } finally {
        bitmap.close()
    }
}

const copyImageToClipboard = async (src: string) => {
    const toast = useToast()
    const { i18n } = await import('../i18n')
    const _t = (key: string) => i18n.global.t(key)
    try {
        const response = await fetch(src)
        const blob = await response.blob()

        // Tauri 桌面端优先原生写入；失败（如移动端不支持）回退 WebView API
        if (isTauri()) {
            try {
                await writeImageToClipboardNative(blob)
                toast.success(_t('common.copied'))
                return
            } catch (error) {
                console.warn('Native clipboard write failed, fallback to WebView API:', error)
            }
        }

        // The Clipboard API requires image/png. Convert if needed.
        let pngBlob = blob
        if (blob.type !== 'image/png') {
            pngBlob = await convertToPng(blob)
        }

        await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': pngBlob })
        ])
        toast.success(_t('common.copied'))
    } catch (error) {
        console.error('Copy image failed:', error)
        toast.error(_t('chat.copyImageFailed'))
    }
}

const convertToPng = (blob: Blob): Promise<Blob> => {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
            const canvas = document.createElement('canvas')
            canvas.width = img.naturalWidth
            canvas.height = img.naturalHeight
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(img, 0, 0)
            canvas.toBlob(b => {
                if (b) resolve(b)
                else reject(new Error('Canvas toBlob failed'))
            }, 'image/png')
        }
        img.onerror = reject
        img.src = URL.createObjectURL(blob)
    })
}

// ==================== File Content Viewer State ====================

const fileViewerOpen = ref(false)
const fileViewerName = ref('')
const fileViewerContent = ref('')

const openFileViewer = (fileName: string, content: string) => {
    fileViewerName.value = fileName
    fileViewerContent.value = content
    fileViewerOpen.value = true
}

const closeFileViewer = () => {
    fileViewerOpen.value = false
    fileViewerName.value = ''
    fileViewerContent.value = ''
}

// ==================== Export (singleton) ====================

const _mediaPreviewState = {
    // Environment
    isMobileDevice,
    // Image lightbox
    lightboxOpen,
    lightboxSrc,
    lightboxSources,
    lightboxIndex,
    canNavigateLightbox,
    imgScale,
    imgTranslateX,
    imgTranslateY,
    isDragging,
    isMouseDragging,
    openLightbox,
    closeLightbox,
    setLightboxSources,
    showPreviousImage,
    showNextImage,
    handleLightboxKeydown,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleWheel,
    handleImageDblClick,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    downloadImage,
    copyImageToClipboard,
    // Image share
    canShareImage,
    lightboxImageName,
    shareImage,
    // File viewer
    fileViewerOpen,
    fileViewerName,
    fileViewerContent,
    openFileViewer,
    closeFileViewer,
}

export function useMediaPreview() {
    return _mediaPreviewState
}
