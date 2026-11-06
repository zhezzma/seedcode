import { invoke } from '@tauri-apps/api/core'
import { BaseDirectory, writeFile } from '@tauri-apps/plugin-fs'

/**
 * 文件 / 图片下载共用工具：
 * - 文件名 / 扩展名归一：getImageExtension / ensureFileExtension
 * - WebView 下载兜底判定：shouldUseWebDownloadFallbackForUserAgent
 * - 落盘 / 触发下载：saveBlob
 *   - Tauri：写入系统 Download 目录（Android 走 write_download_file 自家命令，桌面走 fs 插件）
 *   - 浏览器：创建 <a download> 锚点触发；iOS/Android WebView 退回 location.href
 *   返回落盘的目标描述（path），供调用方做 toast 提示。
 */

/** MIME → 图片扩展名。image/jpeg 归一为 jpg；非图片或无法解析返回 bin。 */
export const getImageExtension = (mimeType: string) => {
    if (mimeType === 'image/jpeg') return 'jpg'

    if (mimeType.startsWith('image/')) {
        const subtype = mimeType.slice('image/'.length).split(';', 1)[0].trim().toLowerCase()
        const normalizedSubtype = subtype.split('+', 1)[0]

        if (/^[a-z0-9.-]+$/i.test(normalizedSubtype) && normalizedSubtype.length > 0) {
            return normalizedSubtype
        }
    }

    return 'bin'
}

/** 文件名已带扩展名则原样返回，否则补上给定扩展名。 */
export const ensureFileExtension = (fileName: string, extension: string) => {
    return /\.[a-z0-9]+$/i.test(fileName) ? fileName : `${fileName}.${extension}`
}

/** iOS / Android WebView 下 <a download> 不可靠，需退回 location.href 兜底。 */
export const shouldUseWebDownloadFallbackForUserAgent = (userAgent: string) => {
    const isIOS = /iPad|iPhone|iPod/i.test(userAgent)
    const isAndroidWebView = /; wv\)/i.test(userAgent)

    return isIOS || isAndroidWebView
}

const isTauriApp = () => {
    if (typeof window === 'undefined') return false
    return !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__
}

const isAndroidTauri = () => {
    if (typeof navigator === 'undefined') return false
    return isTauriApp() && /Android/i.test(navigator.userAgent)
}

const getTauriDownloadTarget = (fileName: string) => {
    // 桌面目标：fs 插件原始字节通道直写系统 Download 目录。Android 不走 fs 插件
    // （见 saveBlob 注释），本函数不再持有移动端分支。
    return { path: fileName, baseDir: BaseDirectory.Download }
}

const shouldUseWebDownloadFallback = () => {
    if (typeof navigator === 'undefined') return false
    return shouldUseWebDownloadFallbackForUserAgent(navigator.userAgent || '')
}

const downloadBlobInBrowser = (blob: Blob, fileName: string) => {
    const url = window.URL.createObjectURL(blob)

    if (shouldUseWebDownloadFallback()) {
        window.location.href = url
        setTimeout(() => window.URL.revokeObjectURL(url), 30000)
        return
    }

    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => window.URL.revokeObjectURL(url), 5000)
}

/** Blob → 纯 base64 串（剥掉 data URL 的 data:*;base64, 前缀）。FileReader 原生异步转码，
 *  不占 JS 主线程；产物体积 4/3 原文，远小于 JSON 数字数组的 3-4 倍膨胀。 */
const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            const dataUrl = reader.result as string
            resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
        }
        reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
        reader.readAsDataURL(blob)
    })

/** 落盘 Blob，返回保存路径（供 toast）。Tauri 写 Download 目录，浏览器走锚点下载。
 *  Android 例外：fs 插件 writeFile 在 Android 走 postMessage JSON 数字数组 IPC（wry
 *  读不了自定义协议请求体，原始字节通道被硬编码禁用），大文件的 Uint8Array 被
 *  Array.from + JSON.stringify 展开成百 MB 字符串、同步冻结 WebView 主线程数十秒——
 *  改走自家 write_download_file 命令传 base64，Rust 解码一次落盘，返回绝对路径。
 *  桌面仍走 fs 插件原始字节通道（octet-stream 无膨胀），零回归。 */
export async function saveBlob(blob: Blob, fileName: string): Promise<string> {
    if (isTauriApp()) {
        if (isAndroidTauri()) {
            return await invoke<string>('write_download_file', {
                fileName,
                base64Data: await blobToBase64(blob),
            })
        }
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const target = getTauriDownloadTarget(fileName)
        await writeFile(target.path, bytes, { baseDir: target.baseDir })
        return target.path
    }
    downloadBlobInBrowser(blob, fileName)
    return fileName
}
