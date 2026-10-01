import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const componentPath = path.resolve(testDir, '../src/components/chat/MessageBubble.vue')
const source = readFileSync(componentPath, 'utf8')

const getSection = (startMarker: string, endMarker: string) => {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start)
    assert.notEqual(start, -1, `missing section start: ${startMarker}`)
    assert.notEqual(end, -1, `missing section end: ${endMarker}`)
    return source.slice(start, end)
}

// 2026-10：单条消息删除按钮已下线（v4 存储层 append-only，「删除」实为叶子回退，
// 与会话树导航重复）——本文件从「retry 在 delete 前」顺序钉子改为：
// retry 仍在 + 删除按钮不再回归（防止有人无意把按钮加回来而背后无真删除能力）。
const assertToolbar = (section: string, name: string) => {
    const retryIndex = section.indexOf(":title=\"$t('chat.retry')\"")

    assert.notEqual(retryIndex, -1, `${name} section should contain retry button`)
    assert.equal(
        section.indexOf('@click="handleDelete"'),
        -1,
        `${name} toolbar must not reintroduce the delete button`,
    )
    assert.equal(
        section.indexOf(":title=\"$t('common.delete')\""),
        -1,
        `${name} toolbar must not reference common.delete`,
    )
}

test('user toolbar keeps retry and stays free of the removed delete button', () => {
    const section = getSection('<!-- User Actions (Hover) -->', '<!-- Assistant Message Bubble -->')
    assertToolbar(section, 'user')
})

test('assistant toolbar keeps retry and stays free of the removed delete button', () => {
    const section = getSection('<!-- Assistant Actions (Fixed) -->', '<!-- Branch Navigation -->')
    assertToolbar(section, 'assistant')
})
