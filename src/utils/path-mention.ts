/**
 * 输入框 @ 路径补全的纯逻辑层：token 解析、绝对/相对判定、目录/前缀切分、条目过滤。
 *
 * 与 chat-input-key-routing.ts 同定位：不依赖 vue / store / 网络，可直接被 node:test
 * 单测；网络与键盘路由的接线在 useChatInput.ts，UI 在 ChatInput.vue。
 *
 * 语义约定（与主人约定的需求一致）：
 * - `@` 后跟相对路径 → 基于 agent 工作区（服务端 /:id/workspace/tree）；
 * - `@` 后跟绝对路径（`/` 开头或 `X:`/`X:/` 盘符）→ 真实文件系统绝对路径（/api/files/tree）；
 * - 反斜杠统一归一为 `/`（Windows 路径习惯），补全产物也一律用 `/` 分隔。
 */

export interface MentionToken {
    /** '@' 在全文中的下标（替换区间起点） */
    start: number
    /** token 结束下标（= 解析时的光标位置，替换区间终点） */
    end: number
    /** '@' 之后、光标之前的路径文本（不含 '@'，已归一为 '/' 分隔） */
    query: string
}

/** 绝对路径形态：`/` 开头，或 Windows 盘符带分隔符 `C:\` / `C:/`。
 *  与服务端 /api/files/tree 的校验同口径（盘符后必须跟分隔符）：
 *  裸 `C:` 仍按相对路径处理，直到敲出 `C:/` 才切绝对分支。 */
export function isAbsolutePathLike(s: string): boolean {
    return s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)
}

/**
 * 解析光标处的 @ token。
 *
 * 触发条件：从光标向前扫到首个空白为止得到「当前 token」，token 的首字符必须是
 * '@'（即 '@' 位于行首或空白之后）——`foo@bar`（邮箱式粘连）不触发；
 * 光标必须落在 token 内（含紧贴 token 尾部），光标在 '@' 之前不算。
 * 返回 null 表示当前没有可补全的 @ token。
 */
export function parseMentionToken(text: string, caret: number): MentionToken | null {
    if (caret < 0 || caret > text.length) return null
    // 从光标向前找 token 起点：越过所有非空白字符
    let start = caret
    while (start > 0 && !/\s/.test(text[start - 1])) start--
    // token 首字符必须是 '@'；光标恰在 '@' 前（start === caret）也不算
    if (start >= caret || text[start] !== '@') return null
    const query = text.slice(start + 1, caret).replace(/\\/g, '/')
    // 空白由扫描保证不出现；token 至少是 '@' + 空路径（刚敲下 '@'）
    return { start, end: caret, query }
}

export interface MentionDirSplit {
    /** 目录部分（相对路径可为 ''=工作区根；绝对路径为 '/' 或 'C:' 等） */
    dirPath: string
    /** 最后一段：用于过滤目录内条目名的前缀 */
    prefix: string
}

/** 把 query 切成「目录 + 末段前缀」：`src/composab` → { dirPath:'src', prefix:'composab' }；
 *  `src/` → { dirPath:'src', prefix:'' }；`/ro` → { dirPath:'/', prefix:'ro' }。
 *  连续斜杠归一（`src//x` 当作 `src/x`）。 */
export function splitDirPrefix(query: string): MentionDirSplit {
    const normalized = query.replace(/\/+/g, '/')
    const i = normalized.lastIndexOf('/')
    if (i < 0) return { dirPath: '', prefix: normalized }
    return { dirPath: normalized.slice(0, i), prefix: normalized.slice(i + 1) }
}

/** 补全面板单页最多展示的条目数（服务端已目录优先排序，这里只截断不重排） */
export const MENTION_MAX_ENTRIES = 50

export interface MentionEntryLike {
    name: string
    type: 'dir' | 'file' | 'symlink'
}

/** 按末段前缀过滤条目（大小写不敏感的 name 前缀匹配），保持服务端目录优先顺序，截断到上限。
 *  注：服务端超限目录是先按 readdir 序截断再排序，截断集有偏（>5000 条目才触发），
 *  属既有行为；这里不重排。 */
export function filterMentionEntries<T extends MentionEntryLike>(entries: T[], prefix: string): T[] {
    const lower = prefix.toLowerCase()
    return entries
        .filter(e => e.name.toLowerCase().startsWith(lower))
        .slice(0, MENTION_MAX_ENTRIES)
}
