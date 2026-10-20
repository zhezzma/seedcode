import { ref } from 'vue'
import { useUiSettingsStore } from '../stores/setting'
import { connectBrowserWs, disconnectBrowserWs, getWsUrl } from './notify-client'

// ==================== Types ====================

export interface WsMessage {
    type: string
    event?: string
    payload: any
}

type MessageHandler = (msg: WsMessage) => void

// ==================== State ====================

export const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__
const listeners: MessageHandler[] = []
export const isConnected = ref(false)
export const clientId = ref<string | null>(null)

let tauriUnlisteners: (() => void)[] = []


// ==================== Public API ====================

export function onServerMessage(handler: MessageHandler) {
    listeners.push(handler)
}

export function offServerMessage(handler: MessageHandler) {
    const index = listeners.indexOf(handler)
    if (index > -1) {
        listeners.splice(index, 1)
    }
}

export function connectServer() {
    if (isTauri) {
        initTauriConnection()
    } else {
        initBrowserConnection()
    }
}

let lastCheckTime = 0;

export function checkConnection() {
    const now = Date.now();
    // Throttle checks to once every 5 seconds to avoid spamming if focus events fire rapidly
    if (now - lastCheckTime < 5000) {
        return;
    }
    lastCheckTime = now;

    console.log('[notify-server-connection] Checking connection (force reconnect)...')
    // Always call connectServer, which handles idempotency or restarts the connection task
    connectServer()
}

export function disconnectServer() {
    if (isTauri) {
        disconnectTauriConnection()
    } else {
        disconnectBrowserWs()
    }
    isConnected.value = false
}

// ==================== Internal: Message Dispatch ====================

function dispatchMessage(msg: WsMessage) {
    if (msg.type === 'event' && msg.event === 'hello_ok') {
        clientId.value = msg.payload?.clientId || null
        isConnected.value = true
        // Fall through to notify other listeners (e.g. for logging)
    }

    listeners.forEach(handler => handler(msg))
}

// ==================== Internal: Browser Implementation ====================

function initBrowserConnection() {
    connectBrowserWs((msg) => {
        dispatchMessage(msg)
    }, (connected) => {
        if (!connected) {
            isConnected.value = false
            clientId.value = null
        }
    })
}

// ==================== Internal: Tauri Implementation ====================

async function initTauriConnection() {
    try {
        const { invoke } = await import('@tauri-apps/api/core')
        const { listen } = await import('@tauri-apps/api/event')

        // Clean up any existing listeners before creating new ones
        cleanupTauriListeners()

        const settings = useUiSettingsStore()
        const wsUrl = getWsUrl()

        if (!wsUrl) {
            console.warn('[server-connection] No API base URL configured, skipping Tauri WS connection.')
            return
        }

        const token = settings.token?.trim() || undefined
        const origin = settings.apiBaseUrl?.trim().replace(/\/+$/, '') || 'http://localhost'

        // Listen for messages from Rust
        const unlistenMessage = await listen<string>('notify://message', (event) => {
            try {
                const msg: WsMessage = JSON.parse(event.payload)
                dispatchMessage(msg)
            } catch (err) {
                console.error('[server-connection] Failed to parse Tauri message:', err)
            }
        })
        tauriUnlisteners.push(unlistenMessage)

        // Listen for connection state changes
        const unlistenState = await listen<string>('notify://connection-state', (event) => {
            if (event.payload !== 'connected') {
                isConnected.value = false
                clientId.value = null
            }
        })
        tauriUnlisteners.push(unlistenState)

        // Start connection
        await invoke('notify_connect', { url: wsUrl, token, origin })
        console.log('[server-connection] Tauri notify_connect invoked successfully')

    } catch (err) {
        console.error('[server-connection] Failed to initialize Tauri connection:', err)
    }
}

async function disconnectTauriConnection() {
    try {
        cleanupTauriListeners()
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('notify_disconnect')
    } catch (err) {
        console.error('[server-connection] Failed to disconnect Tauri connection:', err)
    }
}

function cleanupTauriListeners() {
    if (tauriUnlisteners.length > 0) {
        tauriUnlisteners.forEach(unlisten => unlisten())
        tauriUnlisteners = []
    }
}
