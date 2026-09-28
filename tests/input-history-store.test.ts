import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'

class MemoryStorage implements Storage {
    private data = new Map<string, string>()

    get length() {
        return this.data.size
    }

    clear(): void {
        this.data.clear()
    }

    getItem(key: string): string | null {
        return this.data.has(key) ? this.data.get(key)! : null
    }

    key(index: number): string | null {
        return Array.from(this.data.keys())[index] ?? null
    }

    removeItem(key: string): void {
        this.data.delete(key)
    }

    setItem(key: string, value: string): void {
        this.data.set(key, value)
    }
}

const originalLocalStorage = globalThis.localStorage
const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
})

const createStore = async () => {
    setActivePinia(createPinia())
    const mod = await import('../src/stores/inputHistory.ts')
    return mod.useInputHistoryStore()
}

test.after(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
    })
})

test.beforeEach(() => {
    storage.clear()
})

test('persists per-session input history into localStorage', async () => {
    const store = await createStore()

    store.pushHistory('session-a', '  first command  ')
    store.pushHistory('session-a', 'second command')

    assert.deepEqual(store.getHistory('session-a'), ['first command', 'second command'])
    assert.equal(
        storage.getItem('seedcode_input_history'),
        JSON.stringify({ 'session-a': ['first command', 'second command'] }),
    )
})

test('reloads persisted history from localStorage in a fresh store instance', async () => {
    storage.setItem('seedcode_input_history', JSON.stringify({
        'session-a': ['cmd-1', 'cmd-2'],
        'session-b': ['other'],
    }))

    const store = await createStore()

    assert.deepEqual(store.getHistory('session-a'), ['cmd-1', 'cmd-2'])
    assert.deepEqual(store.getHistory('session-b'), ['other'])
})

test('removes stored history when a session is deleted locally', async () => {
    const store = await createStore()

    store.pushHistory('session-a', 'cmd-1')
    store.pushHistory('session-b', 'cmd-2')
    store.removeSessionHistory('session-a')

    assert.deepEqual(store.getHistory('session-a'), [])
    assert.deepEqual(store.getHistory('session-b'), ['cmd-2'])
    assert.equal(
        storage.getItem('seedcode_input_history'),
        JSON.stringify({ 'session-b': ['cmd-2'] }),
    )
})

test('deduplicates consecutive entries and enforces max length per session', async () => {
    const store = await createStore()

    store.pushHistory('session-a', 'same')
    store.pushHistory('session-a', 'same')
    for (let i = 0; i < 105; i++) {
        store.pushHistory('session-a', `cmd-${i}`)
    }

    const history = store.getHistory('session-a')
    assert.equal(history.length, 100)
    assert.equal(history[0], 'cmd-5')
    assert.equal(history[99], 'cmd-104')
})

test('persists per-session input draft into localStorage', async () => {
    const store = await createStore()

    store.setDraft('session-a', 'draft text')

    assert.equal(store.getDraft('session-a'), 'draft text')
    assert.equal(
        storage.getItem('seedcode_input_drafts'),
        JSON.stringify({ 'session-a': 'draft text' }),
    )
})

test('draft survives store reload from localStorage', async () => {
    storage.setItem('seedcode_input_drafts', JSON.stringify({
        'session-a': 'draft text',
        'session-b': 'other',
    }))

    const store = await createStore()

    assert.equal(store.getDraft('session-a'), 'draft text')
    assert.equal(store.getDraft('session-c'), '')
})

test('empty draft text removes the stored entry', async () => {
    const store = await createStore()

    store.setDraft('session-a', 'draft text')
    store.setDraft('session-a', '')

    assert.equal(store.getDraft('session-a'), '')
    assert.equal(storage.getItem('seedcode_input_drafts'), null)
})

