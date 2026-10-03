/**
 * SSE Streaming Client for SeedAgent Chat API
 * 
 * Uses fetch() + ReadableStream to parse SSE from POST /api/chat/:sessionId/chat
 * 
 * SSE Events:
 * - message_start
 * - text_delta -> { delta: string }
 * - thinking_delta -> { delta: string }
 * - tool_start -> { toolName: string }
 * - tool_update -> { partialResult: any }
 * - tool_end -> { toolName: string, isError: boolean }
 * - message_end
 * - turn_end
 * - agent_settled (0.80.6: 重试/压缩/continuation 全部完成后触发)
 * - done -> { message: string }
 */

import { getApiUrl, getAuthToken } from './api-client'

// ==================== Types ====================

export interface SSEEvent {
    event: string
    data: any
}

export interface SSEConnection {
    /** Abort the SSE connection */
    abort: () => void
    /** Promise that resolves when the stream is complete */
    done: Promise<void>
}

export type SSEEventHandler = (event: SSEEvent) => void

// ==================== SSE Client ====================

/** POST /api/chat/:sessionId/chat 请求体 */
export interface ChatPromptBody {
    prompt: string
    images?: string[]
    provider?: string
    model?: string
    thinkingLevel?: string
}

/**
 * Start an SSE streaming chat session
 */
export function startChatSSE(
    sessionId: string,
    body: ChatPromptBody,
    onEvent: SSEEventHandler,
    onError?: (error: Error) => void
): SSEConnection {
    const controller = new AbortController()

    const url = getApiUrl(`/api/chat/${sessionId}/chat`)
    const token = getAuthToken()

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
    }
    if (token) {
        headers['Authorization'] = `Bearer ${token}`
    }

    const done = fetchSSE(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
    }, onEvent, onError)

    return {
        abort: () => controller.abort(),
        done,
    }
}

/**
 * Attach to a session SSE stream (without sending a prompt).
 *
 * 服务端语义：
 * - 流中：message_state -> ...events -> done
 * - 非流：message_state -> done
 */
export function attachSessionSSE(
    sessionId: string,
    onEvent: SSEEventHandler,
    onError?: (error: Error) => void,
    options?: { afterEntryId?: string }
): SSEConnection {
    const controller = new AbortController()

    const url = getApiUrl(`/api/chat/${sessionId}/attach${options?.afterEntryId ? `?afterEntryId=${encodeURIComponent(options.afterEntryId)}` : ''}`)
    const token = getAuthToken()

    const headers: Record<string, string> = {
        'Accept': 'text/event-stream',
    }
    if (token) {
        headers['Authorization'] = `Bearer ${token}`
    }

    const done = fetchSSE(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
    }, onEvent, onError)

    return {
        abort: () => controller.abort(),
        done,
    }
}

/** POST SSE 公共骨架（/retry 与 /edit 逐字同构，仅 URL 与 body 不同）：
 * 支持重写类操作的统一入口，两个导出名保留为薄别名（调用点不变）。
 * onOpen：response.ok 时（首字节前）回调——/retry /edit 的 handler 先 navigate 再
 * return Response，headers 到达即蕴含导航已提交，重写流用它提前锁定「不回滚」。 */
function startPostSSE(
    path: string,
    body: Record<string, unknown>,
    onEvent: SSEEventHandler,
    onError?: (error: Error) => void,
    onOpen?: () => void,
): SSEConnection {
    const controller = new AbortController()

    const url = getApiUrl(path)
    const token = getAuthToken()

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
    }
    if (token) {
        headers['Authorization'] = `Bearer ${token}`
    }

    const done = fetchSSE(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
    }, onEvent, onError, onOpen)

    return {
        abort: () => controller.abort(),
        done,
    }
}

/**
 * Start retry SSE stream — POSTs to /retry with { entryId }, streams new response
 */
export function startRetrySSE(
    sessionId: string,
    body: { entryId: string },
    onEvent: SSEEventHandler,
    onError?: (error: Error) => void,
    onOpen?: () => void,
): SSEConnection {
    return startPostSSE(`/api/chat/${sessionId}/retry`, body, onEvent, onError, onOpen)
}

/**
 * Start edit SSE stream — POSTs to /edit with { entryId, newText }, streams new response
 */
export function startEditSSE(
    sessionId: string,
    body: { entryId: string; newText: string },
    onEvent: SSEEventHandler,
    onError?: (error: Error) => void,
    onOpen?: () => void,
): SSEConnection {
    return startPostSSE(`/api/chat/${sessionId}/edit`, body, onEvent, onError, onOpen)
}

// ==================== Internal SSE Parser ====================

async function fetchSSE(
    url: string,
    init: RequestInit,
    onEvent: SSEEventHandler,
    onError?: (error: Error) => void,
    onOpen?: () => void,
): Promise<void> {
    try {
        const response = await fetch(url, init)

        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}`
            try {
                const text = await response.text()
                const parsed = JSON.parse(text)
                // 服务端 fail() 信封是 { ok:false, error }（response.ts），无 message 字段；
                // 只读 message 会让 busy 409 / entry 404 的真实原因被吞，用户只见 "HTTP 409"
                const detail = parsed?.message ?? parsed?.error
                if (detail) errorMessage = String(detail)
            } catch {
                // ignore
            }
            throw new Error(errorMessage)
        }

        // 响应头已到且状态 2xx：对重写类端点，服务端 handler 已完成流前状态变更
        //（/retry /edit 的 navigate 先于 return Response）——此刻起失败不再回滚乐观更新。
        // 置于 body-null 检查之前：2xx 已蕴含导航提交，body 异常不该把客户端带回旧分支
        onOpen?.()

        if (!response.body) {
            throw new Error('Response body is null')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let currentEvent = ''
        let currentData = ''

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            // Process complete lines
            const lines = buffer.split('\n')
            // Keep the last incomplete line in buffer
            buffer = lines.pop() || ''

            for (const line of lines) {
                const trimmed = line.trim()

                if (trimmed === '') {
                    // Empty line = dispatch event
                    if (currentEvent || currentData) {
                        try {
                            let parsedData: any = currentData
                            try {
                                parsedData = JSON.parse(currentData)
                            } catch {
                                // keep as string
                            }
                            onEvent({
                                event: currentEvent || 'message',
                                data: parsedData,
                            })
                        } catch (e) {
                            console.error('[SSE] Event handler error:', e)
                        }
                        currentEvent = ''
                        currentData = ''
                    }
                } else if (trimmed.startsWith('event:')) {
                    currentEvent = trimmed.slice(6).trim()
                } else if (trimmed.startsWith('data:')) {
                    const dataContent = trimmed.slice(5).trim()
                    currentData = currentData ? currentData + '\n' + dataContent : dataContent
                } else if (trimmed.startsWith(':')) {
                    // Comment, ignore
                }
            }
        }

        // Process any remaining data in buffer
        if (currentEvent || currentData) {
            try {
                let parsedData: any = currentData
                try {
                    parsedData = JSON.parse(currentData)
                } catch {
                    // keep as string
                }
                onEvent({
                    event: currentEvent || 'message',
                    data: parsedData,
                })
            } catch (e) {
                console.error('[SSE] Final event handler error:', e)
            }
        }
    } catch (error: any) {
        if (error?.name === 'AbortError') {
            // Normal abort, not an error
            return
        }
        console.error('[SSE] Connection error:', error)
        onError?.(error instanceof Error ? error : new Error(String(error)))
    }
}
