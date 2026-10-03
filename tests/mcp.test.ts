import test from 'node:test'
import assert from 'node:assert/strict'

import {
    emptyForm,
    errorsForTransportKind,
    formFromItem,
    formToPayload,
    mcpToolName,
    needsAuthPolling,
    needsConvergePolling,
    splitArgs,
    stateTone,
    validateForm,
} from '../src/utils/mcp.ts'
import type { McpServerItem } from '../src/utils/mcp.ts'

test('splitArgs: 空格/tab/换行切分，引号保留空格', () => {
    assert.deepEqual(splitArgs('npx -y server-fs /ws'), ['npx', '-y', 'server-fs', '/ws'])
    assert.deepEqual(splitArgs('  npx   -y  '), ['npx', '-y'])
    assert.deepEqual(splitArgs('cmd "a b" \'c d\''), ['cmd', 'a b', 'c d'])
    assert.deepEqual(splitArgs(''), [])
})

test('validateForm: stdio 缺 command / http 非法 url / agents 空 均被拦下', () => {
    const base = emptyForm()
    assert.equal(validateForm({ ...base, id: 'fs', command: 'npx' }).length, 0)

    assert.deepEqual(validateForm({ ...base, command: 'npx' }), ['idRequired'])
    assert.deepEqual(validateForm({ ...base, id: 'bad id!', command: 'npx' }), ['idPattern'])
    assert.deepEqual(validateForm({ ...base, id: 'x'.repeat(65), command: 'npx' }), ['idPattern'])
    assert.deepEqual(validateForm({ ...base, id: 'fs', command: '' }), ['commandRequired'])

    const http = { ...base, id: 'r', transportKind: 'http' as const, url: 'not-a-url' }
    assert.deepEqual(validateForm(http), ['urlInvalid'])
    const httpOk = { ...base, id: 'r', transportKind: 'http' as const, url: 'https://mcp.example.com/mcp' }
    assert.deepEqual(validateForm(httpOk), [])

    const noAgents = { ...httpOk, agentsAll: false, agents: [] }
    assert.deepEqual(validateForm(noAgents), ['agentsRequired'])
})

test('errorsForTransportKind: 切换传输类型清掉旧类型的错误键', () => {
    // 切到 http：清掉 stdio 的 commandRequired；切到 stdio：清掉 http 的 url 错误
    const httpForm = { ...emptyForm(), transportKind: 'http' as const }
    assert.deepEqual(errorsForTransportKind(httpForm, ['urlInvalid', 'commandRequired', 'agentsRequired']), [
        'urlInvalid',
        'agentsRequired',
    ])
    const stdioForm = { ...emptyForm(), transportKind: 'stdio' as const }
    assert.deepEqual(errorsForTransportKind(stdioForm, ['urlRequired', 'urlInvalid', 'commandRequired']), [
        'commandRequired',
    ])
})

test('formToPayload: stdio 表单 → wire 格式（args 切分、agentsAll → "*"）', () => {
    const form = { ...emptyForm(), id: 'fs', command: 'npx', argsText: '-y server-fs "/my ws"' }
    const payload = formToPayload(form) as any
    assert.equal(payload.id, 'fs')
    assert.equal(payload.enabled, true)
    assert.deepEqual(payload.agents, '*')
    assert.deepEqual(payload.transport, { type: 'stdio', command: 'npx', args: ['-y', 'server-fs', '/my ws'] })
})

test('formToPayload: 未知传输字段（env/inheritEnv）原样合回，编辑不丢配置', () => {
    const form = {
        ...emptyForm(),
        id: 'fs',
        command: 'npx',
        extraTransport: { env: { TOKEN: 'secret' }, inheritEnv: false },
    }
    const payload = formToPayload(form) as any
    assert.deepEqual(payload.transport, {
        env: { TOKEN: 'secret' },
        inheritEnv: false,
        type: 'stdio',
        command: 'npx',
    })
})

test('formToPayload: http + oauth 模式 → auth 字段且不写 headers', () => {
    const form = {
        ...emptyForm(),
        id: 'r',
        transportKind: 'http' as const,
        url: 'https://a.b/mcp',
        authMode: 'oauth' as const,
        apiKeyValue: 'Bearer leftover', // oauth 模式下应被忽略
        extraHeaders: [{ key: 'X-A', value: '1' }],
    }
    const payload = formToPayload(form) as any
    assert.deepEqual(payload.transport, { type: 'http', url: 'https://a.b/mcp', auth: { type: 'oauth' } })
})

test('formToPayload: apiKey 模式 → Authorization header（默认头名可覆盖）', () => {
    const form = {
        ...emptyForm(),
        id: 'r',
        transportKind: 'http' as const,
        url: 'https://a.b/mcp',
        authMode: 'apiKey' as const,
        apiKeyHeader: 'Authorization',
        apiKeyValue: 'Bearer YOUR_API_KEY',
        extraHeaders: [
            { key: 'X-Trace', value: '1' },
            { key: '', value: '忽略空 key' },
        ],
    }
    const payload = formToPayload(form) as any
    assert.deepEqual(payload.transport, {
        type: 'http',
        url: 'https://a.b/mcp',
        headers: { Authorization: 'Bearer YOUR_API_KEY', 'X-Trace': '1' },
    })

    // 自定义头名
    const custom = { ...form, apiKeyHeader: 'X-Api-Key' }
    const payload2 = formToPayload(custom) as any
    assert.equal(payload2.transport.headers['X-Api-Key'], 'Bearer YOUR_API_KEY')
    assert.equal(payload2.transport.headers.Authorization, undefined)
})

