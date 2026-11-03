// src/utils/subagentReport.ts
// 后台子代理报告的文本契约（两仓）：seedagent extensions/subagents/background.ts
// buildReportText 产出 `[bg-subagent-report] name=<name> status=<completed|error>\n<答案>`
// 的 user input 回传主会话；本模块纯函数解析该格式，供展示层（useChatMessages）
// 识别为专属回执气泡。改名/改格式须两仓同步。

/** 报告头正则：前缀 + name（无空白）+ status（completed|error）+ 换行 + 答案全文。 */
const SUBAGENT_REPORT_RE = /^\[bg-subagent-report\]\s+name=(\S+)\s+status=(completed|error)\r?\n([\s\S]*)$/

/** user 消息文本提取（string 直取；parts 数组拼 text 块；其余形状 null）。 */
export function extractMessageText(content: unknown): string | null {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        const text = content
            .flatMap((part: { type?: string; text?: string }) => (part?.type === 'text' ? [part.text ?? ''] : []))
            .join('')
        return text.length > 0 ? text : null
    }
    return null
}

/** 解析后台子代理报告文本；非报告格式返回 null。 */
export function parseSubagentReport(text: string): { name: string; status: 'completed' | 'error'; body: string } | null {
    const m = SUBAGENT_REPORT_RE.exec(text)
    if (!m) return null
    return { name: m[1]!, status: m[2] as 'completed' | 'error', body: m[3]! }
}
