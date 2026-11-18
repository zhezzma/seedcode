import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const componentPath = path.resolve(testDir, '../src/components/chat/ChatInput.vue')
const source = readFileSync(componentPath, 'utf8')

const modelSectionStart = '<!-- Model'
const modelSectionEnd = '<!-- Thinking Level'
const start = source.indexOf(modelSectionStart)
const end = source.indexOf(modelSectionEnd, start)

assert.notEqual(start, -1, 'missing model dropdown section start marker')
assert.notEqual(end, -1, 'missing model dropdown section end marker')

const modelSection = source.slice(start, end)

test('chat input reuses the shared model menu content component', () => {
    assert.match(
        source,
        /import ModelSelectMenuContent from '\.\.\/models\/ModelSelectMenuContent\.vue'/,
        'ChatInput should import the shared model menu content component',
    )

    assert.match(
        modelSection,
        /<ModelSelectMenuContent[\s\S]*@select="handleModelSelect"/s,
        'ChatInput should render the shared model menu content component and keep using handleModelSelect',
    )

    assert.doesNotMatch(
        modelSection,
        /v-for="group in availableModels"/,
        'ChatInput should no longer inline the model group rendering after extracting the shared component',
    )
})
