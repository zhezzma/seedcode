import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { computeBranchTailFlags } from '../src/utils/chatBranchTail.ts'

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

// 背景 bug：用户在收到回复前点停止 → 空 aborted assistant 消息按设计零渲染
// （compaction-visibility.test.ts 钉死的签名，用户停止与在线压缩 abort 共用），
// 该分支上没有任何 assistant 气泡 → 分支导航只挂在 assistant footer 上 →
// 切到该分支（第一页）后没有任何导航/操作，成为死胡同。
// user 消息是每个分支的必现锚点，分支导航必须同样挂在 user footer 上，
// 但仅限分支尾锚场景（isBranchTail：紧随其后的不是本回合 assistant 回复）：
// 否则分叉点的 user 气泡与 assistant 气泡会对同一回合重复渲染 n/n 计数器；
// 且 isLastMessage 不够——分支被续写后（停止后直接输入新消息会挂在空 aborted
// 之下，见 SessionManager.appendMessage 的 leafId 语义）分叉点不再是末项。
test('user toolbar renders branch navigation for multi-branch sessions', () => {
    const section = getSection('<!-- User Actions (Hover) -->', '<!-- Assistant Message Bubble -->')

    assert.ok(
        section.includes('isBranchTail && branchInfo && branchInfo.siblings.length > 1'),
        'user toolbar should render branch navigation only as branch-tail anchor',
    )
    assert.ok(
        section.includes(`emit('navigate-branch', message, 'prev')`),
        'user toolbar branch navigation should emit prev',
    )
    assert.ok(
        section.includes(`emit('navigate-branch', message, 'next')`),
        'user toolbar branch navigation should emit next',
    )
    assert.ok(
        section.includes('branchInfo.currentIndex + 1'),
        'user toolbar branch navigation should show current page counter',
    )
})

test('user branch navigation sits in normal mode after action buttons', () => {
    const section = getSection('<!-- User Actions (Hover) -->', '<!-- Assistant Message Bubble -->')

    // 编辑态（v-if="isEditing" 分支）不应包含导航：编辑文本时横向切分支语义不明
    const normalModeStart = section.indexOf('<template v-else>')
    const retryIndex = section.indexOf(":title=\"$t('chat.retry')\"", normalModeStart)
    const navIndex = section.indexOf('isBranchTail && branchInfo', normalModeStart)

    assert.notEqual(normalModeStart, -1, 'user toolbar should keep a normal-mode branch')
    assert.notEqual(retryIndex, -1, 'user toolbar normal mode should keep retry button')
    assert.notEqual(navIndex, -1, 'user toolbar normal mode should render branch navigation')
    assert.ok(navIndex > retryIndex, 'user branch navigation should come after action buttons')
})

// isBranchTail 公式钉子：紧随其后的显示项不是 assistant 回复即分支尾锚
// （覆盖死胡同末项与「停止后直接续写」两个场景；正常回合 next 为 assistant，不渲染）
test('virtual list wires computeBranchTailFlags into MessageBubble', () => {
    const source = readFileSync(
        path.resolve(testDir, '../src/components/chat/VirtualMessageList.vue'),
        'utf8',
    )

    assert.ok(
        source.includes("from '../../utils/chatBranchTail'"),
        'virtual list should import the branch-tail helper',
    )
    assert.ok(
        source.includes('computeBranchTailFlags(props.messages)'),
        'virtual list should compute branch-tail flags from the display list',
    )
    assert.ok(
        source.includes(':is-branch-tail="item.isBranchTail"'),
        'isBranchTail should be wired through to MessageBubble',
    )
})

// computeBranchTailFlags 逐拓扑表驱动断言：正确性是拓扑相关的，源码字符串钉子
// 无法区分正确公式与看似合理的错公式（如 === 'user'、忽略末项）。
test('computeBranchTailFlags marks user anchors only without a following assistant reply', () => {
    const flags = (roles: string[]) => computeBranchTailFlags(roles.map(role => ({ role })))

    // 死胡同末项：分支尾部没有已渲染回复（空 aborted 零渲染 / 回复被删光）
    assert.deepEqual(flags(['user']), [true])
    // 停止后直接续写（新消息挂在空 aborted 之下）：分叉点 userA 是尾锚，uB 不是
    assert.deepEqual(flags(['user', 'user', 'assistant']), [true, false, false])
    // 正常回合：下一项就是本回合 assistant 回复 → 不渲染（避免与 assistant 侧双 n/n）
    assert.deepEqual(flags(['user', 'assistant']), [false, false])
    // 多轮线性：只有末项 user（无回复）是尾锚
    assert.deepEqual(flags(['assistant', 'user', 'assistant', 'user']), [false, false, false, true])
    // 末项为排队中的 steer/follow-up（user 角色）：其前的 user 仍是尾锚
    assert.deepEqual(flags(['user', 'user']), [true, true])
    // 瞬态窗口（已知、稳态恢复）：流式占位/压缩行是 assistant 角色，短暂压制尾锚
    assert.deepEqual(flags(['user', 'assistant']), [false, false])
    // 非 user 行恒为 false
    assert.deepEqual(flags(['assistant', 'toolResult']), [false, false])
})
