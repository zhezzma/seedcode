import test from 'node:test'
import assert from 'node:assert/strict'

import {
    emptyHookForm,
    hookFormFromItem,
    hookFormToPayload,
    HOOK_EVENTS,
    isServerEvent,
    isToolEvent,
    maxTimeoutFor,
    validateHookForm,
} from '../src/utils/hooks.ts'
import type { HookEvent, HookItem } from '../src/utils/hooks.ts'

/** 全字段齐备的最小 HookItem（往返测试基底）。 */
function makeItem(): HookItem {
    return {
        id: 'h1',
        enabled: true,
        event: 'PreToolUse',
        runMode: 'shell',
        command: 'echo hi',
        args: [],
        shell: '',
        matcher: 'Bash',
        background: false,
        timeoutSec: 60,
        statusMessage: 'running',
        agents: '*',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
    }
}

test('emptyHookForm: 默认值逐字段（PreToolUse / shell / timeoutSec 60 / agentsAll / enabled）', () => {
    const form = emptyHookForm()
    assert.equal(form.event, 'PreToolUse')
    assert.equal(form.runMode, 'shell')
    assert.equal(form.command, '')
    assert.equal(form.argsText, '')
    assert.equal(form.shell, '')
    assert.equal(form.matcher, '')
    assert.equal(form.background, false)
    assert.equal(form.timeoutSec, 60)
    assert.equal(form.statusMessage, '')
    assert.equal(form.customText, '')
    assert.equal(form.agentsAll, true)
    assert.deepEqual(form.agents, [])
    assert.equal(form.enabled, true)
})

test('HOOK_EVENTS: 7 个事件，顺序同 spec §3 表', () => {
    assert.deepEqual(HOOK_EVENTS, [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'ServerStart',
        'ServerStop',
    ])
})

