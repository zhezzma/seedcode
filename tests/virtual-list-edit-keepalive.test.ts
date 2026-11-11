import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 用户消息编辑态 × 虚拟滚动回归测试。
 *
 * 背景（三症状一根因链）：
 * 1. 编辑框固定 rows=4 + 原内容 h-0 折叠 → 长消息行高从几千像素骤缩到 ~100px，
 *    下方内容整体上移涌入视口，scrollHeight 骤降触发浏览器钳制/锚定甩视口；
 * 2. isEditing/editText 是 MessageBubble 本地状态，行离屏（视口 ±1200px 外）
 *    v-if 换 spacer 即销毁——滚回来重挂载变回原样，半成品编辑文本丢失。
 *
 * 修复设计（对位媒体保活 virtual-list-media-keepalive）：
 * - 编辑框自适应高度（ChatInput.adjustHeight 同款）+ 60vh 上限内部滚动；
 * - 行内 data-editing 标记：保活循环命中即不卸载，提交/取消后标记随 v-if
 *   卸载消失，下一次滚动更新自然回收。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const listSource = readFileSync(
    path.join(repoRoot, 'src/components/chat/VirtualMessageList.vue'),
    'utf8',
)
const bubbleSource = readFileSync(
    path.join(repoRoot, 'src/components/chat/MessageBubble.vue'),
    'utf8',
)

test('虚拟滚动不卸载编辑中的行（data-editing 保活）', () => {
    // 根因锁：离屏行整体卸载会连带销毁编辑态。保活循环必须在卸载前检测
    // （DOM 还在 rowEls 里），且与媒体保活同构——只延长挂载，不影响 spacer 布局语义
    const keepaliveLoop =
        /for \(const key of visibleKeys\.value\) \{\s*\n\s*if \(next\.has\(key\)\) continue\s*\n\s*if \(rowEls\.get\(key\)\?\.querySelector\('\[data-editing\]'\)\) next\.add\(key\)\s*\n\s*\}/
    assert.match(listSource, keepaliveLoop)
    // 顺序锚：循环必须位于 visibleKeys.value = next 赋值之前。挪到赋值后遍历的
    // 已是新集合，本轮保活不生效（编辑行当帧即被回收），上面的正则却仍绿
    const loopIndex = listSource.search(keepaliveLoop)
    const assignIndex = listSource.indexOf('visibleKeys.value = next')
    assert.ok(
        loopIndex !== -1 && assignIndex !== -1 && loopIndex < assignIndex,
        '编辑保活循环必须在 visibleKeys.value = next 赋值之前执行',
    )
})

test('data-editing 标记随编辑框 v-if 存在，提交/取消后自然消失', () => {
    // 标记必须挂在 v-if="isEditing" 的 textarea 上（而不是气泡根节点），
    // 否则提交/取消后标记残留，行被永久保活成僵尸挂载
    assert.match(
        bubbleSource,
        /<textarea v-if="isEditing" ref="editTextareaRef" v-model="editText" rows="1" data-editing/,
    )
    // 提交/取消都会落 isEditing=false → v-if 卸载 textarea → 标记消失
    const cancelSection = bubbleSource.slice(
        bubbleSource.indexOf('const cancelEdit'),
        bubbleSource.indexOf('const submitEdit'),
    )
    assert.match(cancelSection, /isEditing\.value = false/)
    const submitSection = bubbleSource.slice(
        bubbleSource.indexOf('const submitEdit'),
        bubbleSource.indexOf('// Helper functions'),
    )
    assert.match(submitSection, /isEditing\.value = false/)
})

test('编辑框自适应高度：按内容撑高 + 60vh 上限内部滚动（行高不骤缩）', () => {
    // rows=1 + resize-none：高度完全由 adjustEditTextareaHeight 控制
    //（resize-y 会与 JS 撑高打架——用户拖拽后下一次 input 被重置）
    assert.match(
        bubbleSource,
        /rows="1" data-editing\s*\n\s*class="textarea textarea-bordered w-full bg-base-200 text-base-content text-sm resize-none min-h-\[80px\] max-h-\[60vh\] overflow-y-auto"/,
    )
    // 对齐 ChatInput.adjustHeight 模式：auto → scrollHeight 撑高
    assert.match(
        bubbleSource,
        /const adjustEditTextareaHeight = \(\) => \{\s*\n\s*const el = editTextareaRef\.value\s*\n\s*if \(!el\) return\s*\n\s*el\.style\.height = 'auto'\s*\n\s*el\.style\.height = `\$\{el\.scrollHeight\}px`\s*\n\s*\}/,
    )
    // 打字过程中持续自适应
    assert.match(bubbleSource, /@input="adjustEditTextareaHeight"/)
})

test('进入编辑即保证编辑框可见：撑高 + focus(preventScroll) + scrollIntoView(nearest)', () => {
    // 长消息只露下半截时点行底编辑按钮，塌缩后行顶（textarea 所在）可能在
    // 视口外——用户触发了编辑却看不到编辑框。必须在 nextTick（textarea 挂载
    // 完成）后撑高并滚回视口；focus 用 preventScroll 关掉默认滚动，统一交给
    // nearest（尽量少动视口）
    assert.match(
        bubbleSource,
        /await nextTick\(\)\s*\n\s*adjustEditTextareaHeight\(\)\s*\n\s*editTextareaRef\.value\?\.focus\(\{ preventScroll: true \}\)\s*\n\s*editTextareaRef\.value\?\.scrollIntoView\(\{ block: 'nearest' \}\)/,
    )
})