test('formToPayload: 同名自定义 Header 不静默覆盖主鉴权头', () => {
    const form = {
        ...emptyForm(),
        id: 'r',
        transportKind: 'http' as const,
        url: 'https://a.b/mcp',
        authMode: 'apiKey' as const,
        apiKeyHeader: 'Authorization',
        apiKeyValue: 'Bearer REAL',
        extraHeaders: [{ key: 'authorization', value: 'Bearer EVIL' }],
    }
    const payload = formToPayload(form) as any
    assert.equal(payload.transport.headers.Authorization, 'Bearer REAL')
    assert.equal(payload.transport.headers.authorization, undefined)
})

test('formToPayload: displayName 恒为字符串（空串 = 显式清除，服务端负责区分部分更新回退）', () => {
    const form = { ...emptyForm(), id: 'r', transportKind: 'stdio' as const, command: 'npx', displayName: '' }
    const payload = formToPayload(form) as any
    assert.equal(payload.displayName, '')
})

test('formFromItem: http headers → apiKey 模式回填（主头 + 自定义列表）', () => {
    const item: McpServerItem = {
        id: 'remote',
        displayName: '远程',
        enabled: true,
        state: 'connected',
        toolCount: 1,
        toolNames: ['echo'],
        agents: ['a1'],
        transport: {
            type: 'http',
            url: 'https://a.b/mcp',
            headers: { Authorization: 'Bearer x', 'X-A': '1' },
        },
        updatedAt: '',
    }
    const form = formFromItem(item)
    assert.equal(form.authMode, 'apiKey')
    assert.equal(form.apiKeyHeader, 'Authorization')
    assert.equal(form.apiKeyValue, 'Bearer x')
    assert.deepEqual(form.extraHeaders, [{ key: 'X-A', value: '1' }])
    // 往返一致
    const payload = formToPayload(form) as any
    assert.deepEqual(payload.transport.headers, { Authorization: 'Bearer x', 'X-A': '1' })

    // OAuth 型 → authMode oauth；无鉴权 → none
    const oauth = formFromItem({ ...item, transport: { type: 'http', url: 'https://a.b/mcp', auth: { type: 'oauth' } } })
    assert.equal(oauth.authMode, 'oauth')
    const plain = formFromItem({ ...item, transport: { type: 'http', url: 'https://a.b/mcp' } })
    assert.equal(plain.authMode, 'none')
})

test('validateForm: apiKey 模式缺 Header 值被拦下', () => {
    const base = { ...emptyForm(), id: 'r', transportKind: 'http' as const, url: 'https://a.b/mcp' }
    assert.deepEqual(validateForm({ ...base, authMode: 'apiKey', apiKeyValue: '' }), ['apiKeyRequired'])
    assert.deepEqual(validateForm({ ...base, authMode: 'apiKey', apiKeyValue: 'Bearer x' }), [])
    assert.deepEqual(validateForm({ ...base, authMode: 'none' }), [])
})

test('formFromItem: 回填编辑表单（stdio 含 env / http 含 oauth）', () => {
    const item: McpServerItem = {
        id: 'remote',
        displayName: '远程',
        enabled: true,
        state: 'connected',
        toolCount: 1,
        toolNames: ['echo'],
        agents: ['a1'],
        transport: { type: 'http', url: 'https://a.b/mcp', auth: { type: 'oauth' } },
        updatedAt: '',
    }
    const form = formFromItem(item)
    assert.equal(form.transportKind, 'http')
    assert.equal(form.authMode, 'oauth')
    assert.equal(form.agentsAll, false)
    assert.deepEqual(form.agents, ['a1'])

    const stdio: McpServerItem = {
        ...item,
        id: 'fs',
        agents: '*',
        transport: { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' }, inheritEnv: false },
    }
    const form2 = formFromItem(stdio)
    assert.equal(form2.transportKind, 'stdio')
    assert.equal(form2.command, 'npx')
    assert.equal(form2.argsText, '-y x')
    assert.equal(form2.agentsAll, true)
    // UI 不认识的字段进 extraTransport（保存时合回，不丢配置）
    assert.deepEqual(form2.extraTransport, { env: { A: '1' }, inheritEnv: false })
})

test('mcpToolName: 与服务端一致的清洗与前缀', () => {
    assert.equal(mcpToolName('fs', 'read.file'), 'mcp_fs_read_file')
    assert.equal(mcpToolName('a-b', 'x y/z'), 'mcp_a-b_x_y_z')
    assert.equal(mcpToolName('s', 'x'.repeat(80)).length, 64)
})

test('stateTone / needsAuthPolling / needsConvergePolling', () => {
    assert.equal(stateTone('connected'), 'ok')
    assert.equal(stateTone('error'), 'bad')
    assert.equal(stateTone('reconnecting'), 'warn')
    assert.equal(stateTone('disabled'), 'idle')

    const base = {
        id: 'x',
        displayName: 'x',
        enabled: true,
        state: 'auth_required' as const,
        toolCount: 0,
        toolNames: [],
        agents: '*' as const,
        transport: { type: 'stdio' as const, command: 'c' },
        updatedAt: '',
    }
    assert.equal(needsAuthPolling(base), true)
    assert.equal(needsAuthPolling({ ...base, state: 'connected' }), false)
    assert.equal(needsConvergePolling({ ...base, state: 'connecting' }), true)
    assert.equal(needsConvergePolling({ ...base, state: 'connected' }), false)
})
