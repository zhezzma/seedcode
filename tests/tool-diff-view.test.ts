// node:test 风格（纯函数 + 源码 wiring 断言），纳入 `node --test` 回归基线。
// 覆盖 write/edit 工具卡 diff 视图的数据链路（纯客户端自算，不依赖服务端 details）：
// - extractWriteContent：write 工具 args（对象或流式拼接中的 JSON 串）提取 content
// - toAddDiffLines：write 内容 → 全部新增行（全绿 + 行号 1..N）
// - extractEdits：edit 工具 args 兼容四种形状（对齐 pi-durable prepareEditArguments 修复逻辑）
// - lineDiff / diffEdits：oldText→newText 客户端行级 LCS diff（无服务端 details.diff 时唯一的 diff 来源）
// - ToolInvocation.vue 接线断言（纯函数测过但忘了接线 = 白测）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    diffEdits,
    extractEdits,
    extractWriteContent,
    lineDiff,
    toAddDiffLines,
    type DiffLine,
} from '../src/utils/tool-diff.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

// ─── extractWriteContent：write args 提取 content ─────────────────────────

test('extractWriteContent: 对象 args 直接取 content', () => {
    assert.equal(extractWriteContent({ path: 'a.txt', content: 'hello' }), 'hello')
})

test('extractWriteContent: string args（流式拼接中的 JSON 串）解析后取 content', () => {
    assert.equal(extractWriteContent('{"path":"a.txt","content":"x"}'), 'x')
    assert.equal(extractWriteContent('  {"content":"x"}  '), 'x', '首尾空白容忍')
})

test('extractWriteContent: 非法 JSON 串 / 非 JSON 串返回 null', () => {
    assert.equal(extractWriteContent('{"content":"x'), null, '流式未拼完')
    assert.equal(extractWriteContent('plain text'), null)
})

test('extractWriteContent: 无 content / content 非字符串 / 空输入返回 null', () => {
    assert.equal(extractWriteContent({ path: 'a.txt' }), null)
    assert.equal(extractWriteContent({ content: 123 }), null)
    assert.equal(extractWriteContent(null), null)
    assert.equal(extractWriteContent(undefined), null)
})

test('extractWriteContent: 空 content 合法（清空文件场景），返回空串而非 null', () => {
    assert.equal(extractWriteContent({ content: '' }), '')
})

// ─── toAddDiffLines：write 内容 → 全部新增行 ─────────────────────────

test('toAddDiffLines: 多行内容 → 全 add，行号 1..N', () => {
    assert.deepEqual<DiffLine[]>(toAddDiffLines('a\nb\nc'), [
        { type: 'add', lineNo: 1, text: 'a' },
        { type: 'add', lineNo: 2, text: 'b' },
        { type: 'add', lineNo: 3, text: 'c' },
    ])
})

test('toAddDiffLines: 空内容 → 单个空 add 行（与 split("\\n") 行为一致）', () => {
    assert.deepEqual<DiffLine[]>(toAddDiffLines(''), [{ type: 'add', lineNo: 1, text: '' }])
})

test('toAddDiffLines: 内容中的空行保留为空 add 行', () => {
    assert.deepEqual<DiffLine[]>(toAddDiffLines('a\n\nb'), [
        { type: 'add', lineNo: 1, text: 'a' },
        { type: 'add', lineNo: 2, text: '' },
        { type: 'add', lineNo: 3, text: 'b' },
    ])
})

// ─── extractEdits：edit args 兼容四种形状（对齐服务端 prepareEditArguments 修复逻辑） ─────────────────────────

test('extractEdits: edits 数组 / 单对象 / JSON 字符串 / 顶层 oldText+newText 均可提取', () => {
    const edits = [{ oldText: 'a', newText: 'b' }]
    assert.deepEqual(extractEdits({ path: 'f', edits }), edits, '标准 edits 数组')
    assert.deepEqual(extractEdits({ edits: edits[0] }), edits, 'edits 为单对象')
    assert.deepEqual(extractEdits({ edits: JSON.stringify(edits) }), edits, 'edits 为 JSON 字符串')
    assert.deepEqual(extractEdits({ oldText: 'a', newText: 'b' }), edits, '顶层旧格式')
})

test('extractEdits: 多组 edits 保序', () => {
    const edits = [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }]
    assert.deepEqual(extractEdits({ edits }), edits)
})

