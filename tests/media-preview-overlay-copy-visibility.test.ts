import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')
const source = readFileSync(path.join(repoRoot, 'src/components/chat/MediaPreviewOverlay.vue'), 'utf8')

test('overlay still keeps the download button visible while gating copy only', () => {
  // isMobileDevice 由 useMediaPreview 提供（composable 侧定义），组件只消费
  assert.match(source, /^    isMobileDevice,$/m)
  assert.match(source, /= useMediaPreview\(\)/)
  assert.match(source, /<button v-if="!isMobileDevice" @click\.stop="copyImageToClipboard\(lightboxSrc\)"/)

  const toolsSectionMatch = source.match(/<!-- Tools -->\s*<div([^>]*)>[\s\S]*?<!-- Close -->/)
  assert.ok(toolsSectionMatch, 'expected to find the overlay tools section')
  assert.doesNotMatch(toolsSectionMatch[1], /\bv-if=/)
  assert.doesNotMatch(toolsSectionMatch[1], /isMobileDevice/)

  const downloadButtonMatch = toolsSectionMatch[0].match(/<!-- Download -->\s*<button([^>]*)@click\.stop="downloadImage\(lightboxSrc\)"([^>]*)>/)
  assert.ok(downloadButtonMatch, 'expected the download button to be rendered in the tools section')
  assert.doesNotMatch(downloadButtonMatch[0], /\bv-if=/)
  assert.doesNotMatch(downloadButtonMatch[0], /isMobileDevice/)

  assert.match(source, /copyImageToClipboard/)
})
