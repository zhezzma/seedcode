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

/** 音视频 MIME → 扩展名特判表：subtype 与文件扩展名不一致的（audio/mpeg 实为 .mp3）
 *  在此归一；其余直接用 subtype（wav/ogg/flac/webm…）。非 AVMIME 返回 bin。 */
const AV_MIME_EXT: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/webm': 'weba',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/3gpp': '3gp',
}

/** MIME → 媒体扩展名（图片沿用 getImageExtension；音视频走特判表 + subtype）。
 *  仅作 URL 末段无扩展名时的兑底命名；正常路径（/assets 媒体 URL 末段自带
 *  扩展名）不会走到这里。 */
export const getMediaExtension = (mimeType: string) => {
    if (mimeType.startsWith('image/')) return getImageExtension(mimeType)

    if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
        if (AV_MIME_EXT[mimeType]) return AV_MIME_EXT[mimeType]
        const subtype = mimeType.split('/', 2)[1]?.split(';', 1)[0].trim().toLowerCase() || ''
        if (/^[a-z0-9-]+$/i.test(subtype)) return subtype
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

/** 流式分块中转的单块大小：4MB 原始字节 → base64 后 ~5.3MB IPC 载荷。
 *  块太小（网络分片级 64KB）237MB 文件要发 ~3800 次 invoke，往返开销吃掉吞吐；
 *  块太大（整文件）就退回 OOM 老路。4MB ≈ 60 次 invoke，JS 堆峰值 ~13MB。 */
const STREAM_CHUNK_BYTES = 4 * 1024 * 1024

/** 流式下载 URL 到系统下载目录（Tauri 走分块中转，浏览器退回锚点），返回落盘路径。
 *  替代「整文件 blob → base64 → 一次 invoke」的旧路：237MB debug APK 那种大文件
 *  旧路在 WebView 渲染进程堆峰值 ~3.7×文件大小（blob + base64 串 + IPC 序列化
 *  副本），Android 直接 OOM 崩溃；本路 fetch 流式读取、4MB 分块经
 *  write_download_chunk 逐块落盘，内存峰值与文件大小无关。
 *  非 2xx 时解析服务端 JSON 错误消息，行为对齐 workspace-api.fetchDownload。 */
export async function saveUrlToSystemFile(
    url: string,
    headers: Record<string, string> | undefined,
    fileName: string,
): Promise<string> {
    const response = await fetch(url, { method: 'GET', headers })
    if (!response.ok) {
        let msg = `HTTP ${response.status}`
        try {
            const body = await response.json()
            if (body?.error) msg = body.error
        } catch { /* 二进制响应不是 JSON，忽略 */ }
        throw new Error(msg)
    }
    if (!isTauriApp()) {
        // 浏览器：整块 + <a download> 锚点（浏览器自带下载管理器，无 WebView 的堆约束）
        return saveBlob(await response.blob(), fileName)
    }
    const reader = response.body?.getReader()
    if (!reader) {
        // 理论不可达（Chromium fetch 必有 body 流）；兑底退整块路径
        return saveBlob(await response.blob(), fileName)
    }
    let append = false
    let savedPath = ''
    let pending: Uint8Array[] = []
    let pendingBytes = 0
    const flush = async () => {
        const chunk = new Uint8Array(pendingBytes)
        let offset = 0
        for (const part of pending) {
            chunk.set(part, offset)
            offset += part.length
        }
        pending = []
        pendingBytes = 0
        savedPath = await invoke<string>('write_download_chunk', {
            fileName,
            base64Data: await blobToBase64(new Blob([chunk])),
            append,
        })
        append = true
    }
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.length === 0) continue
        pending.push(value)
        pendingBytes += value.length
        if (pendingBytes >= STREAM_CHUNK_BYTES) await flush()
    }
    // 空文件也要建出来：一次 append=false 的空块调用即截断建文件
    if (pendingBytes > 0 || !append) await flush()
    return savedPath
}
