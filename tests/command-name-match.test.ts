import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
    matchCommandQuery,
    commandMatchRank,
    filterByCommandQuery,
    sortByCommandMatchRank,
} from '../src/utils/command-name-match.ts'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const commandStateSource = readFileSync(
    path.join(testDir, '../src/composables/useCommandState.ts'),
    'utf8',
)
const clientCommandsSource = readFileSync(
    path.join(testDir, '../src/composables/clientCommands.ts'),
    'utf8',
)
const chatInputSource = readFileSync(
    path.join(testDir, '../src/composables/useChatInput.ts'),
    'utf8',
)

/** 剥掉注释再锚定，防止「注释里留函数名」的假绿 */
const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('全名前缀命中（原行为保留）', () => {
    assert.equal(matchCommandQuery('skill:wait-what', 'skill:wait'), true)
    assert.equal(matchCommandQuery('skill:wait-what', 'skill:'), true)
    assert.equal(matchCommandQuery('taskbar', 'task'), true)
    assert.equal(matchCommandQuery('help', 'helpx'), false)
})

test('名字段子串命中：/what 命中 skill:wait-what，不限技能', () => {
    assert.equal(matchCommandQuery('skill:wait-what', 'what'), true)
    assert.equal(matchCommandQuery('skill:wait-what', 'wait'), true)
    assert.equal(matchCommandQuery('skill:wait-what', 'WAIT'), true, '大小写不敏感')
    // 同一条规则同样作用于非技能命令（无 `:` 时整名即名字段）
    assert.equal(matchCommandQuery('taskbar', 'bar'), true)
    assert.equal(matchCommandQuery('wait-what', 'what'), true)
})

test('命名空间本身不参与子串搜索：kill / ill 不会命中所有技能', () => {
    assert.equal(matchCommandQuery('skill:wait-what', 'kill'), false)
    assert.equal(matchCommandQuery('skill:wait-what', 'ill'), false)
    assert.equal(matchCommandQuery('skill:wait-what', 'ski'), true, '全名前缀仍命中')
    // query 横跨命名空间与名字段、又不是全名前缀 → 不命中
    assert.equal(matchCommandQuery('skill:wait-what', 'skill:what'), false)
    assert.equal(matchCommandQuery('skill:wait-what', 'l:wait'), false)
    assert.equal(matchCommandQuery('skill:wait-what', ':'), false)
})

test('多冒号名字：只有最后一个 `:` 之后的段参与子串', () => {
    assert.equal(matchCommandQuery('skill:a:b', 'b'), true)
    assert.equal(matchCommandQuery('skill:a:b', 'a'), false)
    assert.equal(matchCommandQuery('skill:a:b', 'a:b'), false)
    assert.equal(matchCommandQuery('skill:a:b', 'skill:a'), true, '全名前缀不受影响')
})

test('空查询恒匹配（裸 / 显示全量）', () => {
    assert.equal(matchCommandQuery('skill:wait-what', ''), true)
    assert.equal(matchCommandQuery('help', ''), true)
})

test('命中强度分级：精确 > 全名前缀 > 名字段精确 > 名字段子串', () => {
    assert.equal(commandMatchRank('taskbar', 'taskbar'), 0)
    assert.equal(commandMatchRank('taskbar-extra', 'taskbar'), 1)
    assert.equal(commandMatchRank('skill:wait', 'wait'), 2, '名字段精确')
    assert.equal(commandMatchRank('skill:x-taskbar', 'taskbar'), 3, '名字段子串')
    assert.equal(commandMatchRank('help', 'taskbar'), -1)
    // 空查询全部按前缀档（1），配合稳定排序保持原序
    assert.equal(commandMatchRank('anything', ''), 1)
})

test('旧前缀命中集是新匹配规则的子集（无回归丢失）', () => {
    const names = ['help', 'taskbar', 'skill:wait-what', 'skill:wait', 'goalbar', 'bgagents']
    const queries = [
        '', 'h', 'he', 'help', 'task', 'taskbar', 'skill', 'skill:',
        'skill:w', 'skill:wait', 'wait', 'what', 'goal', 'bg', 'zzz', 'TREE', 'tree',
    ]
    for (const query of queries) {
        const oldHits = names.filter(n => n.toLowerCase().startsWith(query.toLowerCase()))
        const newHits = names.filter(n => matchCommandQuery(n, query))
        for (const name of oldHits) {
            assert.ok(
                newHits.includes(name),
                `旧前缀命中 ${JSON.stringify(name)} @ ${JSON.stringify(query)} 不得丢失`,
            )
        }
    }
})

