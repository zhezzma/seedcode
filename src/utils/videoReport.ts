// src/utils/videoReport.ts
// 视频生成后台任务回执的文本契约（两仓）：seedagent extensions/video-gen/video-task.ts
// injectVideoReport 产出 `[视频生成完成] …\n[🎬 播放](url)` / `[视频生成失败] 原因：…（taskId: …）`
// 的 user input 回传主会话；本模块纯函数解析该格式，供展示层（useChatMessages）
// 识别为专属回执气泡。改名/改格式须两仓同步。

/** 完成回执：前缀 + 署名与描述（caption 可多行）+ 播放链接行（Markdown）。 */
const VIDEO_DONE_RE = /^\[视频生成完成\]\s*([\s\S]*?)\r?\n\[🎬 播放\]\((\S+)\)$/

/** 失败回执：前缀 + 原因文本（含尾随 taskId 括注）。 */
const VIDEO_FAIL_RE = /^\[视频生成失败\]\s*原因：([\s\S]*?)（taskId:\s*(\S+?)）$/

export interface ParsedVideoReport {
    status: 'completed' | 'error'
    /** 完成：署名行（"{model} 已生成：{caption}"）；失败：原因全文。 */
    text: string
    /** 完成：视频播放地址（/assets/...）。 */
    url?: string
    /** 失败：上游 taskId（排查锚点）。 */
    taskId?: string
}

/** 解析视频生成回执文本；非回执格式返回 null（音乐回执前缀不同不会命中）。 */
export function parseVideoReport(content: string): ParsedVideoReport | null {
    const done = VIDEO_DONE_RE.exec(content)
    if (done) {
        return { status: 'completed', text: done[1]!, url: done[2]! }
    }
    const fail = VIDEO_FAIL_RE.exec(content)
    if (fail) {
        return { status: 'error', text: fail[1]!, taskId: fail[2]! }
    }
    return null
}
