/** 聊天媒体全局单播（两处消费共享：MarkdownRenderer 内嵌播放器 + 音乐回执卡音频）。
 *  新播放暂停其他所有聊天媒体——选择器单点集中，防两处各自维护漂移；document
 *  作用域跨实例互斥（主聊天、引用预览等），聊天外音频（语音聊天/TTS 等）不在
 *  选择器内不受影响。全局单播是预期 UX。 */
export const CHAT_MEDIA_SELECTOR = '.markdown-body audio, .markdown-body video, audio[data-music-audio]'

/** 暂停除 except 外所有正在播放的聊天媒体（全局单播的「新播放」侧调用）。 */
export function pauseOtherChatMedia(except: HTMLMediaElement): void {
    document.querySelectorAll<HTMLMediaElement>(CHAT_MEDIA_SELECTOR).forEach(el => {
        if (el !== except && !el.paused) el.pause()
    })
}
