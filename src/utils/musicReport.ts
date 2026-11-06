// src/utils/musicReport.ts
// 音乐生成后台任务回执的文本契约（两仓）：seedagent extensions/audio-gen/music-task.ts
// injectMusicReport 产出 `[音乐生成完成] …\n[🔊 播放](url)` / `[音乐生成失败] 原因：…（taskId: …）`
// 的 user input 回传主会话；本模块纯函数解析该格式，供展示层（useChatMessages）
// 识别为专属回执气泡。改名/改格式须两仓同步。

/** 完成回执：前缀 + 署名与描述（caption 可多行）+ 播放链接行（Markdown）。 */
const MUSIC_DONE_RE = /^\[音乐生成完成\]\s*([\s\S]*?)\r?\n\[🔊 播放\]\((\S+)\)$/

/** 失败回执：前缀 + 原因文本（含尾随 taskId 括注）。 */
const MUSIC_FAIL_RE = /^\[音乐生成失败\]\s*原因：([\s\S]*?)（taskId:\s*(\S+?)）$/

export interface ParsedMusicReport {
    status: 'completed' | 'error'
    /** 完成：署名行（"{label} 已生成：{caption}"）；失败：原因全文。 */
    text: string
    /** 完成：音频播放地址（/assets/...）。 */
    url?: string
    /** 失败：上游 taskId（排查锚点）。 */
    taskId?: string
}

/** 解析音乐生成回执文本；非回执格式返回 null。 */
export function parseMusicReport(content: string): ParsedMusicReport | null {
    const done = MUSIC_DONE_RE.exec(content)
    if (done) {
        return { status: 'completed', text: done[1]!, url: done[2]! }
    }
    const fail = MUSIC_FAIL_RE.exec(content)
    if (fail) {
        return { status: 'error', text: fail[1]!, taskId: fail[2]! }
    }
    return null
}
