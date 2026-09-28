import { invoke } from '@tauri-apps/api/core'

const buildClipboardTextPayload = (text: string) => text.replace(/^\uFEFF/, '')

/** 是否运行在 Tauri 环境（桌面/移动 WebView 都会注入 __TAURI_INTERNALS__）。 */
export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const writeClipboard = async (text: string) => {
    const payload = buildClipboardTextPayload(text)
    if (isTauri()) {
        try {
            // 走原生剪贴板：WebView 的 navigator.clipboard 异步写入会被
            // Windows 剪贴板历史（Win+V）按隐私数据处理而排除，进不了历史。
            // 注意：这里必须用静态 import——本模块会被 markdown worker 引用，
            // 动态 import 会让 IIFE worker 触发代码分割导致 vite build 失败。
            await invoke('write_clipboard_text', { text: payload })
            return
        } catch {
            // 原生写入失败（如移动端不支持）时回退 WebView API
        }
    }
    return navigator.clipboard.writeText(payload)
}
