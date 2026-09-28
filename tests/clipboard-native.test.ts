import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')
const clipboardSource = readFileSync(path.join(repoRoot, 'src/utils/clipboard.ts'), 'utf8')
const mediaPreviewSource = readFileSync(path.join(repoRoot, 'src/composables/useMediaPreview.ts'), 'utf8')
const libRsSource = readFileSync(path.join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8')

test('text copy prefers the native clipboard so Windows clipboard history records it', () => {
  // Tauri 环境检测 + 原生命令调用
  assert.match(clipboardSource, /__TAURI_INTERNALS__/)
  assert.match(clipboardSource, /invoke\('write_clipboard_text'/)
  // 非 Tauri 环境 / 原生写入失败时回退 WebView API
  assert.match(clipboardSource, /navigator\.clipboard\.writeText/)
})

test('image copy has a native branch with WebView fallback', () => {
  assert.match(mediaPreviewSource, /invoke\('write_clipboard_image'/)
  assert.match(mediaPreviewSource, /navigator\.clipboard\.write\(/)
})

test('rust side registers the clipboard commands', () => {
  assert.match(libRsSource, /fn write_clipboard_text/)
  assert.match(libRsSource, /fn write_clipboard_image/)
  assert.match(libRsSource, /fn write_clipboard_html/)
  assert.match(libRsSource, /write_clipboard_text,/)
  assert.match(libRsSource, /write_clipboard_image,/)
  assert.match(libRsSource, /write_clipboard_html,/)
})

test('selection copy is intercepted to native clipboard on desktop', () => {
  const mainTsSource = readFileSync(path.join(repoRoot, 'src/main.ts'), 'utf8')
  // 富文本原生命令 + 拦截器
  assert.match(clipboardSource, /invoke\('write_clipboard_html'/)
  assert.match(clipboardSource, /export const installNativeCopyInterceptor/)
  assert.match(clipboardSource, /addEventListener\('copy'/)
  assert.match(clipboardSource, /event\.preventDefault\(\)/)
  // 拦截器不改变移动端/非 Tauri 环境行为
  assert.match(clipboardSource, /MOBILE_USER_AGENT\.test\(navigator\.userAgent\)/)
  assert.match(mainTsSource, /installNativeCopyInterceptor\(\)/)
})
