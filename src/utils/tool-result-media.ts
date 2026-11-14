// 工具结果内容块的展示提取（纯函数，ToolInvocation 消费）。
//
// 服务端 toolResult content 的 image 块有两种形态（pi-ai 平铺字段）：
// - url 形式（view_image）：{ type:"image", data:"", url, mimeType } → url 经
//   resolveMediaUrl 拼 apiBaseUrl（/assets 是服务端相对路径，客户端设备上
//   解析不到，必须拼上服务端 origin）；
// - inline base64 形式（read 等）：{ type:"image", data:"<base64>", mimeType }
//   → data URI。
// 图片与文本分离提取：图片走缩略图渲染，文本直出——不再把含 base64 的结果
// 整体 JSON 序列化渲染（read 读图曾把整 MB base64 塞进 <pre> 巨块）。

import { resolveMediaUrl } from './media-url.ts'

/**
 * image 块 → 可渲染 src 列表。
 * url 形式优先（view_image 现行形态）；无 url 有 data 的 inline base64 拼
 * data URI；两者皆无的坏块跳过。非数组结果返回空。
 */
export function extractToolResultImages(result: unknown, apiBaseUrl: string): string[] {
    if (!Array.isArray(result)) return []
    const out: string[] = []
    for (const item of result as Array<Record<string, unknown> | null | undefined>) {
        if (!item || typeof item !== 'object' || item.type !== 'image') continue
        const url = typeof item.url === 'string' ? item.url : undefined
        if (url) {
            const resolved = resolveMediaUrl(url, apiBaseUrl)
            if (resolved) out.push(resolved)
            continue
        }
        const data = typeof item.data === 'string' ? item.data : undefined
        if (data) {
            const mime = typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : 'image/png'
            out.push(`data:${mime};base64,${data}`)
        }
    }
    return out
}

/**
 * 文本部分提取（ToolInvocation 的结果文本区）：
 * - 全文本数组 → 拼接直出；
 * - 含 image 块的结果 → 取文本部分（图片另行走缩略图渲染；无文本返回 null，
 *   模板按「有图片」决定不回退 JSON）；
 * - 单个 text 对象 → 其文本；
 * - 其余形状（含空数组）→ null（模板回退原始 JSON 显示）。
 */
export function toolResultText(result: unknown): string | null {
    if (!Array.isArray(result)) {
        if (result && typeof result === 'object' && (result as Record<string, unknown>).type === 'text'
            && typeof (result as Record<string, unknown>).text === 'string') {
            return (result as Record<string, unknown>).text as string
        }
        return null
    }
    const items = result as Array<Record<string, unknown> | null | undefined>
    const isTextBlock = (item: unknown): item is Record<string, unknown> =>
        !!item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text'
        && typeof (item as Record<string, unknown>).text === 'string'
    if (items.length > 0 && items.every(isTextBlock)) {
        return items.map(item => item.text as string).join('\n')
    }
    if (items.some(item => !!item && typeof item === 'object' && (item as Record<string, unknown>).type === 'image')) {
        const texts = items.filter(isTextBlock).map(item => item.text as string)
        return texts.length > 0 ? texts.join('\n') : null
    }
    return null
}
