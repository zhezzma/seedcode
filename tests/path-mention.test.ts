import test from 'node:test'
import assert from 'node:assert/strict'
import {
    parseMentionToken,
    isAbsolutePathLike,
    splitDirPrefix,
    filterMentionEntries,
    MENTION_MAX_ENTRIES,
} from '../src/utils/path-mention.ts'

// ——— parseMentionToken ———

test('parseMentionToken: 刚敲下 @（行首、光标紧随）→ 空 query', () => {
    assert.deepEqual(parseMentionToken('@', 1), { start: 0, end: 1, query: '' })
})

test('parseMentionToken: 前置文本 + @src/comp 光标在尾', () => {
    const text = '看下 @src/comp' // 长 12：看(0)下(1)' '(2)@(3)s(4)…
    assert.deepEqual(parseMentionToken(text, text.length), { start: 3, end: 12, query: 'src/comp' })
})

test('parseMentionToken: 光标在 token 中间 → 只取光标前段', () => {
    // '@sr|c'：替换区间 [0,3)，尾部 c 保留
    assert.deepEqual(parseMentionToken('@src', 3), { start: 0, end: 3, query: 'sr' })
})

test('parseMentionToken: 反斜杠归一为 /（Windows 习惯）', () => {
    assert.deepEqual(parseMentionToken('@C:\\Users', 9), { start: 0, end: 9, query: 'C:/Users' })
})

test('parseMentionToken: 空白作为 token 左边界（空格/换行）', () => {
    // 下标：a(0) ' '(1) @(2) b(3) \n(4) c(5) ' '(6) @(7) d(8)；光标 9 在 token 尾
    assert.deepEqual(parseMentionToken('a @b\nc @d', 9), { start: 7, end: 9, query: 'd' })
})

test('parseMentionToken: 不触发——邮箱式粘连 foo@bar', () => {
    assert.equal(parseMentionToken('foo@bar.com', 11), null)
})

test('parseMentionToken: 不触发——光标前是普通文本', () => {
    assert.equal(parseMentionToken('hello wor', 9), null)
})

test('parseMentionToken: 不触发——光标在 @ 之前', () => {
    assert.equal(parseMentionToken('@', 0), null)
})

test('parseMentionToken: 不触发——光标越界/负值', () => {
    assert.equal(parseMentionToken('@x', 99), null)
    assert.equal(parseMentionToken('@x', -1), null)
})

test('parseMentionToken: @ 前紧贴非空白字符（粘贴文本）不触发', () => {
    // 'x@y'：@ 不在空白边界
    assert.equal(parseMentionToken('x@y', 3), null)
})

// ——— isAbsolutePathLike ———

test('isAbsolutePathLike: / 开头或盘符带分隔符 → true', () => {
    for (const s of ['/', '/root', '/a/b.txt', 'C:/', 'C:\\', 'C:/Users', 'c:\\Users\\x']) {
        assert.ok(isAbsolutePathLike(s), s)
    }
})

test('isAbsolutePathLike: 相对路径与裸盘符 → false（与服务端校验同口径）', () => {
    for (const s of ['', 'src', 'src/main.ts', '.', 'C:', 'a:b']) {
        assert.ok(!isAbsolutePathLike(s), s)
    }
})

// ——— splitDirPrefix ———

test('splitDirPrefix: 无斜杠 → 工作区根 + 全段前缀', () => {
    assert.deepEqual(splitDirPrefix('src'), { dirPath: '', prefix: 'src' })
})

test('splitDirPrefix: 目录 + 末段', () => {
    assert.deepEqual(splitDirPrefix('src/composab'), { dirPath: 'src', prefix: 'composab' })
    assert.deepEqual(splitDirPrefix('a/b/c.rs'), { dirPath: 'a/b', prefix: 'c.rs' })
})

test('splitDirPrefix: 尾斜杠 → 空前缀（列整个目录）', () => {
    assert.deepEqual(splitDirPrefix('src/'), { dirPath: 'src', prefix: '' })
})

test('splitDirPrefix: 绝对路径形态', () => {
    assert.deepEqual(splitDirPrefix('/'), { dirPath: '', prefix: '' })
    assert.deepEqual(splitDirPrefix('/ro'), { dirPath: '', prefix: 'ro' })
    assert.deepEqual(splitDirPrefix('/root/ho'), { dirPath: '/root', prefix: 'ho' })
    assert.deepEqual(splitDirPrefix('C:/Users/Ad'), { dirPath: 'C:/Users', prefix: 'Ad' })
})

test('splitDirPrefix: 盘符根的产物是裸盘符（尾分隔符被吃掉）——useChatInput 据此补回 /', () => {
    // 服务端校验要求盘符后带分隔符，裸 'C:' 会被 400 拒；
    // 状态机的 /^[a-zA-Z]:$/ 补偿分支依赖此产物形态，锁死防漂移
    assert.deepEqual(splitDirPrefix('C:/'), { dirPath: 'C:', prefix: '' })
    assert.deepEqual(splitDirPrefix('C:/x'), { dirPath: 'C:', prefix: 'x' })
})

test('splitDirPrefix: 连续斜杠归一', () => {
    assert.deepEqual(splitDirPrefix('src//x//y'), { dirPath: 'src/x', prefix: 'y' })
})

// ——— filterMentionEntries ———

const entries = [
    { name: 'components', type: 'dir' },
    { name: 'composables', type: 'dir' },
    { name: 'chat-input.ts', type: 'file' },
    { name: 'ChatInput.vue', type: 'file' },
    { name: 'README.md', type: 'file' },
] as const

test('filterMentionEntries: 大小写不敏感前缀匹配，保持原顺序（目录优先由服务端保证）', () => {
    assert.deepEqual(
        filterMentionEntries([...entries], 'comp').map(e => e.name),
        ['components', 'composables']
    )
    assert.deepEqual(
        filterMentionEntries([...entries], 'chat').map(e => e.name),
        ['chat-input.ts', 'ChatInput.vue']
    )
})

test('filterMentionEntries: 空前缀全量返回', () => {
    assert.equal(filterMentionEntries([...entries], '').length, 5)
})

test('filterMentionEntries: 截断到 MENTION_MAX_ENTRIES（50）', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt`, type: 'file' as const }))
    assert.equal(filterMentionEntries(many, 'f').length, MENTION_MAX_ENTRIES)
    assert.equal(filterMentionEntries(many, '').length, MENTION_MAX_ENTRIES)
})
