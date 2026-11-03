import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const componentPath = path.resolve(testDir, '../src/components/agents/tabs/AgentOverview.vue')
const statePath = path.resolve(testDir, '../src/composables/useAgentsState.ts')
const source = readFileSync(componentPath, 'utf8')
const stateSource = readFileSync(statePath, 'utf8')

test('maxTurns 输入框 change 提交而非逐击键提交', () => {
    // 回归锚：type=number 对 "1."/"-" 等未完成输入在 DOM 层规范为空串，逐击键
    // （input 事件）会把「正在输入」误读成「主动清空」而误发 maxTurns: null，
    // 用户敲 1.5 的过程实际把上限解除。.lazy 让 setter 只在失焦/回车触达。
    assert.match(
        source,
        /v-model\.number\.lazy="maxTurns"/,
        'maxTurns input must commit on change (.lazy), not per keystroke',
    )
})

test('maxTurns 清空发 null 哨兵，非法值 toast 明示', () => {
    // null 是服务端 PATCH merge 站点的显式解除信号（deepMerge 跳过 undefined，
    // 发 undefined 表达不了「清掉存量值」）；0/负/非整数宁拒不吞且有反馈。
    assert.match(
        source,
        /maxTurns: null/,
        'clearing maxTurns must send the null sentinel, not undefined',
    )
    assert.match(
        source,
        /toast\.error\(t\('agent\.maxTurnsInvalid'\)\)/,
        'rejecting an invalid maxTurns must surface feedback instead of failing silently',
    )
})

test('AgentInfo / ProgressSettings 暴露 1.5.0 新字段供 GET 回显', () => {
    assert.match(stateSource, /maxTurns\?: number/, 'AgentInfo must expose maxTurns for GET echo')
    assert.match(
        stateSource,
        /persistWithinMs\?: number/,
        'ProgressSettings must expose persistWithinMs for GET echo',
    )
})

test('进度弹窗接线 persistWithinMs 且保存时同款省略语义', () => {
    assert.match(
        source,
        /persistWithinMs: p\?\.persistWithinMs \?\? 1000/,
        'progress modal must echo persistWithinMs with the upstream default 1000',
    )
    assert.match(
        source,
        /\.\.\.\(persistWithinMs !== undefined \? \{ persistWithinMs \} : \{\}\)/,
        'saving progress must omit an empty persistWithinMs so deepMerge keeps the stored value',
    )
})
