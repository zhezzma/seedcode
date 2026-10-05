import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * 思考块渲染性能设计回归测试。
 *
 * 背景：thinking 折叠块曾用 DaisyUI collapse + MarkdownRenderer 常驻挂载，
 * 折叠态仍全量渲染 markdown；流式期间每个 delta 触发全文本重渲（O(n²)），
 * 长思考历史导致页面卡顿。ThinkingBlock.vue 的核心设计：
 * 1. 折叠时内容 v-if 零挂载
 * 2. 流式中展开走纯文本直播
 * 3. 定格后 MarkdownRenderer 一次性渲染
 * 此处以源码断言锁住这三点，防止回退。
 */
const testDir = path.dirname(fileURLToPath(import.meta.url))
const componentPath = path.resolve(testDir, '../src/components/chat/ThinkingBlock.vue')
const bubblePath = path.resolve(testDir, '../src/components/chat/MessageBubble.vue')

const componentSource = readFileSync(componentPath, 'utf8')
const bubbleSource = readFileSync(bubblePath, 'utf8')

// 精确截取元素分支：从标签开字符串到下一个元素，返回区间源码
const sectionBetween = (start: string, end: string): string => {
    const startIdx = componentSource.indexOf(start)
    assert.notEqual(startIdx, -1, `missing start marker: ${start}`)
    const endIdx = componentSource.indexOf(end, startIdx)
    assert.notEqual(endIdx, -1, `missing end marker: ${end}`)
    return componentSource.slice(startIdx, endIdx)
}

test('collapsed thinking content is fully unmounted (v-if on expanded)', () => {
    // 内容容器必须挂在 v-if="expanded" 下：折叠时 MarkdownRenderer 不存在于组件树，
    // 而不是仅靠 collapse-content 的 CSS 视觉隐藏
    assert.match(componentSource, /<div v-if="expanded" class="collapse-content">/)
    // 不得退回 checkbox 驱动的 collapse（勾选后内容常驻挂载）
    assert.ok(!componentSource.includes('type="checkbox"'))
})

test('streaming expansion renders plain text instead of markdown', () => {
    // 流式中：纯文本容器（无 MarkdownRenderer），增量 patch 零渲染成本。
    // 锚定直播 div 元素本身，避免误命中标题栏的 v-if="streaming" loading span
    const streamingSection = sectionBetween('<div v-if="streaming" ref="liveElement"', '<div v-else')
    assert.ok(!streamingSection.includes('MarkdownRenderer'), 'streaming branch must not render markdown')
    assert.ok(streamingSection.includes('whitespace-pre-wrap'), 'streaming branch should be plain text')
    assert.ok(streamingSection.includes('{{ text }}'), 'streaming branch should render raw text')
})

test('settled thinking renders markdown once via MarkdownRenderer', () => {
    // 定格后：MarkdownRenderer 一次性渲染
    // 锚点只锁定结构性前缀（v-else + 语义类），不锚定纯样式类——
    // 样式类会随主题调整漂移（曾致 border-t 被暗色模式改动删掉后本测试误红）
    const settledSection = sectionBetween('<div v-else class="opacity-80 text-sm', '</template>')
    assert.ok(settledSection.includes('MarkdownRenderer'), 'settled branch should render markdown')
})

test('MessageBubble delegates thinking blocks to ThinkingBlock', () => {
    assert.ok(bubbleSource.includes('ThinkingBlock'), 'MessageBubble should use ThinkingBlock')
    // streaming 判定（数据驱动）：delta 正落在该块上（流内活跃块标记，
    // useChatMessages.convertToBlocks 写入 block.streaming）→ 纯文本直播。
    // 旧位置启发「isLoading && 是最后一个 block」已废除：交错推理（_ci 中间块）与
    // 合并气泡 + 排队消息（行不在列表末尾）场景下会误判为已定格，增长中的思考块
    // 被错误送进 markdown 全量重渲热路径（每个 delta 双渲染，UI 卡死点击丢失）
    assert.match(bubbleSource, /:streaming="block\.streaming === true"/)
    // hideThinkingBlock 开关已随 Settings 残留清理移除：思考块无条件渲染
    assert.match(bubbleSource, /block\.type === 'thinking'/)
})

test('live follow only tracks when user is near bottom', () => {
    // 自动跟随必须是「接近底部才跟随」（<60px 阈值），防止用户回看历史时被强制拉底
    const idx = componentSource.indexOf('watch(() => props.text')
    assert.notEqual(idx, -1, 'missing text watch')
    const section = componentSource.slice(idx, componentSource.indexOf('</script>'))
    assert.ok(section.includes('>= 60'), 'follow-tail must bail out when user scrolled up')
    assert.ok(!/scrollTop = .*scrollHeight/.test(section),
        'watch must not scroll directly; go through rAF-coalesced scrollToBottom')
})

test('scroll work is rAF-coalesced, one scroll per frame max', () => {
    // 流式热路径：一帧内多个 delta 只能调度一次滚动，避免每 delta 强制 reflow
    assert.ok(componentSource.includes('requestAnimationFrame'), 'scroll must be rAF-coalesced')
    assert.match(componentSource, /if \(followRafId\) return/)
})

test('streaming loading indicator is hidden from screen readers', () => {
    // 纯装饰动画，不应向屏幕阅读器播报无意义状态
    assert.match(componentSource, /loading-dots loading-xs" aria-hidden="true"/)
})

test('keydown repeat does not toggle expansion repeatedly', () => {
    assert.ok(componentSource.includes('if (e.repeat) return'), 'hold-down Enter/Space should not flip expanded')
})