test('filterByCommandQuery：行为级过滤（服务端表与客户端注册表共用）', () => {
    const cmds = [
        { name: 'skill:x-taskbar' },
        { name: 'taskbar' },
        { name: 'help' },
        { name: 'taskbar-extra' },
    ]
    assert.deepEqual(
        filterByCommandQuery(cmds, 'taskbar').map(cmd => cmd.name),
        ['skill:x-taskbar', 'taskbar', 'taskbar-extra'],
        '过滤只筛不排，保持传入顺序',
    )
    assert.deepEqual(filterByCommandQuery(cmds, 'zzz'), [])
    assert.deepEqual(filterByCommandQuery(cmds, '').map(cmd => cmd.name), [
        'skill:x-taskbar',
        'taskbar',
        'help',
        'taskbar-extra',
    ])
})

test('sortByCommandMatchRank：手打全名时精确/前缀命中排在弱命中之前', () => {
    const cmds = [
        { name: 'skill:x-taskbar' },
        { name: 'taskbar' },
        { name: 'help' },
        { name: 'taskbar-extra' },
        { name: 'skill:my-taskbar' },
    ]
    const snapshot = [...cmds]
    assert.deepEqual(sortByCommandMatchRank(cmds, 'taskbar').map(cmd => cmd.name), [
        'taskbar', // 精确
        'taskbar-extra', // 全名前缀
        'skill:x-taskbar', // 子串，同级保持原相对序
        'skill:my-taskbar',
    ])
    assert.deepEqual(cmds, snapshot, '不得异变传入数组')
    // 空查询：全部同档，稳定排序不改变原序（裸 / 仍按命令表顺序展示）
    assert.deepEqual(sortByCommandMatchRank(cmds, '').map(cmd => cmd.name), [
        'skill:x-taskbar',
        'taskbar',
        'help',
        'taskbar-extra',
        'skill:my-taskbar',
    ])
    assert.deepEqual(cmds, snapshot, '不得异变传入数组')
})

test('sortByCommandMatchRank：名字段精确优先于段子串（/wait 优先 skill:wait）', () => {
    const cmds = [{ name: 'skill:wait-what' }, { name: 'skill:wait' }]
    assert.deepEqual(sortByCommandMatchRank(cmds, 'wait').map(cmd => cmd.name), [
        'skill:wait', // 名字段精确
        'skill:wait-what', // 名字段子串
    ])
})

test('接线锚定：两表过滤同源 + 补全面板按命中强度排序', () => {
    // 必须真的 import 共享模块，不许文件内复刻同名函数另起口径
    const utilImport = /from\s+['"][^'"]*command-name-match\.ts['"]/
    assert.match(commandStateSource, utilImport, 'useCommandState 必须从 command-name-match 导入')
    assert.match(clientCommandsSource, utilImport, 'clientCommands 必须从 command-name-match 导入')
    assert.match(chatInputSource, utilImport, 'useChatInput 必须从 command-name-match 导入')

    const strippedState = stripComments(commandStateSource)
    const strippedClient = stripComments(clientCommandsSource)
    const strippedChat = stripComments(chatInputSource)

    assert.match(strippedState, /(?<![\w$])filterByCommandQuery\s*\(/)
    assert.match(strippedClient, /(?<![\w$])filterByCommandQuery\s*\(/)
    assert.match(strippedChat, /(?<![\w$])sortByCommandMatchRank\s*\(/)
    // 服务端命令进补全面板的唯一通路
    assert.match(strippedChat, /filterCommands\.value\s*\(/)
    // 排序结果必须真的赋给 commandSuggestions（排完丢弃 = 假绿）
    assert.match(
        strippedChat,
        /commandSuggestions\.value\s*=\s*sortByCommandMatchRank\s*\(\s*merged\s*,\s*query\s*\)/,
    )
    // 两个过滤宿主不得残留前缀过滤实现
    assert.doesNotMatch(strippedState, /\.startsWith\(/)
    assert.doesNotMatch(strippedClient, /\.startsWith\(/)
})
