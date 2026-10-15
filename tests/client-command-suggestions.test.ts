// tests/client-command-suggestions.test.ts
// 客户端命令统一注册表（clientCommands.ts）的 wiring 断言。
//
// 背景：/tasklist、/tree 是前端本地拦截的客户端命令，不在服务端 /api/commands
// 命令表里，`/` 补全与「命令」按钮下拉都看不到。方案：clientCommands.ts
// 作为唯一注册表，useChatInput 的 watch 合并进 / 补全（按 name 去重），
// ChatInput 下拉渲染「本地指令」分区；/tree 从静态 COMMANDS 移入注册表防重复。
//
// clientCommands.ts 是纯模块（仅 type 依赖 useCommandState），可直接单测；
// useChatInput / ChatInput 依赖 vue，沿用 tasklist-restore-command.test.ts 的
// 源码结构断言模式。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_COMMANDS, filterClientCommands } from '../src/composables/clientCommands.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const chatInputSource = readFileSync(path.join(repoRoot, 'src/composables/useChatInput.ts'), 'utf8')
const chatInputVueSource = readFileSync(path.join(repoRoot, 'src/components/chat/ChatInput.vue'), 'utf8')
const commandStateSource = readFileSync(path.join(repoRoot, 'src/composables/useCommandState.ts'), 'utf8')

test('注册表：/tasklist 与 /tree 已登记，带下拉文案与 client 来源', () => {
    const names = CLIENT_COMMANDS.map(cmd => cmd.name)
    assert.ok(names.includes('tasklist'), '注册表必须包含 /tasklist')
    assert.ok(names.includes('tree'), '注册表必须包含 /tree')
    for (const cmd of CLIENT_COMMANDS) {
        assert.equal(cmd.source, 'client', `${cmd.name} 必须标记 source: 'client'`)
        assert.ok(cmd.dropdownLabel, `${cmd.name} 必须提供下拉文案 dropdownLabel`)
    }
})

test('注册表：filterClientCommands 按前缀过滤，输出纯 CommandInfo（无下拉元数据）', () => {
    assert.deepEqual(filterClientCommands('').map(cmd => cmd.name), ['tasklist', 'tree', 'goalbar'])
    assert.deepEqual(filterClientCommands('ta').map(cmd => cmd.name), ['tasklist'])
    assert.deepEqual(filterClientCommands('goal').map(cmd => cmd.name), ['goalbar'], '前缀 goal 同时命中服务端 /goal，合并去重后两者并存')
    assert.deepEqual(filterClientCommands('TREE').map(cmd => cmd.name), ['tree'], '前缀过滤须大小写不敏感')
    assert.deepEqual(filterClientCommands('zzz'), [])
    for (const cmd of filterClientCommands('')) {
        assert.ok(!('dropdownLabel' in cmd), '补全条目不得携带 dropdownLabel')
        assert.ok(!('autoSend' in cmd), '补全条目不得携带 autoSend')
    }
})

test('补全合并：useChatInput watch 合并 filterClientCommands 且按 name 去重', () => {
    assert.match(chatInputSource, /const serverNames = new Set\(serverMatches\.map\(cmd => cmd\.name\)\)/)
    assert.match(
        chatInputSource,
        /filterClientCommands\(prefix\)\.filter\(cmd => !serverNames\.has\(cmd\.name\)\)/,
        '客户端命令必须按 name 去重后再合并，防服务端未来同名下发',
    )
})

test('下拉分区：ChatInput 渲染本地指令分区，且 /tree 不再留在静态 COMMANDS', () => {
    assert.match(chatInputVueSource, /\$t\('chat\.clientCommands'\)/)
    assert.match(chatInputVueSource, /v-for="cmd in clientCommandItems"/)
    // /tree 已由注册表分区提供，静态列表里不得残留（否则下拉出现两次）
    assert.ok(!chatInputSource.includes("value: '/tree'"), '/tree 必须从静态 COMMANDS 移除，改由注册表提供')
})

test('徽章：CommandInfo source 联合类型含 client，SOURCE_BADGES 补本地徽章', () => {
    assert.match(commandStateSource, /'builtin' \| 'extension' \| 'prompt' \| 'skill' \| 'client'/)
    assert.match(chatInputVueSource, /client: \{ cls: 'badge-ghost', label: '本地' \}/)
})