test('removes stored draft when a session is deleted locally', async () => {
    const store = await createStore()

    store.setDraft('session-a', 'draft-a')
    store.setDraft('session-b', 'draft-b')
    store.removeSessionHistory('session-a')

    assert.equal(store.getDraft('session-a'), '')
    assert.equal(store.getDraft('session-b'), 'draft-b')
})

test('removes draft for sessions that never had history', async () => {
    const store = await createStore()

    store.setDraft('session-a', 'draft-a')
    store.removeSessionHistory('session-a')

    assert.equal(store.getDraft('session-a'), '')
    assert.equal(storage.getItem('seedcode_input_drafts'), null)
})

test('enforces max draft length', async () => {
    const store = await createStore()

    store.setDraft('session-a', 'x'.repeat(30000))

    assert.equal(store.getDraft('session-a').length, 20000)
})

test('clearAll clears drafts as well', async () => {
    const store = await createStore()

    store.setDraft('session-a', 'draft-a')
    store.clearAll()

    assert.equal(store.getDraft('session-a'), '')
    assert.equal(storage.getItem('seedcode_input_drafts'), null)
})

// ==================== 附件草稿 ====================

const IMG = 'data:image/png;base64,iVBORw0KGgo='

const att = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'attachment-runtime-id',
    name: 'pic.png',
    mimeType: 'image/png',
    dataUrl: IMG,
    ...over,
})

test('persists per-session draft attachments into localStorage with runtime ids stripped', async () => {
    const store = await createStore()

    store.setDraftAttachments('session-a', [
        att(),
        att({ id: 'attachment-2', name: 'notes.txt', mimeType: 'text/plain', dataUrl: '', content: 'hello' }),
    ])

    assert.equal(
        storage.getItem('seedcode_input_draft_attachments'),
        JSON.stringify({
            'session-a': [
                { name: 'pic.png', mimeType: 'image/png', dataUrl: IMG },
                { name: 'notes.txt', mimeType: 'text/plain', dataUrl: '', content: 'hello' },
            ],
        }),
    )
})

test('draft attachments survive store reload from localStorage', async () => {
    storage.setItem('seedcode_input_draft_attachments', JSON.stringify({
        'session-a': [{ name: 'pic.png', mimeType: 'image/png', dataUrl: IMG }],
    }))

    const store = await createStore()

    assert.deepEqual(store.getDraftAttachments('session-a'), [
        { name: 'pic.png', mimeType: 'image/png', dataUrl: IMG },
    ])
    assert.deepEqual(store.getDraftAttachments('session-b'), [])
})

test('invalid attachment entries are dropped on load', async () => {
    storage.setItem('seedcode_input_draft_attachments', JSON.stringify({
        'session-a': [
            { name: 'pic.png', mimeType: 'image/png', dataUrl: IMG },
            { broken: true },
            { name: 'empty.bin', mimeType: 'application/octet-stream', dataUrl: '' },
        ],
    }))

    const store = await createStore()

    assert.deepEqual(store.getDraftAttachments('session-a'), [
        { name: 'pic.png', mimeType: 'image/png', dataUrl: IMG },
    ])
})

test('empty attachment list removes the stored entry', async () => {
    const store = await createStore()

    store.setDraftAttachments('session-a', [att()])
    store.setDraftAttachments('session-a', [])

    assert.deepEqual(store.getDraftAttachments('session-a'), [])
    assert.equal(storage.getItem('seedcode_input_draft_attachments'), null)
})

test('removes stored draft attachments when a session is deleted locally', async () => {
    const store = await createStore()

    store.setDraftAttachments('session-a', [att()])
    store.setDraftAttachments('session-b', [att({ name: 'b.png' })])
    store.removeSessionHistory('session-a')

    assert.deepEqual(store.getDraftAttachments('session-a'), [])
    assert.equal(store.getDraftAttachments('session-b').length, 1)
})

