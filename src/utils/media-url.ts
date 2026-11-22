import { isServerSideAbsolutePath, toDiskPathForm } from './tool-file-paths.ts'

// AI 偶发把服务端相对路径 /assets/... 补全成绝对 URL，且补上的 origin 是幻觉：
//  - https://assets/...           host 连同 /assets 前缀被吞成 assets
//  - http://localhost/assets/...  origin 幻觉成客户端自身的环回地址（无端口）
//  - https:///assets/...、https:/assets/...   机械拼接的斜杠畸形
// 这些 host 在客户端设备上都不是服务端（服务端在 apiBaseUrl），链接注定解析
// 失败——识别后还原成 /assets/... 相对路径，交由下方常规拼接。还原后再拼接
// 对「apiBaseUrl 恰为同一环回 origin」的本机部署自然得到等价 URL，无需特判。
// 带端口的环回 URL（可能是真实本机部署）不在此列：伪主机组后必须紧跟 /，
// 端口形态天然不命中，保守放行。
const PSEUDO_ORIGIN_PATTERN = /^https?:\/{1,3}(assets|localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])?(\/.+)$/i

/** Resolve media references returned by the backend against the configured API origin. */
export function resolveMediaUrl(url: string | undefined, apiBaseUrl: string): string | undefined {
  if (!url) return url

  const malformed = PSEUDO_ORIGIN_PATTERN.exec(url)
  if (malformed) {
    const host = malformed[1]?.toLowerCase()
    // assets 形态把 /assets 前缀一起吞进 host：还原时补回；其余形态路径已自带前缀。
    // 环回主机只还原 /assets/ 路径：其余路径可能是设备上真实存在的本地服务。
    const rest = malformed[2] ?? ''
    const restored = host === 'assets' ? `/assets${rest}` : rest
    if (restored.startsWith('/assets/')) return resolveMediaUrl(restored, apiBaseUrl)
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('//')) return url

  const baseUrl = apiBaseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) return url

  return `${baseUrl}/${url.replace(/^\/+/, '')}`
}

/**
 * markdown-it 对链接目标做百分号编码（\ → %5C、空格 → %20、CJK → UTF-8 序列）；
 * 磁盘路径判定与 data-absolute-src 存储都需要真实路径，先解码。畸形序列
 * （路径里裸写的 % 不构成合法编码）decodeURIComponent 会抛——回退原样。
 */
function decodeUriLoose(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

/** 1x1 透明 GIF：绝对路径 <img> 的占位 src（真图由 raw 端点拉字节后替换）。
 *  避免浏览器直接加载磁盘路径（盘符被当协议、根路径被拼 origin 后 404）
 *  造成的裂图闪现与无效请求。 */
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** Apply the shared media URL policy to image sources and links emitted by MarkdownIt. */
export function resolveMarkdownResourceUrls(html: string, apiBaseUrl: string): string {
  if (!apiBaseUrl.trim() || (!html.includes('<img') && !html.includes('<a'))) return html

  return html.replace(/<(img|a)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag: string, tagName: string) => {
    const resourceAttribute = tagName.toLowerCase() === 'img' ? 'src' : 'href'

    return tag.replace(
      /(\s+)([^\s=/>]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g,
      (attribute: string, whitespace: string, name: string, equals: string, doubleValue?: string, singleValue?: string) => {
        if (name.toLowerCase() !== resourceAttribute) return attribute

        const quote = doubleValue === undefined ? "'" : '"'
        const url = doubleValue ?? singleValue ?? ''

        // 磁盘绝对路径（盘符/UNC/Unix 根，markdown-it 百分号编码后形态）：webview
        // 无法直接渲染（盘符被当协议、根路径被拼 apiBaseUrl 后 404）——src 换透明
        // 占位防裂图闪现，剥编码后的磁盘路径存 data-absolute-src，由
        // MarkdownRenderer 走 /api/files/raw 带 auth 拉字节转 objectURL 替换
        // （与 ToolInvocation 的 view_image 绝对路径同链路；拉不到静默移除）。
        // 存储值仅再转义裸引号：markdown-it 已把 &<> 转成实体，浏览器解析属性时
        // 自会还原，双重转义反而出错。
        if (resourceAttribute === 'src') {
          const decoded = decodeUriLoose(url)
          if (isServerSideAbsolutePath(decoded)) {
            const diskPath = toDiskPathForm(decoded).replace(/"/g, '&quot;')
            return `${whitespace}src${equals}"${TRANSPARENT_PIXEL}" data-absolute-src="${diskPath}"`
          }
        }

        return `${whitespace}${name}${equals}${quote}${resolveMediaUrl(url, apiBaseUrl) ?? ''}${quote}`
      },
    )
  })
}
