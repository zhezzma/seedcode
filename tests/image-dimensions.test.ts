import test from 'node:test'
import assert from 'node:assert/strict'

import {
    getCachedImageDimensions,
    recordImageDimensions,
    reservedImageStyle,
    shouldKeepCachedRowHeight,
} from '../src/utils/imageDimensions.ts'

/**
 * 图片自然尺寸缓存 + 预留空间：图片密集会话中，虚拟列表行随滚动卸载/重挂载，
 * 重挂载行内 <img> 全新 DOM 从 0 高度异步加载 → 行高「0 → 逐张加载 → 全高」
 * 多帧跳变 → scrollHeight 塌缩/弹回 → 浏览器钳制把视口甩向底部（向上滚动被
 * 拽回的根因）。首次加载记录 naturalWidth/Height，之后渲染立即按缓存尺寸
 * aspect-ratio 预留空间，挂载瞬间布局即最终布局。
 */
test('recordImageDimensions 记录合法尺寸并取整', () => {
    recordImageDimensions('data:image/png;base64,AAA', 800.4, 599.6)
    assert.deepEqual(getCachedImageDimensions('data:image/png;base64,AAA'), { width: 800, height: 600 })
})

test('recordImageDimensions 忽略非法尺寸与空 src', () => {
    recordImageDimensions('bad-1', 0, 100)
    recordImageDimensions('bad-2', -1, 100)
    recordImageDimensions('bad-3', 100, Number.NaN)
    recordImageDimensions('', 100, 100)
    assert.equal(getCachedImageDimensions('bad-1'), undefined)
    assert.equal(getCachedImageDimensions('bad-2'), undefined)
    assert.equal(getCachedImageDimensions('bad-3'), undefined)
    assert.equal(getCachedImageDimensions(''), undefined)
})

test('reservedImageStyle 未命中返回 null，命中返回 aspect-ratio', () => {
    assert.equal(reservedImageStyle('unknown-src'), null)
    recordImageDimensions('known-src', 1600, 900)
    assert.deepEqual(reservedImageStyle('known-src'), { aspectRatio: '1600 / 900' })
})

test('shouldKeepCachedRowHeight：行内图片未加载完时不允许缓存高度被改小', () => {
    // 加载中的行真实高度是临时值（如 500），禁止覆盖已测得的完整高度（12775）
    assert.equal(shouldKeepCachedRowHeight(12775, 500, true), true)
    // 变大（图片加载推进）允许更新
    assert.equal(shouldKeepCachedRowHeight(12775, 13000, true), false)
    // 无未加载完图片：真实收缩（思考块折叠等）允许
    assert.equal(shouldKeepCachedRowHeight(12775, 500, false), false)
    // 首次测量（无缓存）允许
    assert.equal(shouldKeepCachedRowHeight(undefined, 500, true), false)
    // 50px 容差内的微小抖动不拦截
    assert.equal(shouldKeepCachedRowHeight(12775, 12740, true), false)
})
