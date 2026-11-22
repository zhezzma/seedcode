import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveMarkdownResourceUrls, resolveMediaUrl } from '../src/utils/media-url.ts'

test('resolves non-http media URLs against apiBaseUrl', () => {
  assert.equal(
    resolveMediaUrl('/assets/images/session/id/image.png', 'http://tauri.localhost/'),
    'http://tauri.localhost/assets/images/session/id/image.png',
  )
  assert.equal(
    resolveMediaUrl('images/local.png', 'https://agent.example.com/api'),
    'https://agent.example.com/api/images/local.png',
  )
  assert.equal(
    resolveMediaUrl('./images/local.png', 'https://agent.example.com/api'),
    'https://agent.example.com/api/./images/local.png',
  )
  assert.equal(
    resolveMediaUrl('../images/local.png', 'https://agent.example.com/api'),
    'https://agent.example.com/api/../images/local.png',
  )
})

test('does not rewrite absolute schemes, fragments, or protocol-relative URLs', () => {
  for (const url of [
    'https://example.com/a.png',
    'http://example.com/a.png',
    'mailto:user@example.com',
    'tel:+123456789',
    'data:image/png;base64,abc',
    'blob:http://localhost/id',
    '#section',
    '//cdn.example.com/a.png',
  ]) {
    assert.equal(resolveMediaUrl(url, 'http://tauri.localhost'), url)
  }
})

test('rewrites Markdown img src values with the shared media URL resolver', () => {
  const html = '<p><img src="images/local.png"><img src="https://example.com/a.png"></p>'
  assert.equal(
    resolveMarkdownResourceUrls(html, 'http://tauri.localhost'),
    '<p><img src="http://tauri.localhost/images/local.png"><img src="https://example.com/a.png"></p>',
  )
})

test('rewrites Markdown link href values with the shared media URL resolver', () => {
  const html = '<p><a href="/assets/images/session/id/image.png">查看原图</a></p>'
  assert.equal(
    resolveMarkdownResourceUrls(html, 'http://tauri.localhost'),
    '<p><a href="http://tauri.localhost/assets/images/session/id/image.png">查看原图</a></p>',
  )
})

test('rewrites actual resource attributes without changing attribute-like metadata', () => {
  const html = `<p><a title="href='before'" href="docs/file.md" data-note="href='after'">文档</a><img alt="src='before.png'" src="images/a.png" title="src='after.png'"></p>`
  assert.equal(
    resolveMarkdownResourceUrls(html, 'http://tauri.localhost'),
    `<p><a title="href='before'" href="http://tauri.localhost/docs/file.md" data-note="href='after'">文档</a><img alt="src='before.png'" src="http://tauri.localhost/images/a.png" title="src='after.png'"></p>`,
  )
})

test('does not treat quoted tag delimiters or metadata as resource attributes', () => {
  const html = `<a title="before href='metadata' > after" href="docs/file.md">文档</a>`
  assert.equal(
    resolveMarkdownResourceUrls(html, 'http://tauri.localhost'),
    `<a title="before href='metadata' > after" href="http://tauri.localhost/docs/file.md">文档</a>`,
  )
})

test('leaves non-relative Markdown resource URLs unchanged', () => {
  const html = '<p><a href="mailto:user@example.com">邮件</a><a href="#section">章节</a><img src="//cdn.example.com/a.png"></p>'
  assert.equal(resolveMarkdownResourceUrls(html, 'http://tauri.localhost'), html)
})

test('restores pseudo-host asset URLs the AI mis-expanded from /assets/... paths', () => {
  // AI 偶发把服务端相对路径 /assets/audios/... 补全成 https://assets/...（host 恰为
  // assets）：还原回 /assets/... 相对路径后按常规拼接
  assert.equal(
    resolveMediaUrl('https://assets/audios/session/GYJClient-25436/sound-x.mp3', 'https://agent.example.com/api'),
    'https://agent.example.com/api/assets/audios/session/GYJClient-25436/sound-x.mp3',
  )
  // http 变体
  assert.equal(
    resolveMediaUrl('http://assets/audios/a.mp3', 'https://agent.example.com/api'),
    'https://agent.example.com/api/assets/audios/a.mp3',
  )
  // https:// + 相对路径机械拼接出的三斜杠形态（host 为空，路径自带 /assets 前缀）
  assert.equal(
    resolveMediaUrl('https:///assets/audios/a.mp3', 'https://agent.example.com/api'),
    'https://agent.example.com/api/assets/audios/a.mp3',
  )
  // 单斜杠形态
  assert.equal(
    resolveMediaUrl('https:/assets/audios/a.mp3', 'https://agent.example.com/api'),
    'https://agent.example.com/api/assets/audios/a.mp3',
  )
  // apiBaseUrl 为空：还原成相对路径（与常规相对路径同策略，保持可诊断形态）
  assert.equal(resolveMediaUrl('https://assets/audios/a.mp3', ''), '/assets/audios/a.mp3')
})

