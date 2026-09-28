import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const chatInputSource = readFileSync(path.resolve(testDir, '../src/composables/useChatInput.ts'), 'utf8')
const homeViewSource = readFileSync(path.resolve(testDir, '../src/views/HomeView.vue'), 'utf8')

test('input box content is recorded as per-session draft in the existing inputText watch', () => {
    assert.match(
        chatInputSource,
        /watch\(inputText, \(val\) => \{[\s\S]*?setDraft\(_sessionKeyResolver/,
        'useChatInput should save the draft keyed by the current session inside the existing watch(inputText)',
    )
})

test('session switch restores the draft in the existing route watcher', () => {
    // /new 分支（createNewSession）与切会话分支（setSessionKey）都要恢复草稿
    assert.match(
        homeViewSource,
        /await chatState\.createNewSession\(\)\s*\n\s*\/\/ 恢复 \/new 页遗留的输入草稿\s*\n\s*restoreSessionDraft\(\)/,
        'the /new branch should restore the new-session draft',
    )
    assert.match(
        homeViewSource,
        /await chatState\.setSessionKey\(sessionkey\)\s*\n\s*\/\/ 恢复该会话的输入草稿\s*\n\s*restoreSessionDraft\(\)/,
        'the session-switch branch should restore that session draft',
    )
})

test('attachment changes are persisted per session next to the text draft', () => {
    assert.match(
        chatInputSource,
        /watch\(attachments, \(list\) => \{[\s\S]*?setDraftAttachments\(_sessionKeyResolver/,
        'useChatInput should save attachments keyed by the current session (gateway sentinel on /new)',
    )
})

test('session switch restores attachment drafts with regenerated runtime ids', () => {
    assert.match(
        chatInputSource,
        /getDraftAttachments\(key\)[\s\S]{0,400}createRuntimeId\('attachment'\)/,
        'restoreSessionDraft should restore attachments from the store and regenerate runtime ids',
    )
})
