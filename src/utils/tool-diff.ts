/**
 * write/edit 工具卡 diff 视图的纯函数集（ToolDiffView.vue 的数据源）。
 *
 * 设计：纯客户端自算，不依赖服务端 details——数据全部来自工具 args：
 * - write：args.content（writeSchema：{ path, content }）→ 整文件即新增，全部渲染为
 *   add 行（行号 1..N）。
 * - edit：args.edits[] 的 oldText→newText（服务端会自动修复的三种畸形形状在此对齐
 *   兼容：edits 为 JSON 字符串 / 单对象 / 顶层 oldText+newText 旧格式）→ 行级 LCS
 *   diff。客户端没有原文件，拿不到真实行号 → lineNo 恒为 null（行号列留空）。
 *
 * args 不可解析时（仅流式拼接期间）由调用方回退现有 JSON 显示。
 */

/** 单行 diff：type 染色用，lineNo 显示用行号（客户端自算时为 null），text 行内容 */
export interface DiffLine {
    type: 'add' | 'del' | 'ctx' | 'fold'
    lineNo: number | null
    text: string
}

/**
 * 从 write 工具 args 提取 content：args 为对象直接取；为字符串（流式拼接中的
 * 原始 JSON 串，与 tool-file-paths.extractArgsPaths 同规则）时像对象就 JSON.parse。
 * content 缺失/非字符串/解析失败返回 null（调用方回退 JSON 显示）；
 * 空 content 合法（清空文件场景），返回空串。
 */
export function extractWriteContent(args: unknown): string | null {
    let a = args
    if (typeof a === 'string') {
        const s = a.trim()
        if (!s.startsWith('{')) return null
        try {
            a = JSON.parse(s)
        } catch {
            return null
        }
    }
    if (!a || typeof a !== 'object') return null
    const content = (a as Record<string, unknown>).content
    return typeof content === 'string' ? content : null
}

/** write 内容 → 全部 add 行（行号 1..N；split('\n') 自然语义：空串为一行空行） */
export function toAddDiffLines(content: string): DiffLine[] {
    return content.split('\n').map((text, i) => ({ type: 'add' as const, lineNo: i + 1, text }))
}

function isValidEdit(e: unknown): e is { oldText: string; newText: string } {
    return !!e && typeof e === 'object'
        && typeof (e as Record<string, unknown>).oldText === 'string'
        && typeof (e as Record<string, unknown>).newText === 'string'
}

/**
 * edit 工具 args → edits 数组。兼容模型实际会发/历史消息里存在的四种形状
 * （对齐 pi-durable edit.js prepareEditArguments 的服务端修复逻辑）：
 * - { edits: [{ oldText, newText }, ...] }（标准 schema）
 * - { edits: '{ "oldText": ... }' }（edits 为 JSON 字符串）
 * - { edits: { oldText, newText } }（edits 为单个编辑对象）
 * - { oldText, newText }（顶层旧格式）
 * 提取不出任何有效 edit 返回 null（调用方回退 JSON 显示）。
 */
export function extractEdits(args: unknown): { oldText: string; newText: string }[] | null {
    let a = args
    if (typeof a === 'string') {
        const s = a.trim()
        if (!s.startsWith('{')) return null
        try {
            a = JSON.parse(s)
        } catch {
            return null
        }
    }
    if (!a || typeof a !== 'object') return null
    const o = a as Record<string, unknown>
    let edits: unknown = o.edits
    if (typeof edits === 'string') {
        const s = edits.trim()
        try {
            edits = JSON.parse(s)
        } catch {
            return null
        }
    }
    if (isValidEdit(edits)) edits = [edits]
    if (Array.isArray(edits)) {
        const out = edits.filter(isValidEdit)
        return out.length > 0 ? out : null
    }
    // 顶层 oldText/newText 旧格式
    if (isValidEdit(o)) return [{ oldText: o.oldText, newText: o.newText }]
    return null
}

/**
 * 两段文本的行级 LCS diff（客户端自算 edit 增删的核心）：相同行 ctx、仅删行 del、
 * 仅增行 add，顺序即阅读顺序。行号未知（无原文件）→ 恒为 null。
 * LCS DP 表 O(n*m)：oldText/newText 是定点替换片段（服务端要求 oldText 唯一匹配、
 * 不含大段未变内容），正常都是小体量；体量超限（>1e6 格）退化为整块 del+add，不失真。
 */
export function lineDiff(before: string, after: string): DiffLine[] {
    const a = before.split('\n')
    const b = after.split('\n')
    const n = a.length
    const m = b.length

    // 超大保护：DP 表格数超限放弃对齐，整块 del+add（结果仍正确，只是少了 ctx 行）
    if (n * m > 1_000_000) {
        return [
            ...a.map(text => ({ type: 'del' as const, lineNo: null, text })),
            ...b.map(text => ({ type: 'add' as const, lineNo: null, text })),
        ]
    }

    // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
        }
    }

    const out: DiffLine[] = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({ type: 'ctx', lineNo: null, text: a[i] })
            i++
            j++
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            out.push({ type: 'del', lineNo: null, text: a[i] })
            i++
        } else {
            out.push({ type: 'add', lineNo: null, text: b[j] })
            j++
        }
    }
    while (i < n) out.push({ type: 'del', lineNo: null, text: a[i++] })
    while (j < m) out.push({ type: 'add', lineNo: null, text: b[j++] })
    return out
}

/**
 * edit 多处替换 → 展开的 diff 行：逐 edit 自算行级 diff，多个 edit 之间以 fold 行
 * （...）分隔，示意两处修改之间隔着未展示的文件内容。
 */
export function diffEdits(edits: ReadonlyArray<{ oldText: string; newText: string }>): DiffLine[] {
    const out: DiffLine[] = []
    for (const [idx, e] of edits.entries()) {
        if (idx > 0) out.push({ type: 'fold', lineNo: null, text: '...' })
        out.push(...lineDiff(e.oldText, e.newText))
    }
    return out
}