test('restores loopback-origin asset URLs the AI hallucinated', () => {
  // AI 把 /assets/... 补全成 http://localhost/...：origin 幻觉成客户端自身的环回
  // 地址（无端口），在用户设备上永远不是服务端，注定死链——还原后按常规拼接
  assert.equal(
    resolveMediaUrl('http://localhost/assets/audios/session/GYJClient-25436/sound-x.mp3', 'https://agent.example.com/api'),
    'https://agent.example.com/api/assets/audios/session/GYJClient-25436/sound-x.mp3',
  )
  // 环回地址族同款处理
  assert.equal(
    resolveMediaUrl('http://127.0.0.1/assets/a.mp3', 'https://agent.example.com/api'),
    'https://agent.example.com/api/assets/a.mp3',
  )
  // 环回主机只还原 /assets/ 路径：其余路径可能是设备上真实存在的本地服务
  assert.equal(
    resolveMediaUrl('http://localhost/other/x.png', 'https://agent.example.com/api'),
    'http://localhost/other/x.png',
  )
  // 还原后再拼接：对本机部署（apiBaseUrl 恰为同一环回 origin）自然得到等价 URL，无需特判
  assert.equal(resolveMediaUrl('http://localhost/assets/a.mp3', 'http://localhost'), 'http://localhost/assets/a.mp3')
})

test('leaves loopback URLs with an explicit port alone', () => {
  // 带端口的环回 URL 更可能是真实本机部署：保守放行（伪主机组后必须紧跟 /，
  // 端口形态天然不命中）
  for (const url of [
    'http://localhost:18789/assets/a.mp3',
    'https://127.0.0.1:8443/assets/a.mp3',
  ]) {
    assert.equal(resolveMediaUrl(url, 'https://agent.example.com/api'), url)
  }
})

test('rewrites hallucinated localhost asset links inside Markdown', () => {
  const html = '<p><a href="http://localhost/assets/audios/session/id/sound.mp3">🔊 播放</a></p>'
  assert.equal(
    resolveMarkdownResourceUrls(html, 'http://tauri.localhost'),
    '<p><a href="http://tauri.localhost/assets/audios/session/id/sound.mp3">🔊 播放</a></p>',
  )
})

test('does not rewrite real hosts that merely resemble the asset pseudo-host', () => {
  for (const url of [
    'https://example.com/a.png',
    'https://example.com/assets/a.png',
    'https://assets.example.com/a.png',
    'https://assetsfoo/a.png',
  ]) {
    assert.equal(resolveMediaUrl(url, 'http://tauri.localhost'), url)
  }
})

test('rewrites malformed pseudo-host asset links inside Markdown', () => {
  const html = '<p><a href="https://assets/audios/session/id/sound.mp3">🔊 播放</a></p>'
  assert.equal(
    resolveMarkdownResourceUrls(html, 'http://tauri.localhost'),
    '<p><a href="http://tauri.localhost/assets/audios/session/id/sound.mp3">🔊 播放</a></p>',
  )
})

test('leaves relative URLs unchanged when apiBaseUrl is empty', () => {
  assert.equal(resolveMediaUrl('/assets/a.png', ''), '/assets/a.png')
  const html = '<p><a href="/assets/a.png">资源</a><img src="images/a.png"></p>'
  assert.equal(resolveMarkdownResourceUrls(html, ''), html)
})

// ─── 磁盘绝对路径 img：换透明占位 + data-absolute-src 打标 ─────────────────────

