// tests/goalbar-clear.test.ts
// node:test 源码锚定（GoalBar.vue / useGoalState 难以单独挂载，同 pending-queue-wiring 模式）。
// 契约：清除按钮（停止态）→ useConfirm 二次确认 → POST /clear → applyState(null)；
// 其他窗口的实时闭合靠服务端 ext.goal_cleared 推送（useGoalState 监听 → applyState(null)）。
// 事件名与 seedagent extensions/goal/index.ts GOAL_CLEARED_EVENT 同值（两仓契约，改名须同步）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8')

const goalBarSource = read('src/components/chat/GoalBar.vue')
const goalStateSource = read('src/composables/useGoalState.ts')
const zhSource = read('src/i18n/zh.ts')
const enSource = read('src/i18n/en.ts')

test('GoalBar: 清除按钮仅停止态显示，confirm 先于 POST，key 在 confirm 前捕获', () => {
    // 按钮存在且条件与 restart 同款（停止态 = !enabled）
    assert.match(goalBarSource, /v-if="!goalState!\.enabled" type="button" :disabled="clearing"/)
    assert.match(goalBarSource, /@click="clearGoal\(\)"/)

    const start = goalBarSource.indexOf('async function clearGoal()')
    assert.ok(start >= 0, 'clearGoal 应存在')
    const fn = goalBarSource.slice(start, goalBarSource.indexOf('\nasync function', start + 1) === -1 ? undefined : goalBarSource.indexOf('\nasync function', start + 1))

    // key 在 confirm 前捕获：弹窗期间切会话，确认后仍清除点击时的会话（applyState 归属
    // 守卫比对的是响应到达时刻的当前会话，key 现取会串会话）
    const keyPos = fn.indexOf('const key = chatState.sessionKey')
    const confirmPos = fn.indexOf('await confirm(')
    assert.ok(keyPos >= 0, 'key 捕获应存在')
    assert.ok(confirmPos > keyPos, 'key 必须在 confirm await 之前捕获')

    // 确认取消即返回：不清除、不 POST
    assert.match(fn, /if \(!confirmed\) return/)

    // 按钮线闭合：POST 成功后 applyState(null, key)
    assert.match(fn, /apiPost\(`\/api\/extensions\/goal\/\$\{encodeURIComponent\(key\)\}\/clear`\)/)
    assert.match(fn, /applyState\(null, key\)/)
})

test('useGoalState: ext.goal_cleared 推送 → applyState(null)（其他窗口实时闭合）', () => {
    assert.match(
        goalStateSource,
        /onExtensionEvent\('ext\.goal_cleared', \(_data, key\) => applyState\(null, key\)\)/,
    )
})

test('i18n: 清除提示与确认文案两语言齐备', () => {
    for (const src of [zhSource, enSource]) {
        assert.match(src, /clearHint: '/)
        assert.match(src, /clearConfirm: '/)
    }
})
