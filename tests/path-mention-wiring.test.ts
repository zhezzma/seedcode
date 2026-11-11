import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * @ 路径补全的接线断言（source-structure 测试，与 chat-command-suggestions-scroll.test.ts 同模式）。
 *
 * 纯逻辑（parse/split/filter）在 path-mention.test.ts 直测；useChatInput 模块依赖
 * vue/pinia/DOM 无法在 node:test 里挂起，接线正确性靠断言源码结构兜底：
 * ChatInput.vue 的模板/事件绑定 + useChatInput.ts 的状态机接线两端都在这里核对。
 */

const testDir = path.dirname(fileURLToPath(import.meta.url))
const componentSource = readFileSync(path.resolve(testDir, '../src/components/chat/ChatInput.vue'), 'utf8')
const composableSource = readFileSync(path.resolve(testDir, '../src/composables/useChatInput.ts'), 'utf8')

// ——— ChatInput.vue ———

test('ChatInput: textarea 输入事件把光标交给 updatePathMention（替换裸 adjustHeight）', () => {
    assert.match(componentSource, /@input="onTextareaInput"/, 'textarea 的 @input 应指向 onTextareaInput')
    assert.doesNotMatch(componentSource, /@input="adjustHeight"/, '不应再直接绑定 adjustHeight')
    assert.match(
        componentSource,
        /updatePathMention\(\s*el\.selectionStart/,
        'onTextareaInput 应把光标位置传给 updatePathMention',
    )
    assert.match(
        componentSource,
        /chatState\.currentAgent\?\.id/,
        'agentId 应从 chatState.currentAgent 现取后传入（避免 useChatInput→useChatState 模块环）',
    )
})

test('ChatInput: @ 补全面板渲染条目（图标/名称/路径）并支持鼠标确认', () => {
    assert.match(componentSource, /v-if="pathMentionVisible"/, '面板可见性由 pathMentionVisible 驱动')
    // 类名必须锚定在面板根节点（v-if 那层）上：点击外部关闭的 closest 判定要覆盖标题栏，
    // 否则点面板头部会把自己关掉。不锚定节点的话，closest('.path-mention-panel') 这行
    // 自身就含该子串，删掉模板里的类名断言照样过（审核抓出的自我满足断言）
    assert.match(
        componentSource,
        /v-if="pathMentionVisible"\s+class="[^"]*\bpath-mention-panel\b/,
        'path-mention-panel 类须挂在 v-if 面板根节点',
    )
    assert.match(componentSource, /@mousedown\.prevent="confirmPathMention\(entry\)"/, 'mousedown.prevent 确认条目（防 textarea 失焦）')
    assert.match(componentSource, /:data-path-mention-active="idx === pathMentionIndex"/, '高亮条目标记 data-path-mention-active')
    assert.match(componentSource, /FolderIcon/, '目录图标')
    assert.match(componentSource, /DocumentIcon/, '文件图标')
})

