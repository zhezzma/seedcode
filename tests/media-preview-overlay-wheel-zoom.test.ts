import test from 'node:test'
import assert from 'node:assert/strict'
import { useMediaPreview } from '../src/composables/useMediaPreview.ts'

const mediaPreview = useMediaPreview()

const wheel = (deltaY: number) =>
    ({ deltaY, preventDefault() { } } as WheelEvent)

test.beforeEach(() => {
    mediaPreview.closeLightbox()
})

test.afterEach(() => {
    mediaPreview.closeLightbox()
})

test('wheel up zooms in and wheel down zooms out (standard direction)', () => {
    mediaPreview.openLightbox('https://example.com/demo.png')
    assert.equal(mediaPreview.imgScale.value, 1)

    mediaPreview.handleWheel(wheel(-100))
    assert.equal(mediaPreview.imgScale.value, 1.1, 'scrolling up should zoom in')

    mediaPreview.handleWheel(wheel(100))
    assert.equal(mediaPreview.imgScale.value, 1, 'scrolling down should zoom back out')
})

test('wheel direction matches mermaid ctrl+wheel zoom convention when zoomed in', () => {
    mediaPreview.openLightbox('https://example.com/demo.png')

    mediaPreview.handleImageDblClick({ stopPropagation() { } } as Event)
    assert.equal(mediaPreview.imgScale.value, 2.5)

    mediaPreview.handleWheel(wheel(-120))
    assert.equal(mediaPreview.imgScale.value, 2.6, 'scroll up should zoom in further')

    mediaPreview.handleWheel(wheel(120))
    assert.equal(mediaPreview.imgScale.value, 2.5, 'scroll down should zoom out')
})
