import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')
const markdownRendererSource = readFileSync(
  path.join(repoRoot, 'src/components/chat/MarkdownRenderer.vue'),
  'utf8',
)

test('Markdown images open the shared media preview when clicked', () => {
  assert.match(markdownRendererSource, /useMediaPreview/)
  assert.match(markdownRendererSource, /target instanceof HTMLImageElement/)
  assert.match(markdownRendererSource, /openLightbox\(target\.currentSrc \|\| target\.src\)/)
  assert.match(markdownRendererSource, /@click="handleContentClick"/)
})

test('Markdown images expose the same hover download action as chat images', () => {
  assert.match(markdownRendererSource, /downloadImage/)
  assert.match(markdownRendererSource, /data-markdown-image-download/)
  assert.match(markdownRendererSource, /downloadImage\(image\.currentSrc \|\| image\.src\)/)
  assert.match(markdownRendererSource, /\.markdown-image-preview:hover/)
  assert.match(markdownRendererSource, /\.markdown-image-preview:focus-within/)
  assert.match(markdownRendererSource, /\[data-markdown-image-download\] svg[\s\S]*?width:\s*1rem[\s\S]*?height:\s*1rem/)
})

test('Markdown image controls preserve valid linked-image markup and keyboard preview', () => {
  assert.match(markdownRendererSource, /image\.closest\('a'\)/)
  assert.match(markdownRendererSource, /wrapper\.appendChild\(previewTarget\)/)
  assert.match(markdownRendererSource, /wrapper\.appendChild\(downloadButton\)/)
  assert.match(markdownRendererSource, /@keydown="handleContentKeydown"/)
  assert.match(markdownRendererSource, /event\.key !== 'Enter' && event\.key !== ' '/)
  assert.doesNotMatch(markdownRendererSource, /addMarkdownImageActions/)
})

test('Markdown 绝对路径图片走 fetchRawFile absolute scope 拉取后替换占位 src', () => {
  // resolveMarkdownResourceUrls 打的 data-absolute-src 标 → DOM 阶段消费
  assert.match(markdownRendererSource, /img\[data-absolute-src\]/,
    '应扫描 data-absolute-src 占位图')
  assert.match(markdownRendererSource, /getAttribute\('data-absolute-src'\)/,
    '应从属性取磁盘路径（已在 resolveMarkdownResourceUrls 剥过百分号编码）')
  assert.match(markdownRendererSource, /fetchRawFile\(\s*''[^)]*'absolute'/,
    '绝对路径应走 fetchRawFile(\'\', path, \'absolute\')（/api/files/raw，无需 agentId）')
  assert.match(markdownRendererSource, /URL\.createObjectURL/,
    '应把 blob 转 objectURL 渲染')
  assert.match(markdownRendererSource, /revokeObjectURL/,
    '应释放 objectURL（防泄漏）')
  assert.match(markdownRendererSource, /onUnmounted/,
    '卸载时应中止在途拉取并释放缓存')
  // 中止守卫回归锁：挂载期 watch immediate + onMounted 双发 renderContent，
  // v-html 同值不重建 DOM——旧轮 fetch 被 AbortError 拒绝但元素仍存活，
  // catch 若不区分中止与真失败会把存活 wrapper 静默移除（图片确定性消失）
  assert.match(markdownRendererSource, /catch \{[\s\S]*?if \(abort\.signal\.aborted\) return[\s\S]*?wrapper\.remove\(\)/,
    'catch 必须先查中止再决定移除（中止≠拉取失败）')
})
