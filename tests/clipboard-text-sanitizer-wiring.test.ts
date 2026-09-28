import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')

const clipboardUtilsSource = readFileSync(path.join(repoRoot, 'src/utils/clipboard.ts'), 'utf8')
const homeViewSource = readFileSync(path.join(repoRoot, 'src/views/HomeView.vue'), 'utf8')
const markdownCodeTitleSource = readFileSync(path.join(repoRoot, 'src/utils/markdown/markdown-it-code-title.ts'), 'utf8')
const mermaidRenderSource = readFileSync(path.join(repoRoot, 'src/utils/markdown/mermaid-render.ts'), 'utf8')

test('writeClipboard strips a leading BOM before writing text without exporting payload helpers', async () => {
  const mod = await import('../src/utils/clipboard.ts')

  assert.equal(typeof mod.buildClipboardTextPayload, 'undefined')

  const writes: string[] = []
  const originalNavigator = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText(text: string) {
          writes.push(text)
          return Promise.resolve()
        }
      }
    }
  })

  try {
    await mod.writeClipboard('\uFEFFhello')
    await mod.writeClipboard('a\uFEFFb')
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator
    })
  }

  assert.deepEqual(writes, ['hello', 'a\uFEFFb'])
  assert.match(clipboardUtilsSource, /const buildClipboardTextPayload = \(text: string\) => text\.replace\(\/\^\\uFEFF\/, ''\)/)
  // 原生优先（invoke write_clipboard_text），但两条路径都必须写入清洗后的 payload
  assert.match(clipboardUtilsSource, /export const writeClipboard = async \(text: string\) =>/)
  assert.match(clipboardUtilsSource, /const payload = buildClipboardTextPayload\(text\)/)
  assert.match(clipboardUtilsSource, /invoke\('write_clipboard_text', \{ text: payload \}\)/)
  assert.match(clipboardUtilsSource, /return navigator\.clipboard\.writeText\(payload\)/)
  assert.doesNotMatch(clipboardUtilsSource, /export const buildClipboardTextPayload/)
})

test('text-copy entry points use the shared clipboard writer', () => {
  assert.match(homeViewSource, /from ['"]\.\.\/utils\/clipboard(?:\.ts)?['"]/)
  assert.match(homeViewSource, /writeClipboard\(text\)/)

  assert.match(markdownCodeTitleSource, /from ['"]\.\.\/clipboard(?:\.ts)?['"]/)
  assert.match(markdownCodeTitleSource, /writeClipboard\(code\)/)

  assert.match(mermaidRenderSource, /from ['"]\.\.\/clipboard(?:\.ts)?['"]/)
  assert.match(mermaidRenderSource, /writeClipboard\(originalCode\)/)
})
