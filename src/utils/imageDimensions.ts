/**
 * 图片自然尺寸缓存（模块级，应用生命周期内持久）。
 *
 * 背景：消息列表是虚拟列表，行随滚动在窗口边缘卸载/重挂载；重挂载时行内所有
 * <img> 是全新 DOM，加载完成前高度为 0（data URL 还要异步解码）。行高因此经历
 * 「0 → 逐张加载 → 全高」的多帧过程，scrollHeight 先塌缩再弹回，浏览器钳制/
 * 锚定把用户视口甩向底部——图片密集会话「向上滚动被拽回」的根因（纯文本会话
 * 行挂载即最终高度，无此问题）。
 *
 * 策略：图片首次加载记录 naturalWidth/Height；此后任何渲染/重挂载立即按缓存
 * 尺寸设置 aspect-ratio 预留空间（与 CSS 宽度约束联动，加载前即可算出高度），
 * 行挂载瞬间布局即最终布局。
 */

export interface ImageDimensions {
    width: number
    height: number
}

const dimensionCache = new Map<string, ImageDimensions>()

export const getCachedImageDimensions = (src: string): ImageDimensions | undefined =>
    dimensionCache.get(src)

export const recordImageDimensions = (src: string, width: number, height: number): void => {
    if (!src) return
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    if (width <= 0 || height <= 0) return
    dimensionCache.set(src, { width: Math.round(width), height: Math.round(height) })
}

/** 从已加载的 <img> 记录尺寸（load 事件回调与渲染后扫描两路复用） */
export const recordImageElementDimensions = (img: HTMLImageElement): void => {
    recordImageDimensions(img.currentSrc || img.src, img.naturalWidth, img.naturalHeight)
}

/**
 * 按缓存尺寸给 <img> 生成预留空间的 style；未命中缓存返回 null（保持原状，
 * 首次加载仍会有一帧弹跳——此时才测得尺寸）。
 */
export const reservedImageStyle = (src: string): Record<string, string> | null => {
    const dims = dimensionCache.get(src)
    if (!dims) return null
    return { aspectRatio: `${dims.width} / ${dims.height}` }
}

/**
 * 虚拟列表 ResizeObserver 高度回退守卫：行内存在未加载完的图片时，行的真实
 * 高度是「加载中」的临时值，不允许把缓存高度改小——否则该行卸载后 spacer 按
 * 塌缩值渲染，scrollHeight 骤降触发浏览器钳制。
 */
export const shouldKeepCachedRowHeight = (
    cachedHeight: number | undefined,
    measuredHeight: number,
    hasIncompleteImages: boolean,
): boolean => {
    if (cachedHeight === undefined || !hasIncompleteImages) return false
    return measuredHeight < cachedHeight - 50
}
