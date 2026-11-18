import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const readSrc = (rel: string) => readFileSync(path.resolve(testDir, '..', rel), 'utf8')

// 背景（实测会话 01a0c317，2026-09-21）：停止后 2 秒内点重试，/abort 响应晚到，
// 无守卫落地 → chatSending 被压成 false、chatRunId/chatStream 被清、chatMessages 被
// 旧分支快照覆盖（运行中带 entryId 的消息让分支导航中途显形）→ 运行中切分支 →
// 会话级流状态泄漏到目标分支视图（假流式/假思考）+ isBranchTail 尾锚被压住 → 卡死。
//
// 修复口径：
// 1) abortChat 快照守卫——新 run 已启动（绑定 SSE 或 chatRunId 已置位）时整包丢弃；
// 2) 运行中冻结分支导航——HomeView 入口守卫 + MessageBubble 两处按钮 isBusy 禁用；
// 3) 服务端 /navigate /delete /retry /edit 在 isStreaming 时 409（seedagent 仓库）。

test('abortChat discards stale snapshot when a new run started (success path)', () => {
    const source = readSrc('src/composables/useChatState.ts')

    assert.ok(
        source.includes(
            'const abortSnapshotStale = () => sseConnections.has(targetKey) || sd.chatRunId !== runIdAtAbort',
        ),
        'abortChat staleness must compare runId change (the aborted run\'s own chatRunId is always set, presence alone would discard every abort response)',
    )
    assert.ok(
        source.includes('const runIdAtAbort = sd.chatRunId'),
        'runId must be captured before the await (at abort initiation, not at response time)',
    )
    // 成功路径：守卫通过后才允许落地快照/清队列
    const successIdx = source.indexOf('const result = await apiPost<{ messages?: ChatMessage[], isStreaming?: boolean }>')
    const guardAfterSuccess = source.indexOf('if (abortSnapshotStale()) return', successIdx)
    const pendingClearIdx = source.indexOf('sd.pendingQueue = []', guardAfterSuccess)
    assert.ok(successIdx !== -1, 'abort POST call should exist')
    assert.ok(guardAfterSuccess !== -1, 'success path should check staleness right after the response')
    assert.ok(pendingClearIdx !== -1, 'snapshot application (queue clear) should come after the guard')
    // catch 路径同样守卫：chatSending=false 不能压掉新 run 的 true
    const catchIdx = source.indexOf('// Ignore abort errors')
    const guardInCatch = source.indexOf('if (abortSnapshotStale()) return', catchIdx)
    assert.ok(catchIdx !== -1 && guardInCatch !== -1, 'catch path should also respect the staleness guard')
})

test('branch navigation is hidden while busy (not rendered, not frozen)', () => {
    const bubble = readSrc('src/components/chat/MessageBubble.vue')
    // 两侧导航块（user footer / assistant footer）都在 busy 时不渲染——而不是渲染后禁用；
    // 群消息（isTeamMessage）同样不渲染（群回合无分支语义）
    assert.ok(
        bubble.includes('v-if="!isBusy && !isTeamMessage && isBranchTail && branchInfo && branchInfo.siblings.length > 1"'),
        'user-footer nav should not render while busy (nor team messages)',
    )
    assert.ok(
        bubble.includes('v-if="!isBusy && !isTeamMessage && branchInfo && branchInfo.siblings.length > 1"'),
        'assistant-footer nav should not render while busy (nor team messages)',
    )
    // 不采用冻结方案：disabled 不应掺入 isBusy
    assert.ok(
        !bubble.includes(':disabled="isBusy ||'),
        'nav buttons should rely on v-if hiding, not isBusy-disabled freezing',
    )

    // HomeView 不再做入口冻结（导航已隐藏，渲染竞态由服务端 409 + 失败提示兜底），
    // 但要保留失败提示
    const home = readSrc('src/views/HomeView.vue')
    const navigateIdx = home.indexOf('const navigateBranch = async (msg: DisplayMessage')
    const navFn = home.slice(navigateIdx, home.indexOf('// Voice Chat', navigateIdx))
    assert.ok(
        !navFn.includes('isBusy.value'),
        'navigateBranch should not duplicate the freeze (nav is hidden while busy)',
    )
    assert.ok(
        navFn.includes("t('chat.treeJumpFailed')"),
        'navigateBranch should surface navigation failures (server 409 etc.)',
    )
})