test('ChatInput: 高亮滚动与点击外部关闭', () => {
    assert.match(componentSource, /watch\s*\(\s*pathMentionIndex/s, '应 watch pathMentionIndex')
    assert.match(componentSource, /\[data-path-mention-active="true"\]/, '滚动目标选择器')
    assert.match(
        componentSource,
        /closest\('\.path-mention-panel'\)/,
        '点击外部关闭判定应放行面板内部点击',
    )
    assert.match(componentSource, /closePathMention\(\)/, '点击外部应调用 closePathMention')
})

// ——— useChatInput.ts ———

test('useChatInput: @ 补全状态机接线（导入/端点选择/过期守卫）', () => {
    assert.match(composableSource, /from '\.\.\/utils\/path-mention\.ts'/, '导入纯逻辑层')
    assert.match(composableSource, /fetchAbsoluteTree/, '绝对路径走 fetchAbsoluteTree')
    assert.match(composableSource, /fetchTree\(/, '相对路径走 fetchTree（workspace tree）')
    assert.match(composableSource, /seq !== pathMentionSeq/, '异步回包需检查过期守卫')
    assert.match(composableSource, /isAbsolutePathLike/, '按 query 形态分流相对/绝对')
})

test('useChatInput: 目录确认续探、文件确认收起（插入物尾缀）', () => {
    assert.match(composableSource, /const isDir = entry\.type === 'dir'/, '先判定目录类型')
    assert.match(composableSource, /isDir \? '\/' : ' '/, '目录补 / 续探、文件补空格')
    assert.match(
        composableSource,
        /updatePathMention\(newCaret,\s*agentId\)/,
        '目录确认后按新光标续探下一层',
    )
})

test('useChatInput: 键盘路由——补全面板打开时 ↑↓/Enter/Tab/Esc 走面板', () => {
    assert.match(
        composableSource,
        /if \(pathMentionVisible\.value && historyIndex\.value === -1\)/,
        '面板打开且非历史浏览态时接管按键',
    )
    assert.match(composableSource, /e\.isComposing \|\| e\.keyCode === 229/, 'IME 组合期不接管')
    assert.match(composableSource, /e\.key === 'Tab' && !e\.ctrlKey && !e\.shiftKey/, 'Tab 确认（Ctrl/Shift+Tab 放行）')
    assert.match(composableSource, /e\.key === 'ArrowDown' && !e\.shiftKey && !e\.altKey && !e\.metaKey/, '方向键带修饰键不劫持')
    assert.match(composableSource, /e\.key === 'Enter' && !e\.shiftKey && !e\.ctrlKey/, 'Enter 确认（Shift/Ctrl+Enter 保持原生）')
    assert.match(composableSource, /e\.key === 'Escape'[\s\S]{0,200}closePathMention\(\)/, 'Esc 收起面板')
})

test('useChatInput: 程序化修改输入时收起 @ 面板（点名关键路径，不计数）', () => {
    assert.match(composableSource, /if \(!val\) closePathMention\(\)/, 'inputText 清空兜底')
    assert.match(composableSource, /const appendText[\s\S]{0,300}closePathMention\(\)/, 'appendText 收起')
    assert.match(composableSource, /restoreSessionDraft[\s\S]{0,600}closePathMention\(\)/, '会话切换恢复草稿时收起')
    // 历史浏览分支（下探/回草稿）各自收起
    const historyNav = composableSource.match(/historyIndex\.value !== -1[\s\S]{0,800}/)
    assert.ok(historyNav, '应存在历史浏览分支')
    const closesInNav = (historyNav[0].match(/closePathMention\(\)/g) ?? []).length
    assert.ok(closesInNav >= 2, `历史浏览两分支都应收起（实际 ${closesInNav} 处）`)
})

test('ChatInput: 解构块包含全部 @ 补全 API（拦「忘记解构」回归）', () => {
    const m = componentSource.match(/const \{[\s\S]{0,4000}?\}\s*=\s*useChatInput\(\)/)
    assert.ok(m, '应存在 useChatInput() 解构块')
    for (const name of [
        'pathMentionVisible',
        'pathMentionEntries',
        'pathMentionIndex',
        'updatePathMention',
        'confirmPathMention',
        'closePathMention',
        'setTextareaResolver',
    ]) {
        assert.ok(m[0].includes(name), `解构块应包含 ${name}（否则模板引用 undefined）`)
    }
})

test('ChatInput: 回焦定位器注入（不全局查 textarea）', () => {
    assert.match(componentSource, /setTextareaResolver\(\(\) => textareaRef\.value\)/, 'setup 时注入 textareaRef 定位器')
    assert.doesNotMatch(
        composableSource,
        /focusTextareaAt[\s\S]{0,200}document\.querySelector/,
        'focusTextareaAt 不应全局查找 textarea（会命中消息区 a2ui 字段）',
    )
})

test('useChatInput: 导出 @ 补全面板 API 供 ChatInput 消费', () => {
    for (const name of [
        'pathMentionVisible',
        'pathMentionEntries',
        'pathMentionIndex',
        'updatePathMention',
        'confirmPathMention',
        'closePathMention',
        'setTextareaResolver',
    ]) {
        assert.match(composableSource, new RegExp(`\\b${name}\\b,`), `应导出 ${name}`)
    }
})
