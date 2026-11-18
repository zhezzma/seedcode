import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const componentPath = path.resolve(testDir, '../src/components/chat/ChatInput.vue')
const source = readFileSync(componentPath, 'utf8')

const thinkingSectionStart = '<!-- Thinking Level'
const thinkingSectionEnd = '<!-- Right Actions -->'
const start = source.indexOf(thinkingSectionStart)
const end = source.indexOf(thinkingSectionEnd, start)

assert.notEqual(start, -1, 'missing thinking dropdown section start marker')
assert.notEqual(end, -1, 'missing thinking dropdown section end marker')

const thinkingSection = source.slice(start, end)

test('thinking dropdown uses the same selected colors as the model dropdown', () => {
    assert.match(
        thinkingSection,
        /:class="\{\s*'bg-primary\/10 text-primary'\s*:\s*thinkingLevel\s*===\s*level\s*\}"/,
        'thinking dropdown should use the model dropdown selected colors so light and dark themes stay consistent',
    )
})

test('thinking dropdown uses a narrower width class', () => {
    assert.match(
        thinkingSection,
        /class="dropdown-content menu p-2 shadow-xl bg-base-100 rounded-box w-36 border border-base-300 mb-2 z-\[100\]"/,
        'thinking dropdown should shrink from the previous w-40 width to w-36',
    )
})

test('thinking dropdown places the selected check icon on the right side', () => {
    assert.match(
        thinkingSection,
        /\$t\(`chat\.thinkingLevels\.\$\{level\}`\)[\s\S]*<CheckIcon\s+v-if="thinkingLevel === level"\s+class="h-4 w-4 shrink-0"\s*\/>/s,
        'thinking dropdown should render the selected check icon after the label so it appears on the right side',
    )

    assert.match(
        thinkingSection,
        /\$t\(`chat\.thinkingLevels\.\$\{level\}`\)[\s\S]*<span\s+v-else\s+class="w-4 h-4 shrink-0"><\/span>/s,
        'thinking dropdown should keep a right-side placeholder for unselected items so labels stay aligned',
    )
})
