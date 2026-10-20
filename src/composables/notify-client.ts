/**
 * WebSocket Notify Client (Browser Implementation)
 *
 * Connects to the server's WebSocket endpoint using standard Browser WebSocket API.
 */
import { useUiSettingsStore } from '../stores/setting'

// ==================== Types ====================

// Re-export specific types if needed, but mainly we deal with raw objects here
// and let the consumer validate.
import type { WsMessage } from './notify-server-connection'

type MessageCallback = (msg: WsMessage) => void
type StatusCallback = (connected: boolean) => void

// ==================== State ====================

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let isManualClose = false
let onMessageFn: MessageCallback | null = null
let onStatusFn: StatusCallback | null = null

const RECONNECT_DELAY = 5000 // 5 seconds

// ==================== Helpers ====================

/**
 * Convert HTTP base URL to WebSocket URL
 * e.g. http://localhost:3000 → ws://localhost:3000/ws
 *      https://example.com   → wss://example.com/ws
 */
export function getWsUrl(): string {
    const settings = useUiSettingsStore()
    const baseUrl = settings.apiBaseUrl?.trim().replace(/\/+$/, '')
    if (!baseUrl) return ''

    const wsUrl = baseUrl
        .replace(/^https:\/\//, 'wss://')
        .replace(/^http:\/\//, 'ws://')

    return `${wsUrl}/ws`
}

// ==================== Core ====================

function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (onMessageFn && onStatusFn) {
            connectBrowserWs(onMessageFn, onStatusFn)
        }
    }, RECONNECT_DELAY)
}

export function connectBrowserWs(onMessage: MessageCallback, onStatus?: StatusCallback) {
    // Clean up previous connection
    disconnectBrowserWs()
    isManualClose = false
    onMessageFn = onMessage
    if (onStatus) onStatusFn = onStatus

    const wsUrl = getWsUrl()
    if (!wsUrl) {
        console.warn('[notify-client] No API base URL configured, skipping WS connection.')
        return
    }

    const settings = useUiSettingsStore()
    const token = settings.token?.trim()

    // Browser WebSocket does not support custom headers.
    // Pass token as a query parameter instead.
    const urlWithAuth = token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl

    console.log(`[notify-client] Connecting to ${wsUrl}...`)

    try {
        ws = new WebSocket(urlWithAuth)
    } catch (err) {
        console.error('[notify-client] Failed to create WebSocket:', err)
        scheduleReconnect()
        return
    }

    ws.onopen = () => {
        console.log('[notify-client] Connected! Listening for events...')
        if (onStatusFn) onStatusFn(true)
    }

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data)
            if (onMessageFn) onMessageFn(message)
        } catch (err) {
            console.error('[notify-client] Failed to parse message:', err)
        }
    }

    ws.onclose = (event) => {
        console.log(`[notify-client] Disconnected. Code: ${event.code}, Reason: ${event.reason}`)
        ws = null
        if (onStatusFn) onStatusFn(false)

        // Auth failure — don't reconnect
        if (event.code === 4401 || event.reason?.includes('Unauthorized')) {
            console.error('[notify-client] Authentication failed. Stopping reconnect.')
            return
        }

        // Auto-reconnect unless manually closed
        if (!isManualClose) {
            scheduleReconnect()
        }
    }

    ws.onerror = (event) => {
        console.error('[notify-client] WebSocket error:', event)
    }
}

export function disconnectBrowserWs() {
    isManualClose = true
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }
    if (ws) {
        ws.close()
        ws = null
    }
}

