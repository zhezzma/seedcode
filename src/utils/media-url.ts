/** Resolve media references returned by the backend against the configured API origin. */
export function resolveMediaUrl(url: string | undefined, apiBaseUrl: string): string | undefined {
  if (!url) return url

  // AI 偶发把服务端相对路径 /assets/... 补全成绝对 URL：https://assets/...（host 恰为
  // assets）、https:///assets/...（机械拼接的三斜杠）、https:/assets/...（单斜杠）。
  // host 为 assets 或为空都不是真实主机，链接注定解析失败——识别这类畸形并还原成
  // /assets/... 相对路径，交由下方常规拼接（apiBaseUrl 为空则保持相对路径原样）。
  const malformed = /^https?:\/{1,3}(assets)?(\/.+)$/i.exec(url)
  if (malformed) {
    // assets 被吞成 host：还原时补回 /assets 前缀（https://assets/audios/x.mp3 →
    // /assets/audios/x.mp3）；host 为空则路径自身已带 /assets 前缀
    const restored = malformed[1] ? `/assets${malformed[2]}` : malformed[2]
    if (restored.startsWith('/assets/')) return resolveMediaUrl(restored, apiBaseUrl)
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('//')) return url

  const baseUrl = apiBaseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) return url

  return `${baseUrl}/${url.replace(/^\/+/, '')}`
}

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
        return `${whitespace}${name}${equals}${quote}${resolveMediaUrl(url, apiBaseUrl) ?? ''}${quote}`
      },
    )
  })
}
