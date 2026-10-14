import { reactive } from 'vue'

import { onServerMessage, sendRequest, WsMessage } from './notify-server-connection'

/**
 * MCP elicitation 交互链客户端侧（server→client 用户输入征集）。
 *
 * 参照 useExecApproval.ts 模式：收 ui_request 广播 → 入队 → 弹窗 →
 * 应答经 ui_response 回投。elicitation 的 type 为 "elicitation"，
 * 载荷含 serverId + message + requestedSchema（JSON Schema 表单定义）。
 */

export interface ElicitationRequest {
    id: string
    serverId: string
    message: string
    requestedSchema: unknown
    timeout: number
}

export interface ElicitationState {
    queue: ElicitationRequest[]
}

const state = reactive<ElicitationState>({
    queue: [],
})

function handleServerMessage(msg: WsMessage) {
    if (msg.event === 'ui_request') {
        const payload = msg.payload as Record<string, unknown>
        if (payload?.type === 'elicitation' && payload?.id) {
            // 避免重复入队
            if (!state.queue.find(req => req.id === payload.id)) {
                const data = (typeof payload.data === 'object' && payload.data !== null ? payload.data : {}) as Record<string, unknown>
                state.queue.push({
                    id: typeof payload.id === 'string' ? payload.id : String(payload.id),
                    serverId: typeof data.serverId === 'string' ? data.serverId : '',
                    message: typeof payload.message === 'string' ? payload.message : '',
                    requestedSchema: data.requestedSchema,
                    timeout: typeof payload.timeout === 'number' ? (Date.now() + payload.timeout) : (Date.now() + 300000),
                })
            }
        }
    }
}

// 全局监听（模块级，只注册一次）
onServerMessage(handleServerMessage)

/**
 * 应答一个 elicitation 请求。
 * value 为 { action: "accept"|"decline"|"cancel", content? } ——与 MCP 协议 ElicitResult 同形。
 */
const resolveRequest = async (id: string, value: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) => {
    const idx = state.queue.findIndex(req => req.id === id)
    if (idx > -1) {
        state.queue.splice(idx, 1)
    }
    return await sendRequest('ui_response', { id, value })
}

const _elicitState = Object.assign(state, { resolveRequest })

export function useElicitation() {
    return _elicitState
}
