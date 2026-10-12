import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useMediaPreview, getLightboxImageName } from '../src/composables/useMediaPreview.ts'
import { useToast } from '../src/composables/useToast.ts'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')

const mediaPreview = useMediaPreview()

const resetPreview = () => {
    mediaPreview.closeLightbox()
    mediaPreview.setLightboxSources([])
    // toasts 有 3 秒自动移除的 setTimeout，不清理会跨用例串扰
    useToast().clear()
}

test.beforeEach(resetPreview)
test.afterEach(resetPreview)

// ==================== 文件名提取（底部展示与分享共用） ====================

test('extracts the last URL path segment as the image name', () => {
    assert.equal(getLightboxImageName('https://example.com/a/b/photo%201.png'), 'photo 1.png')
})

test('falls back to the timestamped name when the URL has no file segment', () => {
    assert.match(getLightboxImageName('https://example.com/a/b/'), /^image-\d+\.png$/)
    assert.match(getLightboxImageName('not a url'), /^image-\d+\.png$/)
})

test('derives the extension from a data URL mime type', () => {
    assert.match(getLightboxImageName('data:image/jpeg;base64,AAAA'), /^image-\d+\.jpg$/)
    assert.match(getLightboxImageName('data:image/webp;base64,AAAA'), /^image-\d+\.webp$/)
})

test('falls back to png for data URLs without an image mime', () => {
    assert.match(getLightboxImageName('data:application/octet-stream;base64,AAAA'), /^image-\d+\.png$/)
    assert.match(getLightboxImageName(''), /^image-\d+\.png$/)
})

// ==================== composable：展示名随 lightboxSrc 联动 ====================

test('lightbox image name follows the opened source', () => {
    mediaPreview.openLightbox('https://example.com/cat.png')
    assert.equal(mediaPreview.lightboxImageName.value, 'cat.png')

    mediaPreview.openLightbox('data:image/webp;base64,AAAA')
    assert.match(mediaPreview.lightboxImageName.value, /^image-\d+\.webp$/)
})

test('exposes the share capability flag and shareImage', () => {
    assert.equal(typeof mediaPreview.canShareImage, 'boolean')
    assert.equal(typeof mediaPreview.shareImage, 'function')
})

// ==================== shareImage 行为（注入 Web Share API stub） ====================

const installShareStub = (canShare: boolean) => {
    const shareCalls: Array<Record<string, unknown>> = []
    Object.defineProperty(globalThis.navigator, 'share', {
        value: async (data: Record<string, unknown>) => { shareCalls.push(data) },
        configurable: true,
    })
    Object.defineProperty(globalThis.navigator, 'canShare', {
        value: () => canShare,
        configurable: true,
    })
    return shareCalls
}

test('shares an http image as a url', async () => {
    const shareCalls = installShareStub(true)

    await mediaPreview.shareImage('https://example.com/cat.png')

    assert.deepEqual(shareCalls, [{ url: 'https://example.com/cat.png' }])
})

test('shares a data-url image as a file named by the lightbox naming rule', async () => {
    const shareCalls = installShareStub(true)

    await mediaPreview.shareImage('data:image/png;base64,iVBORw0KGgo=')

    assert.equal(shareCalls.length, 1)
    const files = shareCalls[0].files as File[]
    assert.equal(files.length, 1)
    assert.match(files[0].name, /^image-\d+\.png$/)
    assert.equal(files[0].type, 'image/png')
})

test('does not call share when file sharing is unsupported; surfaces an error toast', async () => {
    const shareCalls = installShareStub(false)
    const toasts = useToast().toasts

    await mediaPreview.shareImage('data:image/png;base64,iVBORw0KGgo=')

    assert.equal(shareCalls.length, 0)
    assert.equal(toasts.value.filter(t => t.type === 'error').length, 1)
})

test('a user-cancelled share (AbortError) stays silent', async () => {
    installShareStub(true)
    Object.defineProperty(globalThis.navigator, 'share', {
        value: async () => { throw new DOMException('cancelled', 'AbortError') },
        configurable: true,
    })
    const toasts = useToast().toasts
    const errorCountBefore = toasts.value.filter(t => t.type === 'error').length

    await mediaPreview.shareImage('https://example.com/cat.png')

    assert.equal(toasts.value.filter(t => t.type === 'error').length, errorCountBefore)
})

test('share reuses the displayed name for the currently opened source', async () => {
    const shareCalls = installShareStub(true)
    mediaPreview.openLightbox('data:image/png;base64,iVBORw0KGgo=')
    const displayed = mediaPreview.lightboxImageName.value

    await mediaPreview.shareImage('data:image/png;base64,iVBORw0KGgo=')

    const files = shareCalls[0].files as File[]
    assert.equal(files[0].name, displayed)
})

// ==================== 组件源码断言 ====================

const overlaySource = readFileSync(path.join(repoRoot, 'src/components/chat/MediaPreviewOverlay.vue'), 'utf8')

test('overlay renders a share button in the top tools section', () => {
    const toolsSectionMatch = overlaySource.match(/<!-- Tools -->\s*<div([^>]*)>[\s\S]*?<!-- Close -->/)
    assert.ok(toolsSectionMatch, 'expected to find the overlay tools section')
    assert.match(toolsSectionMatch[0], /<!-- Share -->\s*<button v-if="canShareImage" @click\.stop="shareImage\(lightboxSrc\)"/)
    assert.match(toolsSectionMatch[0], /:title="t\('chat\.shareImage'\)"/)
})

test('bottom pill always shows the file name alongside the zoom hint', () => {
    const pillMatch = overlaySource.match(/<!-- Name & zoom hint at bottom -->\s*<div([^>]*)>/)
    assert.ok(pillMatch, 'expected to find the bottom name/zoom pill')
    assert.doesNotMatch(pillMatch[1], /\bv-if=/, 'the name pill must stay visible regardless of zoom level')

    assert.match(overlaySource, /class="truncate">\{\{\s*lightboxImageName\s*\}\}/)
    assert.match(overlaySource, /<span v-if="imgScale === 1"[^>]*>\{\{\s*t\('chat\.zoomHint'\)\s*\}\}<\/span>/)
})

test('zh/en locales both define the share strings', () => {
    const zh = readFileSync(path.join(repoRoot, 'src/i18n/zh.ts'), 'utf8')
    const en = readFileSync(path.join(repoRoot, 'src/i18n/en.ts'), 'utf8')

    for (const source of [zh, en]) {
        assert.match(source, /shareImage: '/)
        assert.match(source, /shareImageFailed: '/)
    }
})
