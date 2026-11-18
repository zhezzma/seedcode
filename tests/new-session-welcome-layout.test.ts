import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const chatHeaderPath = path.resolve(testDir, '../src/components/chat/ChatHeader.vue')
const chatInputPath = path.resolve(testDir, '../src/components/chat/ChatInput.vue')
const homeViewPath = path.resolve(testDir, '../src/views/HomeView.vue')

const chatHeaderSource = readFileSync(chatHeaderPath, 'utf8')
const chatInputSource = readFileSync(chatInputPath, 'utf8')
const homeViewSource = readFileSync(homeViewPath, 'utf8')

test('the top navigation bar no longer renders the new-session agent dropdown', () => {
    assert.doesNotMatch(
        chatHeaderSource,
        /showAgentDropdown/,
        'ChatHeader should not keep the new-session agent dropdown state',
    )

    assert.doesNotMatch(
        chatHeaderSource,
        /<details[\s\S]*dropdown-content[\s\S]*selectAgent/,
        'ChatHeader title area must not render a dropdown menu anymore',
    )

    assert.match(
        chatHeaderSource,
        /\{\{ sessionName \}\}/,
        'ChatHeader must keep rendering the session name exactly as before',
    )

    const titleSection = chatHeaderSource.match(/<template #title>[\s\S]*?<\/template>/)
    assert.ok(titleSection, 'ChatHeader should keep a title section')
    assert.match(
        titleSection[0],
        /v-if="isSession"/,
        'the session name + agent badge must be hidden on the new-session page (only rendered inside a session)',
    )
})

test('the new-session welcome page centers the greeting, agent dropdown and chat input', () => {
    assert.match(
        homeViewSource,
        /greetingKey/,
        'HomeView should render a time-based greeting on the welcome page',
    )

    const welcomeCard = homeViewSource.match(/<ChatInput ref="chatInputRef" centered[\s\S]*?<\/ChatInput>/)
    assert.ok(welcomeCard, 'HomeView should render a centered ChatInput on the new-session page')

    assert.match(
        welcomeCard[0],
        /<template #top>[\s\S]*selectWelcomeAgent\(agent\.id\)[\s\S]*<\/template>/,
        'the agent dropdown should live in the centered input card top slot',
    )

    const bottomInput = homeViewSource.match(/<ChatInput v-if="!isNewSessionPage && !isCreatingSession"/)
    assert.ok(bottomInput, 'the docked bottom ChatInput should be hidden on the new-session page')
})

test('the command dropdown stays on session pages but is hidden on the centered new-session card', () => {
    const commandSection = chatInputSource.match(/<!-- Command（新会话页居中卡片不显示[\s\S]*?<!-- Model/)
    assert.ok(commandSection, 'the command dropdown section should remain in ChatInput')

    assert.match(
        commandSection[0],
        /v-if="!centered"/,
        'the command dropdown should be gated behind !centered so session pages keep the old toolbar',
    )

    assert.match(chatInputSource, /handleCommandSelect/, 'the command dropdown handler should stay wired up')

    assert.match(
        chatInputSource,
        /commandSuggestionsVisible/,
        'typing "/" should still open the command suggestion panel',
    )
})
