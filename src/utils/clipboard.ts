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

/** 桌面端富文本写入（text + html 双格式，粘贴到支持 HTML 的目标不失格式）。 */
export const writeClipboardRich = async (text: string, html: string) => {
    if (isTauri()) {
        try {
            await invoke('write_clipboard_html', { text, html })
            return
        } catch {
            // 原生写入失败时回退纯文本
        }
    }
    return writeClipboard(text)
}

const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod/i

/**
 * 桌面端拦截选中复制（Ctrl+C / 右键菜单复制 / Ctrl+X）：
 * Chromium 原生复制路径写入的剪贴板同样不会进 Windows 剪贴板历史，
 * 所以阻止默认写入，改走原生命令（write_clipboard_html）。
 */
export const installNativeCopyInterceptor = () => {
    if (!isTauri() || MOBILE_USER_AGENT.test(navigator.userAgent)) return

    const selectionToHtml = (selection: Selection) => {
        const container = document.createElement('div')
        for (let i = 0; i < selection.rangeCount; i++) {
            container.appendChild(selection.getRangeAt(i).cloneContents())
        }
        return container.innerHTML
    }

    document.addEventListener('copy', (event) => {
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
        const text = selection.toString()
        if (!text) return
        event.preventDefault()
        void writeClipboardRich(text, selectionToHtml(selection)).catch(() => {})
    }, true)

    document.addEventListener('cut', (event) => {
        const target = event.target
        const editable = target instanceof HTMLElement
            && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
        if (!editable) return
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
        const text = selection.toString()
        if (!text) return
        event.preventDefault()
        void writeClipboardRich(text, selectionToHtml(selection)).catch(() => {})
        document.execCommand('delete')
    }, true)
}