test('isToolEvent / isServerEvent / maxTimeoutFor: 7 个事件逐个断言', () => {
    const tool: HookEvent[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']
    const server: HookEvent[] = ['ServerStart', 'ServerStop']
    const lifecycle: HookEvent[] = ['SessionStart', 'UserPromptSubmit']
    for (const e of HOOK_EVENTS) {
        assert.equal(isToolEvent(e), tool.includes(e), `isToolEvent(${e})`)
        assert.equal(isServerEvent(e), server.includes(e), `isServerEvent(${e})`)
        const max = maxTimeoutFor(e)
        if (e === 'ServerStop') assert.equal(max, 30, `maxTimeoutFor(${e})`)
        else assert.equal(max, 600, `maxTimeoutFor(${e})`)
    }
    assert.equal(tool.length + server.length + lifecycle.length, 7)
})

test('hookFormToPayload: argsText 逐行 trim、丢弃空行', () => {
    const form = { ...emptyHookForm(), command: 'c', argsText: 'a\n\n b \n' }
    const payload = hookFormToPayload(form) as any
    assert.deepEqual(payload.args, ['a', 'b'])
})

test('hookFormToPayload: customText 空 → 不含 custom 键；JSON → custom 对象', () => {
    const empty = hookFormToPayload({ ...emptyHookForm(), command: 'c' }) as any
    assert.equal('custom' in empty, false)

    const withCustom = hookFormToPayload({ ...emptyHookForm(), command: 'c', customText: '{"k":1}' }) as any
    assert.deepEqual(withCustom.custom, { k: 1 })
})

test('hookFormToPayload: agentsAll → "*"，否则数组', () => {
    const all = hookFormToPayload({ ...emptyHookForm(), command: 'c' }) as any
    assert.equal(all.agents, '*')

    const pick = hookFormToPayload({ ...emptyHookForm(), command: 'c', agentsAll: false, agents: ['a1', 'a2'] }) as any
    assert.deepEqual(pick.agents, ['a1', 'a2'])
})

test('hookFormToPayload: process 模式 background 强制 false（后台只在 shell 模式生效）', () => {
    const shell = hookFormToPayload({ ...emptyHookForm(), command: 'c', background: true }) as any
    assert.equal(shell.background, true)

    const process = hookFormToPayload({
        ...emptyHookForm(),
        command: 'c',
        runMode: 'process',
        background: true,
    }) as any
    assert.equal(process.background, false)
})

test('hookFormToPayload: 服务器事件 agents 强制 "*"（agentsAll false 且 agents 空）', () => {
    for (const event of ['ServerStart', 'ServerStop'] as const) {
        const payload = hookFormToPayload({
            ...emptyHookForm(),
            command: 'c',
            event,
            agentsAll: false,
            agents: [],
        }) as any
        assert.equal(payload.agents, '*', `event=${event}`)
    }
})

test('hookFormToPayload: ServerStart background 强制 true，ServerStop 强制 false', () => {
    const start = hookFormToPayload({
        ...emptyHookForm(),
        command: 'c',
        event: 'ServerStart',
        background: false,
    }) as any
    assert.equal(start.background, true)

    const stop = hookFormToPayload({
        ...emptyHookForm(),
        command: 'c',
        event: 'ServerStop',
        background: true,
    }) as any
    assert.equal(stop.background, false)
})

test('hookFormToPayload: 服务器事件 matcher 强制 ""（非空表单值也被清空）', () => {
    for (const event of ['ServerStart', 'ServerStop'] as const) {
        const payload = hookFormToPayload({ ...emptyHookForm(), command: 'c', event, matcher: 'Bash' }) as any
        assert.equal(payload.matcher, '', `event=${event}`)
    }
})

test('hookFormFromItem/hookFormToPayload: 往返，可编辑字段逐字段相等', () => {
    const item = makeItem()
    const round = hookFormToPayload(hookFormFromItem(item)) as any
    assert.equal(round.event, item.event)
    assert.equal(round.runMode, item.runMode)
    assert.equal(round.command, item.command)
    assert.deepEqual(round.args, item.args)
    assert.equal(round.shell, item.shell)
    assert.equal(round.matcher, item.matcher)
    assert.equal(round.background, item.background)
    assert.equal(round.timeoutSec, item.timeoutSec)
    assert.equal(round.statusMessage, item.statusMessage)
    assert.deepEqual(round.agents, item.agents)
    assert.equal(round.enabled, item.enabled)
})

test('hookFormFromItem: custom 回填为两空格缩进 JSON；process 模式 args 逐行回填', () => {
    const item = { ...makeItem(), custom: { k: 1, nested: { a: 'b' } } }
    const form = hookFormFromItem(item)
    assert.equal(form.customText, JSON.stringify({ k: 1, nested: { a: 'b' } }, null, 2))

    // 回填的 customText 保存时还原为原对象
    const round = hookFormToPayload(form) as any
    assert.deepEqual(round.custom, { k: 1, nested: { a: 'b' } })

    const proc = hookFormFromItem({ ...makeItem(), runMode: 'process', args: ['a', 'b'] })
    assert.equal(proc.argsText, 'a\nb')
})

test('hookFormFromItem: agents "*" → agentsAll；数组 → 逐项拷贝', () => {
    const star = hookFormFromItem(makeItem())
    assert.equal(star.agentsAll, true)
    assert.deepEqual(star.agents, [])

    const picked = hookFormFromItem({ ...makeItem(), agents: ['a1'] })
    assert.equal(picked.agentsAll, false)
    assert.deepEqual(picked.agents, ['a1'])
})

test('validateHookForm: command 只有空白 → commandRequired', () => {
    assert.ok(validateHookForm({ ...emptyHookForm(), command: '   ' }).includes('commandRequired'))
    assert.ok(!validateHookForm({ ...emptyHookForm(), command: ' echo ' }).includes('commandRequired'))
})

test('validateHookForm: timeoutSec 0 / 601 / 1.5 → timeoutInvalid', () => {
    for (const timeoutSec of [0, 601, 1.5]) {
        assert.ok(
            validateHookForm({ ...emptyHookForm(), command: 'c', timeoutSec }).includes('timeoutInvalid'),
            `timeoutSec=${timeoutSec}`,
        )
    }
    assert.deepEqual(validateHookForm({ ...emptyHookForm(), command: 'c', timeoutSec: 1 }), [])
    assert.deepEqual(validateHookForm({ ...emptyHookForm(), command: 'c', timeoutSec: 600 }), [])
})

test('validateHookForm: ServerStop timeoutSec 31 → timeoutInvalid（上限 30）', () => {
    const stop = { ...emptyHookForm(), command: 'c', event: 'ServerStop' as const }
    assert.ok(validateHookForm({ ...stop, timeoutSec: 31 }).includes('timeoutInvalid'))
    assert.deepEqual(validateHookForm({ ...stop, timeoutSec: 30 }), [])
})

test('validateHookForm: customText 非对象（[] / "x" / 残缺 JSON）→ customInvalid', () => {
    for (const customText of ['[]', '"x"', '{']) {
        assert.ok(
            validateHookForm({ ...emptyHookForm(), command: 'c', customText }).includes('customInvalid'),
            `customText=${customText}`,
        )
    }
    assert.deepEqual(validateHookForm({ ...emptyHookForm(), command: 'c', customText: '{"k":1}' }), [])
})

test('validateHookForm: agentsAll false 且 agents 空 → agentsRequired', () => {
    const form = { ...emptyHookForm(), command: 'c', agentsAll: false, agents: [] }
    assert.deepEqual(validateHookForm(form), ['agentsRequired'])
})

test('validateHookForm: 服务器事件 agents 空不报 agentsRequired（服务端强制 "*"）', () => {
    for (const event of ['ServerStart', 'ServerStop'] as const) {
        // timeoutSec 取各事件上限内合法值（ServerStop 上限 30）
        const form = { ...emptyHookForm(), command: 'c', event, timeoutSec: maxTimeoutFor(event), agentsAll: false, agents: [] }
        assert.deepEqual(validateHookForm(form), [], `event=${event}`)
    }
})

test('validateHookForm: 多错误一次全报', () => {
    const form = {
        ...emptyHookForm(),
        command: '',
        timeoutSec: 0,
        customText: '[]',
        agentsAll: false,
        agents: [],
    }
    assert.deepEqual(validateHookForm(form), ['commandRequired', 'timeoutInvalid', 'customInvalid', 'agentsRequired'])
})

test('hookFormToPayload: 非工具事件 matcher 强制 ""（SessionStart 不残留 Bash）', () => {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'ServerStart', 'ServerStop'] as const) {
        const payload = hookFormToPayload({ ...emptyHookForm(), command: 'c', event, matcher: 'Bash' }) as any
        assert.equal(payload.matcher, '', `event=${event}`)
    }
})

