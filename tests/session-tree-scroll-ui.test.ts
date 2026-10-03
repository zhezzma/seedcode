import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const src = (...parts: string[]) => readFileSync(path.resolve(testDir, '../src', ...parts), 'utf8')

test('chat state keeps tree data but no client rewrite-from-here action', () => {
    const source = src('composables/useChatState.ts')

    assert.match(source, /sessionLeafId: string \| null/)
    assert.match(source, /preview\?: string/)
    assert.doesNotMatch(source, /rewriteFromHere/)
    assert.doesNotMatch(source, /rewrite-from-here/)
})

test('virtual message list exposes entry scrolling for virtualized rows', () => {
    const source = src('components/chat/VirtualMessageList.vue')

    assert.match(source, /const scrollToEntry = async \(entryId: string\)/)
    assert.match(source, /defineExpose\(\{\s*scrollToEntry,\s*activeEntryId\s*\}\)/)
    assert.match(source, /querySelectorAll<HTMLElement>\('\[data-key\]'\)/)
    assert.match(source, /scrollIntoView\(\{ block: 'center', inline: 'nearest' \}\)/)
})

test('chat header still exposes a tree button event for the session page', () => {
    const source = src('components/chat/ChatHeader.vue')

    assert.match(source, /QueueListIcon/)
    assert.match(source, /\(e: 'open-session-tree'\): void/)
    assert.match(source, /emit\('open-session-tree'\)/)
    assert.match(source, /\$t\('chat\.openSessionTree'\)/)
})

test('session tree modal emits jump-to-entry on message node click', () => {
    const source = src('components/chat/SessionTreeModal.vue')

    assert.match(source, /\(e: 'jump-to-entry', entryId: string\): void/)
    assert.match(source, /const canJump = \(entry: SessionTreeEntry\) => entry\.type === 'message'/)
    assert.match(source, /emit\('jump-to-entry', row\.entry\.id\)/)
    assert.match(source, /entry\.preview/)
    // TUI 风格：box-drawing 树形前缀
    assert.match(source, /'└─ ' : '├─ '/)
    assert.doesNotMatch(source, /rewrite-from-here/)
    assert.doesNotMatch(source, /rewriteFromHere/)
})

test('home view opens tree from button or /tree and scrolls selected nodes', () => {
    const source = src('views/HomeView.vue')

    assert.match(source, /SessionTreeModal/)
    assert.match(source, /const virtualMessageListRef = ref<InstanceType<typeof VirtualMessageList> \| null>\(null\)/)
    assert.match(source, /const handleJumpToTreeEntry = async \(entryId: string\)/)
    // 分支判定以消息列表为准（chatMessages 恒为当前分支权威视图）：树只在
    // load/done/abort/navigate 刷新，运行中 attach 增量补进的 entryId 会领先于树，
    // 用 leaf→root 路径判定会把当前分支新条目误判为「别的分支」，busy 时误弹
    // 「请等待当前消息发送完成」（rail 点击最后几条的离谱 toast）
    assert.match(source, /const currentBranchIds = new Set\(/)
    assert.match(source, /chatState\.chatMessages[\s\S]*?\.map\(message => message\.entryId\)/)
    assert.doesNotMatch(source, /currentPathIds/)
    assert.match(source, /if \(!currentBranchIds\.has\(entryId\)\)/)
    assert.match(source, /findBranchLeafId\(entryId, branchIndexes\.value\)/)
    assert.match(source, /const navigated = await chatState\.navigateBranch\(leafId\)/)
    assert.match(source, /if \(!navigated\)/)
    // 向上找最近可见祖先（合并 / 空内容节点友好跳转）
    assert.match(source, /while \(target && !visibleIds\.has\(target\)\)/)
    assert.match(source, /await virtualMessageListRef\.value\?\.scrollToEntry\(target\)/)
    assert.match(source, /const isTreeCommand = inputText\.trim\(\) === '\/tree'/)
    assert.match(source, /@open-session-tree="openSessionTree"/)
    assert.match(source, /@jump-to-entry="handleJumpToTreeEntry"/)
    assert.doesNotMatch(source, /rewriteFromHere/)
    assert.doesNotMatch(source, /rewrite-from-here/)
})