test('extractEdits: 无有效 edits 返回 null', () => {
    assert.equal(extractEdits({ path: 'f' }), null)
    assert.equal(extractEdits({ edits: [] }), null)
    assert.equal(extractEdits({ edits: 'broken' }), null)
    assert.equal(extractEdits({ edits: '{broken' }), null)
    assert.equal(extractEdits({ edits: [{ oldText: 'a' }] }), null, '缺 newText 的条目剔除')
    assert.equal(extractEdits(null), null)
})

// ─── lineDiff：客户端自算行级 diff（oldText→newText，LCS 对齐） ─────────────────────────

test('lineDiff: 相同行 ctx，删除 del，新增 add，顺序正确', () => {
    assert.deepEqual<DiffLine[]>(lineDiff('keep\nold\nkeep2', 'keep\nnew\nkeep2\nextra'), [
        { type: 'ctx', lineNo: null, text: 'keep' },
        { type: 'del', lineNo: null, text: 'old' },
        { type: 'add', lineNo: null, text: 'new' },
        { type: 'ctx', lineNo: null, text: 'keep2' },
        { type: 'add', lineNo: null, text: 'extra' },
    ])
})

test('lineDiff: 空串按单空行处理（split 自然语义）', () => {
    assert.deepEqual<DiffLine[]>(lineDiff('', 'a'), [
        { type: 'del', lineNo: null, text: '' },
        { type: 'add', lineNo: null, text: 'a' },
    ])
})

test('lineDiff: 无差异全部 ctx', () => {
    assert.deepEqual<DiffLine[]>(lineDiff('x\ny', 'x\ny'), [
        { type: 'ctx', lineNo: null, text: 'x' },
        { type: 'ctx', lineNo: null, text: 'y' },
    ])
})

test('diffEdits: 多处替换逐块展开，块间 fold 分隔，行号均为 null（客户端无原文件行号）', () => {
    const lines = diffEdits([
        { oldText: 'a\nb', newText: 'a\nB' },
        { oldText: 'x', newText: 'y' },
    ])
    // 块1：a 上下文、b→B 增删；fold 分隔；块2：x→y
    assert.deepEqual<DiffLine[]>(lines, [
        { type: 'ctx', lineNo: null, text: 'a' },
        { type: 'del', lineNo: null, text: 'b' },
        { type: 'add', lineNo: null, text: 'B' },
        { type: 'fold', lineNo: null, text: '...' },
        { type: 'del', lineNo: null, text: 'x' },
        { type: 'add', lineNo: null, text: 'y' },
    ])
    assert.ok(lines.every(l => l.lineNo === null), '自算 diff 无真实文件行号')
})

// ─── ToolInvocation.vue 接线（忘接线 = 纯函数白测） ─────────────────────────

const toolInvocationSource = readFileSync(
    path.join(repoRoot, 'src/components/chat/ToolInvocation.vue'), 'utf8')

test('ToolInvocation: 从 utils/tool-diff 导入四个纯函数', () => {
    for (const fn of ['extractWriteContent', 'toAddDiffLines', 'extractEdits', 'diffEdits']) {
        assert.match(toolInvocationSource,
            new RegExp(`import \\{[^}]*${fn}[^}]*\\} from '[^']*utils/tool-diff(?:\\.ts)?'`),
            `应导入 ${fn}`)
    }
})

test('ToolInvocation: write 链路 extractWriteContent(props.args) + toAddDiffLines', () => {
    assert.match(toolInvocationSource, /extractWriteContent\(\s*props\.args\s*\)/,
        'write 应从 props.args 提取 content')
})

test('ToolInvocation: edit 链路 extractEdits(props.args) + diffEdits（纯客户端自算）', () => {
    assert.match(toolInvocationSource, /extractEdits\(\s*props\.args\s*\)/,
        'edit 应从 props.args 提取 edits（不依赖服务端 details）')
    assert.ok(!toolInvocationSource.includes('parseServerDiff'),
        '不应存在 details.diff 解析链路（纯自算方案）')
    assert.match(toolInvocationSource, /<ToolDiffView\b/,
        '模板应引用 ToolDiffView 组件')
})

test('ToolInvocation: 保留 formatJson(args) 回退分支（仅流式 args 未拼完时兜底）', () => {
    assert.match(toolInvocationSource, /formatJson\(args\)/,
        'args 不可解析（流式未拼完）应回退现有 JSON 显示')
})

test('ToolDiffView 组件文件存在', () => {
    const comp = path.join(repoRoot, 'src/components/chat/ToolDiffView.vue')
    assert.ok(readFileSync(comp, 'utf8').includes('<script'), 'ToolDiffView.vue 应存在')
})
