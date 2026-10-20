/**
 * 显示列表尾锚计算：跳过「排队态」（pending）气泡——busy 期间发出的 steer/follow-up
 * 会追加在显示列表末尾（useChatMessages 的 processedMessages），但它们**还没进对话流**
 * （要等 run 边界才被消费）。
 *
 * 为什么必须跳过：尾锚决定两件事——
 * (1) 虚拟列表「始终保持渲染」的键（流式输出/加载指示器所在的真实尾部）；
 * (2) 尾部 assistant 气泡上的 A2UI 面板交互门控（MessageBubble 的
 *     `:disabled="!isLastMessage"` → A2UIRenderer 在面板上盖 pointer-events 遮罩）。
 * 拿排队气泡当尾锚，会让正等用户作答的面板（mcp-elicitation-render / permission-render
 * 等）不可点；而排队消息要等 run 边界才被消费，run 又卡在等这一张表单上 → 死锁，
 * 唯一出口是「停止回合」。加载指示器同理该留在真正的对话尾部。
 *
 * 兜底：找不到非排队项（极端：列表里全是排队气泡）时退回原语义（末项）。
 */

/** 最小消息形状：只有 pending 标识参与判定（DisplayMessage / 其它列表项均满足） */
export interface DisplayTailMessageLike {
    pending?: unknown
}

export const computeDisplayTailIndex = (messages: DisplayTailMessageLike[]): number => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (!messages[i]!.pending) return i
    }
    return messages.length - 1
}