test('hookFormToPayload: 工具事件 matcher 保留', () => {
    const payload = hookFormToPayload({ ...emptyHookForm(), command: 'c', matcher: 'Write, Edit' }) as any
    assert.equal(payload.matcher, 'Write, Edit')
})

test('validateHookForm: args 100 项通过，101 项 → argsMax', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`).join('\n')
    assert.deepEqual(validateHookForm({ ...emptyHookForm(), command: 'c', argsText: lines(100) }), [])
    assert.deepEqual(validateHookForm({ ...emptyHookForm(), command: 'c', argsText: lines(101) }), ['argsMax'])
})

test('validateHookForm: custom 恰 16384 字节通过，超 1 字节 → customTooLarge（与服务端同口径：UTF-8 字节）', () => {
    // {"k":"…"} 骨架 8 字节 + n 个 ASCII 'A'，字节数 === 字符数
    const make = (n: number) => `{"k":"${'A'.repeat(n)}"}`
    // 自检：stringify(parse(...)) 后恰好 16384 字节
    assert.equal(Buffer.byteLength(JSON.stringify(JSON.parse(make(16376)))), 16384)
    assert.deepEqual(validateHookForm({ ...emptyHookForm(), command: 'c', customText: make(16376) }), [])
    assert.deepEqual(validateHookForm({ ...emptyHookForm(), command: 'c', customText: make(16377) }), ['customTooLarge'])
})