test('markdown img 磁盘绝对路径 src 换透明占位 + data-absolute-src 打标（交 raw 端点拉取）', () => {
  // markdown-it 百分号编码形态（\ → %5C）：webview 直渲染必裂（盘符被当协议），
  // 剔除直渲染改走 /api/files/raw 拉 blob（与 ToolInvocation view_image 同链路）
  const html = '<p><img src="D:%5Cpics%5Cimg.png" alt="a"></p>'
  assert.equal(
    resolveMarkdownResourceUrls(html, 'http://tauri.localhost'),
    `<p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-absolute-src="D:\\pics\\img.png" alt="a"></p>`,
  )
})

test('Unix 根路径 img 同样打标（直渲染会被拼 apiBaseUrl 后 404）', () => {
  const html = '<p><img src="/home/user/img.png"></p>'
  const out = resolveMarkdownResourceUrls(html, 'http://tauri.localhost')
  assert.match(out, /data-absolute-src="\/home\/user\/img\.png"/)
  // 不再拼 apiBaseUrl（直渲染必 404）
  assert.doesNotMatch(out, /tauri\.localhost\/home\/user\/img\.png/)
})

test('UNC / 空格 / CJK / 畸形 % 的编码形态都能剥出真实磁盘路径', () => {
  // UNC（markdown 源里双写反斜杠 → markdown-it 编码为 %5C%5C；单前导 %5C 是
  // 被转义折叠的相对路径，不命中绝对路径分支）
  assert.match(
    resolveMarkdownResourceUrls('<img src="%5C%5Cserver%5Cshare%5Cimg.png">', 'http://x'),
    /data-absolute-src="\\\\server\\share\\img\.png"/,
  )
  // 空格（<> 包裹形式 → %20）
  assert.match(
    resolveMarkdownResourceUrls('<img src="/home/user/my%20img.png">', 'http://x'),
    /data-absolute-src="\/home\/user\/my img\.png"/,
  )
  // CJK（UTF-8 百分号序列）
  assert.match(
    resolveMarkdownResourceUrls('<img src="C:/Users/me/%E5%9B%BE1.png">', 'http://x'),
    /data-absolute-src="C:\/Users\/me\/图1\.png"/,
  )
  // 畸形 % 序列（decodeURIComponent 抛 → 回退原样，仍按绝对路径打标）
  assert.match(
    resolveMarkdownResourceUrls('<img src="/home/user/50%off.png">', 'http://x'),
    /data-absolute-src="\/home\/user\/50%off\.png"/,
  )
})

test('data-absolute-src 存储值保留实体形态（浏览器解析属性时自会还原，不双重转义）', () => {
  // markdown-it 把 & 转成 &amp;：原样存入，浏览器 getAttribute 还原为 &；
  // 若在这里再转义一次会得到 &amp;amp; → 真实路径被写坏
  assert.match(
    resolveMarkdownResourceUrls('<img src="/home/user/a&amp;b.png">', 'http://x'),
    /data-absolute-src="\/home\/user\/a&amp;b\.png"/,
  )
})

test('/assets、远程 URL、相对路径、data URI 的 img 不打标（仍走直渲染）', () => {
  const html = [
    '<img src="/assets/a.png">',
    '<img src="https://cdn.example.com/b.png">',
    '<img src="//cdn.example.com/c.png">',
    '<img src="sessions/sid/x.png">',
    '<img src="data:image/png;base64,QUJD">',
  ].join('')
  const out = resolveMarkdownResourceUrls(html, 'http://tauri.localhost')
  assert.ok(!out.includes('data-absolute-src'), '非磁盘绝对路径不应打标')
  assert.ok(out.includes('http://tauri.localhost/assets/a.png'))
  assert.ok(out.includes('https://cdn.example.com/b.png'))
  assert.ok(out.includes('http://tauri.localhost/sessions/sid/x.png'))
  assert.ok(out.includes('data:image/png;base64,QUJD'))
})

test('a href 磁盘绝对路径不打标（仅图片处理；链接维持既有 apiBaseUrl 拼接行为）', () => {
  const html = '<p><a href="/home/user/img.png">查看原图</a></p>'
  const out = resolveMarkdownResourceUrls(html, 'http://tauri.localhost')
  assert.ok(!out.includes('data-absolute-src'))
  assert.equal(out, '<p><a href="http://tauri.localhost/home/user/img.png">查看原图</a></p>')
})

test('apiBaseUrl 为空时绝对路径 img 不打标（未连接时保持原样可诊断，与既有空 base 策略一致）', () => {
  const html = '<p><img src="/home/user/img.png"></p>'
  assert.equal(resolveMarkdownResourceUrls(html, ''), html)
})
