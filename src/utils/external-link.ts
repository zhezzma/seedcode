/**
 * 外部链接打开：JS 触发一次性 <a target="_blank"> 的导航（不引插件、不用 window.open）。
 *
 * 与用户手点 <a target="_blank"> 同走 WebView 新窗口机制，由系统默认浏览器接管
 * （Tauri 桌面即外部浏览器，纯 Web 即新标签页）。仓库既有同模式先例：
 * useA2UIState.openUrl、fileDownload 的浏览器下载兜底、mermaid SVG 下载。
 * 刻意不用的两条路：
 * - window.open：Tauri WebView 内不可靠（useA2UIState 同款注释的结论）
 * - @tauri-apps/plugin-opener：为一个链接引插件，过度设计
 */

/** 解析外部链接：trim + new URL，仅放行 http(s)；其余 scheme（javascript: 等）与非法输入返回 null。
 *  链接来自服务端 external-links 扩展清单（设置表单录入），仍可能是任意字符串，必须先过闸再进 DOM。纯函数，便于测试。 */
export function parseExternalUrl(url: string): URL | null {
    let parsed: URL
    try {
        parsed = new URL(url.trim())
    } catch {
        return null
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
}

/** 触发外部链接。返回是否已触发；地址非法时只告警不打开，调用方无需额外处理。 */
export function openExternalLink(url: string): boolean {
    if (!parseExternalUrl(url)) {
        console.warn('[external-link] ignored non-http(s) url:', url)
        return false
    }
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    return true
}
