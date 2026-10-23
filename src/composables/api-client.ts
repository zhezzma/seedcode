/**
 * SeedAgent HTTP API Client
 * 
 * Central HTTP fetch wrapper for all REST API calls.
 * Reads apiBaseUrl and token from the settings store.
 */
import { useUiSettingsStore } from '../stores/setting'
import { useToast } from './useToast'
import { i18n } from '../i18n'
import { isLocalServerBooting, waitForLocalServerReady } from './local-server'

// ==================== Types ====================

export interface ApiResponse<T = any> {
    status: 'success' | 'error'
    data?: T
    message?: string
    code?: number
}

export class ApiError extends Error {
    code: number
    constructor(message: string, code: number) {
        super(message)
        this.name = 'ApiError'
        this.code = code
    }
}

// ==================== Internal Helpers ====================

function getBaseUrl(): string {
    const settings = useUiSettingsStore()
    const url = settings.apiBaseUrl?.trim()
    if (!url) throw new ApiError('API base URL not configured', 0)
    // Remove trailing slash
    return url.replace(/\/+$/, '')
}

function getHeaders(contentType?: string): Record<string, string> {
    const settings = useUiSettingsStore()
    const headers: Record<string, string> = {}
    if (settings.token?.trim()) {
        headers['Authorization'] = `Bearer ${settings.token.trim()}`
    }
    if (contentType) {
        headers['Content-Type'] = contentType
    }
    return headers
}

// 需要静默处理的错误码（调用方自己处理）
const SILENT_CODES = new Set([409, 404])

/**
 * fetch 层兜底提示：断网/服务器不可达/CORS 等 reject 不经过 handleResponse 的全局 toast，
 * 此处统一提示后原样抛出（ApiError 类错误已按 SILENT_CODES 规则处理过，不在此列）。
 * silent=true 供轮询类调用：不弹提示，由调用方内联展示错误。
 */
async function fetchWithToast(url: string, init: RequestInit, silent = false): Promise<Response> {
    // 内置服务端启动窗口内（bundled + local + 未 Running 过）先等服务端口真正监听再发：
    // 兜住 UI 提前渲染后组件级（如 HomeView 挂载期 watcher）抢跑的请求，避免连接拒绝报错。
    // 就绪后 / 非 bundled 构建 / remote 模式：isLocalServerBooting() 恒 false，零开销直通
    if (isLocalServerBooting()) await waitForLocalServerReady()
    try {
        return await fetch(url, init)
    } catch (e) {
        if (!silent) useToast().error((i18n.global as any).t('common.networkError'), 5000)
        throw e
    }
}

async function handleResponse<T>(response: Response, silent = false): Promise<T> {
    if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`
        try {
            const body = await response.json()
            if (body?.error) errorMessage = body.error
        } catch {
            // ignore parse errors
        }
        const err = new ApiError(errorMessage, response.status)
        if (!silent && !SILENT_CODES.has(response.status)) {
            useToast().error(errorMessage, 5000)
        }
        throw err
    }
    const body = await response.json()
    if (body.status === 'error' || body.ok === false) {
        const err = new ApiError(body.error || 'Unknown error', body.code || 500)
        if (!silent) {
            useToast().error(body.error || 'Unknown error', 5000)
        }
        throw err
    }
    if (body.payload !== undefined) return body.payload
    return body
}

// ==================== Public API ====================

/** silent=true 时错误不弹全局 toast（轮询场景由调用方内联处理） */
export async function apiGet<T = any>(path: string, silent = false): Promise<T> {
    const url = `${getBaseUrl()}${path}`
    const response = await fetchWithToast(url, {
        method: 'GET',
        headers: getHeaders(),
    }, silent)
    return handleResponse<T>(response, silent)
}

/** silent=true 时不弹全局错误 toast（后台自动命名等预期失败自回滚场景） */
export async function apiPost<T = any>(path: string, body?: any, silent = false): Promise<T> {
    const url = `${getBaseUrl()}${path}`
    const response = await fetchWithToast(url, {
        method: 'POST',
        headers: getHeaders('application/json'),
        body: body !== undefined ? JSON.stringify(body) : undefined,
    }, silent)
    return handleResponse<T>(response, silent)
}

export async function apiPut<T = any>(path: string, body?: any): Promise<T> {
    const url = `${getBaseUrl()}${path}`
    const response = await fetchWithToast(url, {
        method: 'PUT',
        headers: getHeaders('application/json'),
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return handleResponse<T>(response)
}

export async function apiPatch<T = any>(path: string, body?: any): Promise<T> {
    const url = `${getBaseUrl()}${path}`
    const response = await fetchWithToast(url, {
        method: 'PATCH',
        headers: getHeaders('application/json'),
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return handleResponse<T>(response)
}

export async function apiDelete<T = any>(path: string): Promise<T> {
    const url = `${getBaseUrl()}${path}`
    const response = await fetchWithToast(url, {
        method: 'DELETE',
        headers: getHeaders(),
    })
    return handleResponse<T>(response)
}

/**
 * Upload a file via multipart/form-data
 */
export async function apiUpload<T = any>(path: string, formData: FormData): Promise<T> {
    const url = `${getBaseUrl()}${path}`
    const settings = useUiSettingsStore()
    const headers: Record<string, string> = {}
    if (settings.token?.trim()) {
        headers['Authorization'] = `Bearer ${settings.token.trim()}`
    }
    // Do NOT set Content-Type — browser sets it with boundary for multipart
    const response = await fetchWithToast(url, {
        method: 'POST',
        headers,
        body: formData,
    })
    return handleResponse<T>(response)
}

/**
 * Update a resource via multipart/form-data using PATCH
 */
export async function apiPatchMultipart<T = any>(path: string, formData: FormData): Promise<T> {
    const url = `${getBaseUrl()}${path}`
    const settings = useUiSettingsStore()
    const headers: Record<string, string> = {}
    if (settings.token?.trim()) {
        headers['Authorization'] = `Bearer ${settings.token.trim()}`
    }
    const response = await fetchWithToast(url, {
        method: 'PATCH',
        headers,
        body: formData,
    })
    return handleResponse<T>(response)
}

/**
 * Get the full URL for a path (useful for SSE connections, etc.)
 */
export function getApiUrl(path: string): string {
    return `${getBaseUrl()}${path}`
}

/**
 * Get auth token for use in SSE or other non-standard requests
 */
export function getAuthToken(): string {
    const settings = useUiSettingsStore()
    return settings.token?.trim() || ''
}