test('oversized attachment drafts skip disk but stay in memory', async () => {
    const store = await createStore()
    const { INPUT_DRAFT_ATTACHMENTS_MAX_LENGTH } = await import('../src/stores/inputHistory.ts')
    const bigDataUrl = `data:image/png;base64,${'A'.repeat(INPUT_DRAFT_ATTACHMENTS_MAX_LENGTH)}`

    store.setDraftAttachments('session-a', [att()])
    store.setDraftAttachments('session-a', [att({ name: 'big.png', dataUrl: bigDataUrl })])

    // 内存保留：切会话可从 store 恢复（仅刷新后丢）
    assert.equal(store.getDraftAttachments('session-a').length, 1)
    assert.equal(store.getDraftAttachments('session-a')[0].name, 'big.png')
    // 不落盘：残留的旧条目也从存储里排除
    assert.equal(storage.getItem('seedcode_input_draft_attachments'), null)

    // 其他会话正常落盘，超限会话持续被排除
    store.setDraftAttachments('session-b', [att({ name: 'b.png' })])
    assert.deepEqual(Object.keys(JSON.parse(storage.getItem('seedcode_input_draft_attachments')!)), ['session-b'])

    // 重复写入同一份超限草稿：去重早退，不得把超限条目写进存储
    store.setDraftAttachments('session-a', [att({ name: 'big.png', dataUrl: bigDataUrl })])
    assert.deepEqual(Object.keys(JSON.parse(storage.getItem('seedcode_input_draft_attachments')!)), ['session-b'])
})

test('total budget eviction drops the oldest session from disk, memory retained', async () => {
    const store = await createStore()

    const mid = (name: string) => [att({ name, dataUrl: `data:image/png;base64,${'A'.repeat(1_500_000)}` })]
    store.setDraftAttachments('session-a', mid('a.png'))
    store.setDraftAttachments('session-b', mid('b.png'))
    store.setDraftAttachments('session-c', mid('c.png'))

    // a+b+c ≈ 4.5MB > 4MB 总预算 → 最早写入的 session-a 从落盘淘汰，内存保留
    const stored = JSON.parse(storage.getItem('seedcode_input_draft_attachments')!)
    assert.deepEqual(Object.keys(stored).sort(), ['session-b', 'session-c'])
    assert.equal(store.getDraftAttachments('session-a').length, 1)

    // 后续写入其它会话时，被淘汰的 session-a 不会被重新写回
    store.setDraftAttachments('session-b', mid('b2.png'))
    assert.deepEqual(
        Object.keys(JSON.parse(storage.getItem('seedcode_input_draft_attachments')!)).sort(),
        ['session-b', 'session-c'],
    )
})

test('identical attachment writes are deduped and do not rewrite storage', async () => {
    const store = await createStore()

    store.setDraftAttachments('session-a', [att()])
    const persisted = storage.getItem('seedcode_input_draft_attachments')
    assert.ok(persisted)

    let setItemCalls = 0
    const originalSetItem = storage.setItem.bind(storage)
    storage.setItem = (key: string, value: string) => {
        setItemCalls++
        return originalSetItem(key, value)
    }
    try {
        store.setDraftAttachments('session-a', [att()])
        assert.equal(setItemCalls, 0)
    } finally {
        storage.setItem = originalSetItem
    }

    assert.equal(storage.getItem('seedcode_input_draft_attachments'), persisted)
})

test('entries without dataUrl or content are dropped at write time (aligned with load)', async () => {
    const store = await createStore()

    store.setDraftAttachments('session-a', [
        att({ name: 'empty.txt', mimeType: 'text/plain', dataUrl: '', content: '' }),
    ])

    assert.equal(storage.getItem('seedcode_input_draft_attachments'), null)
})

test('clearAll clears draft attachments as well', async () => {
    const store = await createStore()

    store.setDraftAttachments('session-a', [att()])
    store.clearAll()

    assert.deepEqual(store.getDraftAttachments('session-a'), [])
    assert.equal(storage.getItem('seedcode_input_draft_attachments'), null)
})
