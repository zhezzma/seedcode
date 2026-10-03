import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))

// ==================== Bug 1: fork 应锚定合并气泡的组内最后一条 entry ====================
//
// 背景：assistantMsgMerge 开启时，连续 assistant 消息合并为一条气泡，但气泡 entryId
// 始终是组内第一条，点击「从此处分叉」实际分叉到了第一轮回复。
// 约束：entryId 本身的语义不能改——会话树跳转（handleJumpToTreeEntry 的可见气泡反向
// 定位）与虚拟列表 key 都依赖它指向组内第一条，因此合并时额外维护 lastEntryId，
// fork 只读 lastEntryId。

test('toolResult 并入 tool 卡时同样刷新锚点（组尾为 toolResult 的 fork 锚点回归）', () => {
    const source = readFileSync(path.resolve(testDir, '../src/composables/useChatMessages.ts'), 'utf8')

    // toolResult 分支：更新 tool 卡状态后以 msg.entryId 刷新所属气泡的 lastEntryId
    //（组尾为 toolResult 时——交互工具挂起/abort 后的常态——fork 锚点必须落在
    //  toolResult 而非其前的 assistant toolCall，否则 fork 出的会话停在悬空调用上）
    const trStart = source.indexOf("if (msg.role === 'toolResult')")
    assert.notEqual(trStart, -1, '应存在 toolResult 处理分支')
    const trSection = source.slice(trStart, trStart + 2600)
    assert.match(
        trSection,
        /if \(msg\.entryId\) targetMsg\.lastEntryId = msg\.entryId/,
        'toolResult 并入时应刷新所属气泡的 lastEntryId（组内最后一条 entry）',
    )
})

test('useChatMessages 合并分支维护 lastEntryId 为组内最后一条 entry', () => {
    const source = readFileSync(path.resolve(testDir, '../src/composables/useChatMessages.ts'), 'utf8')

    // DisplayMessage 需声明 lastEntryId 字段
    const iface = source.slice(source.indexOf('export interface DisplayMessage'), source.indexOf('export interface ChatStateShape'))
    assert.ok(iface.includes('lastEntryId'), 'DisplayMessage 应声明 lastEntryId 字段')

    // 合并分支：push blocks 后以 msg.entryId 刷新 lastEntryId（无 entryId 的消息不覆盖）
    const mergeStart = source.indexOf('if (shouldMerge && lastMsg)')
    assert.notEqual(mergeStart, -1, '应存在 assistant 合并分支')
    const mergeSection = source.slice(mergeStart, mergeStart + 800)
    assert.match(
        mergeSection,
        /if \(msg\.entryId\) lastMsg\.lastEntryId = msg\.entryId/,
        '合并分支应维护 lastEntryId = 组内最后一条 entry 的 entryId',
    )
})

test('HomeView forkMessage 以 lastEntryId 优先锚定 fork 位置', () => {
    const source = readFileSync(path.resolve(testDir, '../src/views/HomeView.vue'), 'utf8')
    const fnStart = source.indexOf('const forkMessage')
    assert.notEqual(fnStart, -1, 'HomeView 应存在 forkMessage')
    const fnSection = source.slice(fnStart, fnStart + 400)
    assert.match(
        fnSection,
        /msg\.lastEntryId \?\? msg\.entryId/,
        'forkMessage 应优先使用 lastEntryId（合并气泡锚定最后一轮），未合并时回落 entryId',
    )
})

test('MessageBubble 两处 fork 按钮的在途状态判断与 fork 目标一致', () => {
    const source = readFileSync(path.resolve(testDir, '../src/components/chat/MessageBubble.vue'), 'utf8')
    const uses = source.match(/isForkingEntry\(message\.lastEntryId \?\? message\.entryId\)/g)?.length ?? 0
    assert.equal(
        uses, 4,
        'hover 与 fixed 两处 fork 按钮的 :disabled + loading spinner 共 4 处 isForkingEntry 判断都应使用 lastEntryId ?? entryId，与 forkFromEntry 实际入参一致，否则在途 loading 状态不同步',
    )
})

test('MessageBubble 两处 fork 按钮受 isBusy 控制隐藏（流式中 fork 会把半截回复固化到新会话）', () => {
    const source = readFileSync(path.resolve(testDir, '../src/components/chat/MessageBubble.vue'), 'utf8')

    // 用户消息 hover 区与 AI 消息 fixed 区各一个 fork 按钮
    const forkButtons = source.match(/<button v-if="[^"]*" @click="emit\('fork', message\)"/g) ?? []
    assert.equal(forkButtons.length, 2, '用户消息与 AI 消息两处都应有 fork 按钮')

    for (const tag of forkButtons) {
        assert.ok(
            tag.includes('!isBusy'),
            `流式生成中条目还在增长，此时 fork 会截在半截回复上（与 retry/edit/nav 同口径隐藏）: ${tag}`,
        )
        assert.ok(
            tag.includes('message.entryId'),
            `fork 仍需 entryId 作为分叉锚点（流式中未持久化的消息无锚点，保持隐藏）: ${tag}`,
        )
    }
})

// ==================== Bug 2: 桌面端点击遮罩应能关闭子代理轨迹抽屉 ====================

test('SubagentTraceDrawer 遮罩在桌面端不再 pointer-events-none（点击可关闭）', () => {
    const source = readFileSync(path.resolve(testDir, '../src/components/chat/SubagentTraceDrawer.vue'), 'utf8')

    const overlayIdx = source.indexOf('fixed inset-0 z-40 app-backdrop')
    assert.notEqual(overlayIdx, -1, '应存在全屏遮罩元素')
    const overlayTag = source.slice(source.lastIndexOf('<div', overlayIdx), source.indexOf('/>', overlayIdx))

    assert.ok(overlayTag.includes('@click="close()"'), '遮罩应保留点击关闭')
    assert.ok(!overlayTag.includes('sm:pointer-events-none'), '桌面端遮罩不应再穿透点击（点遮罩应关闭抽屉）')
})
