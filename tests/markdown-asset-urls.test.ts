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
