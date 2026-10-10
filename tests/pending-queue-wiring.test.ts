import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8')

const chatStateSource = read('src/composables/useChatState.ts')
const chatMessagesSource = read('src/composables/useChatMessages.ts')
const homeViewSource = read('src/views/HomeView.vue')
const sessionsStateSource = read('src/composables/useSessionsState.ts')
const chatAttachSource = read('src/utils/chat-attach.ts')
const pendingQueueSource = read('src/utils/pending-queue.ts')

/** 截取 `const <name> = ...` 到下一个顶层 `\nconst ` 的文本（function 声明不截断切片） */
function extractFn(source: string, name: string): string {
    const start = source.indexOf(`const ${name} = `)
    assert.ok(start >= 0, `function ${name} not found`)
    const end = source.indexOf('\nconst ', start + 1)
    return source.slice(start, end === -1 ? undefined : end)
}

test('useChatState: message_start user 回显命中队头时立即出队转正（无落盘）', () => {
    const handler = extractFn(chatStateSource, 'handleSSEEvent')
    assert.match(handler, /case 'message_start': \{/)
    assert.match(handler, /extractUserText\(echoMsg\.content\)/)
    assert.match(handler, /consumeQueueHead\(sessionData\.pendingQueue, echoText\)/)
    assert.match(handler, /sessionData\.pendingQueue = consumed\.rest/)
    // 服务端权威：本地不再持久化队列
    assert.ok(!handler.includes('persistPendingQueue'), 'queue persistence must be gone')
    // 转正：回显内容 append 为正式 user 气泡
    assert.match(handler, /content: echoMsg\.content/)
    // WS 删除快照恒先于 SSE 回显：consume miss 时凭快照移除缓存补齐正式气泡
    //（否则长 run 期间 steer 消息在聊天区隐身，直到 done 全量刷新才出现）
    assert.match(handler, /consumeRemovedEcho\(sessionData, echoText\)/)
    // 在途发送判别先于队头转正：sendMessage / retry / edit 登记的文本命中时整个跳过
    //（乐观气泡/乐观分支已覆盖；否则 retry/edit 的历史消息与排队条目同文本时，
    // 队头误吃本回显并重复 append；删除排队消息后同文本发送则 removedEcho 误补双气泡）。
    // 先验存在再比顺序：否则行文本漂移时 indexOf 返回 -1、-1 < 任意位置恒真（vacuous-pass）
    const inFlightPos = handler.indexOf('const inFlightEcho = echoText ? consumeInFlightSend(sessionData, echoText) : false')
    const queueHeadPos = handler.indexOf('consumeQueueHead(sessionData.pendingQueue, echoText)')
    assert.ok(inFlightPos >= 0, 'in-flight judgment missing')
    assert.ok(queueHeadPos > inFlightPos, 'in-flight judgment must precede queue-head promotion')
    // 转正与补齐两分支都必须过 inFlightEcho 门禁
    assert.match(handler, /echoText && !inFlightEcho \? consumeQueueHead/)
    assert.match(handler, /!inFlightEcho && consumeRemovedEcho/)
})

test('useChatState: retry/edit 经 beginBranchRewriteSSE 登记回显守卫文本', () => {
    const skeletonStart = chatStateSource.indexOf('function beginBranchRewriteSSE')
    assert.ok(skeletonStart >= 0, 'beginBranchRewriteSSE 骨架应存在')
    const skeletonEnd = chatStateSource.indexOf('\nconst retryMessage', skeletonStart)
    assert.ok(skeletonEnd > skeletonStart, '骨架切片终点应有效（indexOf 不得返回 -1）')
    const skeleton = chatStateSource.slice(skeletonStart, skeletonEnd)
    // 登记：retry = 目标 user 消息原文，edit = 新文本；必须在 startSSE 之前（回显随流首事件到达）
    assert.match(skeleton, /inFlightEchoText\?: string \| null/)
    assert.match(skeleton, /sessionData\.inFlightSendTexts = \[opts\.inFlightEchoText\]/)
    assert.ok(
        skeleton.indexOf('sessionData.inFlightSendTexts = [opts.inFlightEchoText]') < skeleton.indexOf('opts.startSSE('),
        'registration must happen before startSSE',
    )
    // retry：守卫文本 = 目标 user 消息原文（assistant 条目上溯最近 user 消息）
    const retryFn = extractFn(chatStateSource, 'retryMessage')
    assert.match(retryFn, /inFlightEchoText/)
    // edit：守卫文本 = 新文本
    const editFn = extractFn(chatStateSource, 'editMessage')
    assert.match(editFn, /inFlightEchoText: newText/)
})

test('useChatState: sendMessage 登记在途发送文本，run 生命周期兑底清零', () => {
    // 正常 sendMessage 启动即登记：本 run 的 user 回显凭乐观气泡覆盖，
    // 不得走 removedEcho 补齐（否则删除排队消息后同文本发送双气泡）
    const sendFn = extractFn(chatStateSource, 'sendMessage')
    assert.match(sendFn, /sessionData\.inFlightSendTexts = \[text\]/)
    // run 生命周期兑底清零（done/error/abort 后残留会压制后续同文本 drain 的合法补齐）。
    // resetStreamState 是 function 声明，extractFn 只识别 const 声明，手动截取
    const resetStart = chatStateSource.indexOf('function resetStreamState')
    assert.ok(resetStart >= 0, 'resetStreamState not found')
    const resetFn = chatStateSource.slice(resetStart, chatStateSource.indexOf('\nfunction ', resetStart + 1))
    assert.match(resetFn, /sd\.inFlightSendTexts = \[\]/)
})

test('useChatState: steerMessage/followMessage 捕获服务端 entryId + queueRev 后才入队', () => {
    for (const [name, mode] of [['steerMessage', 'steer'], ['followMessage', 'follow']] as const) {
        const fn = extractFn(chatStateSource, name)
        // 旧实现的根因：POST 前就写 chatMessages → 失败留假气泡
        assert.ok(!fn.includes('chatMessages'), `${name} must not touch chatMessages`)
        assert.match(fn, /: Promise<boolean>/, `${name} must return boolean`)
        // id/queueRev 来自服务端响应（账本签发）；未入队（id 缺失）不加排队气泡
        assert.match(fn, /apiPost<\{ id\?: string \| null; queueRev\?: number \}>/)
        assert.match(fn, /if \(!result\?\.id\) return true/)
        assert.match(fn, new RegExp(`enqueuePendingItem\\(targetKey, result\\.id, message, '${mode}', result\\.queueRev\\)`))
        assert.match(fn, /return false/, `${name} must signal failure`)
    }
})

test('useChatState: 本地不再持久化/猜谜修剪队列（reconcile 全家消失）', () => {
    assert.ok(!chatStateSource.includes('pendingQueueStore'), 'localStorage store must be gone')
    assert.ok(!chatStateSource.includes('reconcilePendingQueue'), 'local reconcile must be gone')
    assert.ok(!chatStateSource.includes('persistPendingQueue'), 'persist must be gone')
})

test('useChatState: removePendingItem 走 DELETE /queue/:id 并按响应快照对齐', () => {
    const fn = extractFn(chatStateSource, 'removePendingItem')
    assert.match(fn, /apiDelete<\{ deleted: boolean, queueRev\?: number, entries: ServerQueueEntry\[\] \}>/)
    assert.match(fn, /\/queue\/\$\{encodeURIComponent\(id\)\}/)
    assert.match(fn, /applyQueueSnapshot\(getSessionData\(targetKey\), result\?\.queueRev, result\?\.entries\)/)
})

test('useChatState: enqueuePendingItem 按 entryId 去重 + queueRev 门禁（防复活已消费条目）', () => {
    // 服务端 registerQueued 的 WS 快照可能先于 steer/follow HTTP 响应到达（跨连接无顺序保证）：
    // - 快照已含新条目 → 本地 append 必须按 id 去重，否则同一气泡出现两次；
    // - 消息入队后立即被 drain（本地已应用更新的快照）→ 凭「本地 rev > 登记 rev」跳过 append，
    //   否则复活幻影气泡且无后续快照修正。
    // 注：enqueuePendingItem 是 function 声明，extractFn 只识别 const 声明，手动截取
    const start = chatStateSource.indexOf('function enqueuePendingItem')
    assert.ok(start >= 0, 'enqueuePendingItem not found')
    const fn = chatStateSource.slice(start, chatStateSource.indexOf('\nfunction ', start + 1))
    assert.match(fn, /sd\.pendingQueue\.some\(entry => entry\.id === id\)/)
    assert.match(fn, /sd\.queueRev > queueRev/)
})

test('useChatState: WS queue_state 快照经 queueRev 门禁整体替换本地队列', () => {
    assert.match(chatStateSource, /onServerMessage\(\(msg: any\) => \{/)
    assert.match(chatStateSource, /msg\?\.event !== 'queue_state'/)
    assert.match(chatStateSource, /applyQueueSnapshot\(sd, msg\.payload\?\.queueRev, msg\.payload\?\.entries\)/)
})

test('useChatState: attach message_state 走 applyAttachMessageState 应用快照', () => {
    const attachIdx = chatStateSource.indexOf('applyAttachMessageState(currentSessionData')
    assert.ok(attachIdx > 0)
})

test('chat-attach: AttachMessageState 携带 pendingQueue + queueRev，经门禁整体替换本地队列', () => {
    assert.match(chatAttachSource, /pendingQueue\?: ServerQueueEntry\[\]/)
    assert.match(chatAttachSource, /queueRev\?: number/)
    assert.match(chatAttachSource, /applyQueueSnapshot\(sessionData, state\.queueRev, state\.pendingQueue\)/)
})

test('useChatState: abort 成功后清空本地队列（对齐服务端 clearQueuesAndAbort 清账本）', () => {
    const fn = extractFn(chatStateSource, 'abortChat')
    assert.match(fn, /sd\.pendingQueue = \[\]/)
    assert.ok(!fn.includes('persistPendingQueue'))
    // 先验存在再比顺序：否则行文本漂移时 indexOf 返回 -1、-1 < 任意位置恒真（vacuous-pass）
    assert.ok(fn.includes('sd.chatMessages = result.messages'), 'abort must persist messages from /abort response')
    // 流式临时条目与 done/loadChatHistory 同规则：持久化消息落地后一并清空（todo details 链路）
    // 顺序守门：必须先落地 chatMessages 再清临时条目，反序会丢面板快照
    assert.match(fn, /sd\.chatToolMessages = \[\]/)
    assert.ok(
        fn.indexOf('sd.chatMessages = result.messages') < fn.indexOf('sd.chatToolMessages = []'),
        'abort must persist chatMessages BEFORE clearing chatToolMessages',
    )
})

test('useChatState: tool_execution_end 推送对象补齐 toolName/details（TodoBar 流式实时更新的数据源，回归守门）', () => {
    const handler = extractFn(chatStateSource, 'handleSSEEvent')
    // 缺任一字段 → TodoBar 退化为只在回合结束 done 后更新（最终审查 Critical#1 同型回归）
    assert.match(handler, /toolName: data\.toolName,/)
    assert.match(handler, /details: data\.result\?\.details/)
})

test('useChatState: retry/edit/navigate 分支改写后清空 chatToolMessages（防被放弃分支快照 LWW 胜出）', () => {
    // retry/edit 的清空收口在共享骨架 beginBranchRewriteSSE；两条路径必须经由骨架。
    // 骨架切片止于 \nconst retryMessage，保证断言落在骨架本体而非其后的函数
    const skeletonStart = chatStateSource.indexOf('function beginBranchRewriteSSE')
    assert.ok(skeletonStart >= 0, 'beginBranchRewriteSSE 骨架应存在')
    const skeletonEnd = chatStateSource.indexOf('\nconst retryMessage', skeletonStart)
    assert.ok(skeletonEnd > skeletonStart, '骨架切片终点应有效（indexOf 不得返回 -1）')
    const skeleton = chatStateSource.slice(skeletonStart, skeletonEnd)
    assert.match(skeleton, /chatToolMessages = \[\]/, '骨架 must clear chatToolMessages after branch rewrite')
    for (const name of ['retryMessage', 'editMessage']) {
        assert.match(extractFn(chatStateSource, name), /beginBranchRewriteSSE\(targetKey/, `${name} 应经由共享骨架清空 chatToolMessages`)
    }
    const nav = extractFn(chatStateSource, 'navigateBranch')
    assert.match(nav, /chatToolMessages = \[\]/, 'navigateBranch must clear chatToolMessages after branch rewrite')
})

test('chat-attach: 全量 message_state 快照替换时清空 chatToolMessages（跨分支重连残留防护）', () => {
    const attach = read('src/utils/chat-attach.ts')
    const fnStart = attach.indexOf('export function applyAttachMessageState')
    assert.ok(fnStart >= 0, 'applyAttachMessageState not found')
    const fn = attach.slice(fnStart, attach.indexOf('\nexport function', fnStart + 1))
    // 全量 messages 分支内必须有清理（收紧位置：清理必须落在 else if 之前，防止被挪进 delta 分支）
    const ifHead = fn.indexOf('if (Array.isArray(state.messages))')
    const clearPos = fn.indexOf('chatToolMessages = []')
    const elseIfPos = fn.indexOf('} else if')
    assert.ok(ifHead >= 0, 'full-snapshot branch missing')
    assert.ok(clearPos > ifHead, 'full-snapshot branch must clear chatToolMessages')
    assert.ok(elseIfPos === -1 || clearPos < elseIfPos, 'cleanup must stay inside the full-snapshot branch, not the delta branch')
    // delta 分支同样必须清理（他窗改写分支后旧快照以数组尾部位置赢得 LWW；在途由 inflight 重放补齐），
    // 且必须在 deduped 判断块【内部】（块外语义变为「只要有 delta 就清」，同 run 空重连会误作废在途条目）。
    // 块闭合按 deduped 行的实际缩进动态定位（换行 + 同缩进 + 右花括号），
    // 避免固定 4 空格模式匹配到外层 else-if 闭合的假阴
    const fnTail = fn.slice(elseIfPos)
    const dedupedPos = fnTail.indexOf('if (deduped.length > 0)')
    const deltaClearPos = fnTail.indexOf('chatToolMessages = []')
    assert.ok(dedupedPos >= 0, 'deduped guard missing')
    assert.ok(deltaClearPos > dedupedPos, 'delta cleanup must come after the deduped guard')
    const dedupedLineStart = fnTail.lastIndexOf('\n', dedupedPos) + 1
    const dedupedIndent = dedupedPos - dedupedLineStart // 'if' 前的缩进即块层级
    assert.ok(dedupedIndent > 0, 'unexpected zero indent for deduped guard')
    const blockClose = fnTail.indexOf('\n' + ' '.repeat(dedupedIndent) + '}', deltaClearPos)
    assert.ok(blockClose > deltaClearPos, 'delta cleanup must stay INSIDE the deduped guard block')
})

test('useChatState: getSessionData 初始化空队列（无 localStorage hydrate）+ pendingQueue computed 暴露', () => {
    assert.match(chatStateSource, /pendingQueue: \[\],/)
    assert.match(chatStateSource, /const pendingQueue = computed\(\(\) => getSessionData\(state\.sessionKey\)\.pendingQueue\)/)
    assert.match(chatStateSource, /pendingQueue, removePendingItem,/)
})

test('useSessionsState: deleteSession 不再清理队列存储（本地无持久化可清）', () => {
    const fn = extractFn(sessionsStateSource, 'deleteSession')
    assert.ok(!fn.includes('pendingQueueStore'), 'no store to clean')
})

test('utils/pending-queue: 存储层已删除，仅保留纯函数 + 快照映射与门禁', () => {
    assert.ok(!pendingQueueSource.includes('localStorage'), 'no localStorage')
    assert.ok(!pendingQueueSource.includes('createPendingQueueStore'), 'store must be gone')
    assert.ok(!pendingQueueSource.includes('reconcileQueue'), 'local reconcile must be gone')
    assert.match(pendingQueueSource, /export function toPendingItems/)
    assert.match(pendingQueueSource, /export function applyQueueSnapshot/)
    assert.match(pendingQueueSource, /export function consumeQueueHead/)
    assert.match(pendingQueueSource, /export function consumeRemovedEcho/)
    assert.match(pendingQueueSource, /export function extractUserText/)
})

test('useChatMessages: processedMessages 末尾追加 pending 气泡并标记 mode', () => {
    assert.match(chatMessagesSource, /const pendingQueue = state\.pendingQueue \|\| \[\]/)
    assert.match(chatMessagesSource, /pending: entry\.mode/)
    // DisplayMessage / ChatStateShape 字段
    assert.match(chatMessagesSource, /pending\?: PendingSendMode/)
    assert.match(chatMessagesSource, /pendingQueue\?: PendingItem\[\]/)
})

test('HomeView: 会话页输入框上方挂载 ChatDockArea（PendingQueueBar 经 dock 注册）', () => {
    assert.match(homeViewSource, /import ChatDockArea from '\.\.\/components\/chat\/ChatDockArea\.vue'/)
    assert.match(homeViewSource, /<ChatDockArea v-if="!isNewSessionPage && !isCreatingSession"/)
    assert.ok(!homeViewSource.includes('<PendingQueueBar'), 'HomeView must not mount PendingQueueBar directly')
    const dockAreaSource = read('src/components/chat/ChatDockArea.vue')
    assert.match(dockAreaSource, /registerChatDockWidget\(\{ id: 'pending-queue', order: 10/, 'PendingQueueBar must register into chat dock')
    // TodoBar 挂载完全依赖这一行注册：删掉不会有任何其他测试失败（Ruling T8 留给审查的口子）
    assert.match(dockAreaSource, /registerChatDockWidget\(\{ id: 'todo', order: 20/, 'TodoBar must register into chat dock')
    // order 语义守门：pending-queue 必须排在 todo 之前（字面量互不关联，顺序反转无现有断言）
    const orderOf = (id: string) => Number(dockAreaSource.match(new RegExp(`id: '${id}', order: (\\d+)`))?.[1])
    assert.ok(orderOf('pending-queue') < orderOf('todo'), 'pending-queue must render before todo in chat dock')
})

test('PendingQueueBar / MessageBubble: 排队可视化元素存在', () => {
    const barSource = read('src/components/chat/PendingQueueBar.vue')
    // 扩展自包含约定：容器不传 props，自取全局 store
    assert.match(barSource, /useChatState\(\)/)
    // 队列非空才渲染 + ✕ 直接调用服务端删除 + 删除提示
    assert.match(barSource, /v-if="chatState\.pendingQueue\.length > 0"/)
    assert.match(barSource, /chatState\.removePendingItem\(item\.id\)/)
    assert.match(barSource, /chat\.pendingQueue\.removeHint/)

    const bubbleSource = read('src/components/chat/MessageBubble.vue')
    // 半透明 + 徽标
    assert.match(bubbleSource, /message\.pending \? 'opacity-70' : ''/)
    assert.match(bubbleSource, /chat\.pendingQueue\.followBadge/)
    assert.match(bubbleSource, /chat\.pendingQueue\.steerBadge/)
})
