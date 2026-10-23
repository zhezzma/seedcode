// src/composables/useReplySuggestion.ts
// 回复预测（reply-prediction 扩展）的数据源：ext.reply_suggestion 事件驱动的
// 输入框 ghost text 建议（Claude Code Prompt Suggestions 风格）。
//
// 两条到达线（与 ext.goal_state 同构，零轮询）：
// - 推送线：run_end 后服务端预测完成（run-end-work 排空内）emitExtensionEvent
//   实时扇出 → useChatState 转发 → extension-events 总线；
// - 快照线：attach/刷新/切会话时 attach 流携带服务端内存缓存的现态建议
//   （TTL ~5 分钟，过期不投）。
//
// 事件名契约（两仓同步）：'ext.reply_suggestion' 与 seedagent
// extensions/reply-prediction/predictor.ts 的 REPLY_SUGGESTION_EVENT 同值，
// 改名须两仓同步，否则 ghost 静默失效。
//
// 消费方：ChatInput.vue——placeholder 位换装灰字（textarea 现成
// placeholder:text-base-content/40）、Tab 填入、sparkles 填入按钮。
import { effectScope, ref, watch } from 'vue'
import { onExtensionEvent } from './extension-events'
import { useChatState } from './useChatState'
import { useChatInput } from './useChatInput'

function isReplySuggestionPayload(data: unknown): data is { text: string } {
    if (typeof data !== 'object' || data === null) return false
    const text = (data as { text?: unknown }).text
    return typeof text === 'string' && text.length > 0
}

function buildReplySuggestion() {
    const chatState = useChatState()
    const { inputText } = useChatInput()

    // 建议 ref：两条到达线统一写入口（归属校验拒绝非当前会话的事件）
    const suggestion = ref<string | null>(null)

    // 推送线 + 快照线：ext.reply_suggestion → 建议 ref。
    // key = 事件所在会话流（attach/run 流都按会话绑定）；非当前会话的事件不应用
    // （key 缺失的孤儿事件同样丢弃——useChatState 转发层已保证带 key）。
    onExtensionEvent('ext.reply_suggestion', (data, key) => {
        if (!isReplySuggestionPayload(data)) return
        if (key === undefined || key !== chatState.sessionKey) return
        suggestion.value = data.text
    })

    // 清除时机（防过期）：
    // 1. 切会话——旧建议立即失效；新会话现态由 attach 快照线补充
    watch(() => chatState.sessionKey, () => {
        suggestion.value = null
    })

    // 2/3. 发出消息 / 新回合开始——busy 上升沿即用户已发出（或服务端续跑开跑），
    // 建议基于旧上下文，立即过期。与 useChatMessages.isBusy 同源表达式
    // （chatSending || chatRunId），不额外引入依赖
    watch(() => chatState.chatSending || Boolean(chatState.chatRunId), (busy) => {
        if (busy) suggestion.value = null
    })

    // 填入（Tab / sparkles 按钮共用）：填入 → 清状态。聚焦与光标到尾归
    // ChatInput（textarea ref 在其模板内）。返回是否有建议可填
    function fillSuggestion(): boolean {
        const text = suggestion.value
        if (!text) return false
        suggestion.value = null
        inputText.value = text
        return true
    }

    return { suggestion, fillSuggestion }
}

// 懒初始化单例（useGoalState 同模式；首次 ChatInput setup 时构建——pinia 到位，
// 事件订阅随首个聊天输入框挂载启动，早于挂载的事件本就无处显示）。
//
// ⚠ detached effectScope（作用域与构建时机是这个单例的两个独立决策）：
// 在组件 setup 里同步创建的 watcher 会绑到组件实例作用域，随卸载自动销毁。
// HomeView 有两个 v-if 互斥的 ChatInput（新会话页 centered 版 / 会话页底部版），
// 首个实例卸载后 watch 即死——切会话/busy 上升沿不再清空建议，A 会话的预测
// 残留显示在 B 的输入框（归属校验只拦写入，拦不住残留）。detached 作用域
// 让 watch 独立于任何组件实例存活，与模块顶层构建的 useGoalState 同寿命语义。
let _replySuggestion: ReturnType<typeof buildReplySuggestion> | null = null

export function useReplySuggestion(): ReturnType<typeof buildReplySuggestion> {
    if (!_replySuggestion) {
        const scope = effectScope(true)
        _replySuggestion = scope.run(() => buildReplySuggestion())!
    }
    return _replySuggestion
}
