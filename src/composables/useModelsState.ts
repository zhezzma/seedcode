import { reactive, computed } from 'vue'
import { apiGet, apiPost, apiPatch, apiDelete } from './api-client'


// ==================== Types ====================

/** pi thinking levels. `off` 也是合法 key（用于标记模型不可关闭思考）。
 *  `xhigh` 和 `max` 需要 thinkingLevelMap 中显式映射才能使用。 */
export type ThinkingLevelKey = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * 三态：
 *  - 字段缺省       → 该级别支持，用 provider 默认映射
 *  - string         → 该级别支持，把此值发给 provider（如 reasoning_effort）
 *  - null           → 该级别不支持，UI 隐藏 / clamp 掉
 */
export type ThinkingLevelMap = Partial<Record<ThinkingLevelKey, string | null>>

/** 与上游 pi-ai `ModelCost` 对齐：基础费率 + 可选阶梯定价。 */
export interface ModelCostTier {
    inputTokensAbove: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
}

export interface ModelCost {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    tiers?: ModelCostTier[]
}

/** A single model entry returned by the API */
export interface AvailableModel {
    id: string
    name: string
    // Optional overrides
    contextWindow?: number
    maxTokens?: number
    cost?: ModelCost
    reasoning?: boolean
    input?: string[]
    /** null 仅用于 PATCH 时显式删除后端已存的 map（后端 merge 语义下省略无法清除）。 */
    thinkingLevelMap?: ThinkingLevelMap | null
    compat?: OpenAICompletionsCompat | AnthropicMessagesCompat | OpenAIResponsesCompat
}
//https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts
//https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
export type KnownApi = "openai-completions" | "mistral-conversations" | "openai-responses" | "azure-openai-responses" | "openai-codex-responses" | "anthropic-messages" | "bedrock-converse-stream" | "google-generative-ai" | "google-vertex";

export const OAuthProviders = ['anthropic', 'github-copilot', 'openai-codex'];


/** Provider configuration in models.json */
export interface ProviderConfig {
    baseUrl: string
    type?: 'api_key' | 'oauth'
    apiKey?: string
    api: KnownApi
    headers?: Record<string, string>
    models: AvailableModel[]
    custom: boolean
    compat?: OpenAICompletionsCompat | AnthropicMessagesCompat | OpenAIResponsesCompat
}

/** Shape of the API response payload for /api/models */
export interface ModelsState {
    providers: Record<string, ProviderConfig>
}

// Flat model for UI
export interface ModelOption {
    id: string       // "provider/model"
    name: string     // display name
    provider: string
    model: string
}

/** chat-template thinkingFormat 的 chat_template_kwargs 值。 */
export type ChatTemplateKwargValue =
    | string
    | number
    | boolean
    | null
    | {
        $var: 'thinking.enabled' | 'thinking.effort'
        omitWhenOff?: boolean
    }

/** OpenRouter provider routing 偏好（结构复杂，客户端不编辑，仅透传）。 */
export type OpenRouterRouting = Record<string, unknown>

/** Vercel AI Gateway routing 偏好。 */
export interface VercelGatewayRouting {
    only?: string[]
    order?: string[]
}

export interface OpenAICompletionsCompat {
    supportsStore?: boolean
    supportsDeveloperRole?: boolean
    supportsReasoningEffort?: boolean
    supportsUsageInStreaming?: boolean
    maxTokensField?: 'max_completion_tokens' | 'max_tokens'
    requiresToolResultName?: boolean
    requiresAssistantAfterToolResult?: boolean
    requiresThinkingAsText?: boolean
    requiresReasoningContentOnAssistantMessages?: boolean
    thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'
    /** thinkingFormat=chat-template 时发送的 chat_template_kwargs；无 UI，保存时必须透传。 */
    chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>
    /** OpenRouter routing；无 UI，保存时必须透传。 */
    openRouterRouting?: OpenRouterRouting
    /** Vercel AI Gateway routing；无 UI，保存时必须透传。 */
    vercelGatewayRouting?: VercelGatewayRouting
    zaiToolStream?: boolean
    supportsStrictMode?: boolean
    cacheControlFormat?: 'anthropic'
    sendSessionAffinityHeaders?: boolean
    supportsLongCacheRetention?: boolean
}

/** api: "anthropic-messages" 专用 compat 字段。 */
export interface AnthropicMessagesCompat {
    supportsEagerToolInputStreaming?: boolean
    supportsLongCacheRetention?: boolean
    sendSessionAffinityHeaders?: boolean
    supportsCacheControlOnTools?: boolean
    supportsTemperature?: boolean
    forceAdaptiveThinking?: boolean
    allowEmptySignature?: boolean
}

/** api: "openai-responses" 专用 compat 字段。 */
export interface OpenAIResponsesCompat {
    supportsDeveloperRole?: boolean
    sendSessionIdHeader?: boolean
    supportsLongCacheRetention?: boolean
}


/** A provider derived from grouping available models */
export interface ProviderInfo extends ProviderConfig {
    id: string;
    name: string;
    provider: string; // same as id
}

// ==================== State ====================
const state = reactive<ModelsState>({
    providers: {}
})

// ==================== Derived Computeds（模块级，仅初始化一次）====================

/** All available models grouped by provider, filtered by apiKey presence */
const availableModels = computed<ProviderInfo[]>(() => {
    const result: ProviderInfo[] = []
    for (const [id, config] of Object.entries(state.providers)) {
        if (!config.apiKey) continue
        result.push({ id, name: id, provider: id, ...config })
    }
    return result.sort((a, b) => {
        if (a.custom && !b.custom) return -1
        if (!a.custom && b.custom) return 1
        return 0
    })
})

/** Providers list */
const providers = computed<ProviderInfo[]>(() => {
    const result: ProviderInfo[] = []
    for (const [id, config] of Object.entries(state.providers)) {
        result.push({ id, name: id, provider: id, ...config })
    }
    return result.sort((a, b) => {
        if (a.custom && !b.custom) return -1
        if (!a.custom && b.custom) return 1
        return 0
    })
})

// ==================== Actions ====================

const loadModels = async () => {
    try {
        const result = await apiGet<Record<string, ProviderConfig>>('/api/models')
        state.providers = result
        return state.providers
    } catch (err: any) {
        console.error('Failed to load models config:', err)
        throw err
    }
}

const saveProvider = async (providerData: { id: string, baseUrl: string, type?: 'api_key' | 'oauth', apiKey?: string, api: KnownApi, headers?: Record<string, string>, compat?: OpenAICompletionsCompat | AnthropicMessagesCompat | OpenAIResponsesCompat }) => {
    const existing = state.providers[providerData.id]
    if (existing) {
        await apiPatch(`/api/models/providers/${providerData.id}`, {
            baseUrl: providerData.baseUrl,
            type: providerData.type,
            apiKey: providerData.apiKey,
            api: providerData.api,
            headers: providerData.headers ?? {},
            compat: providerData.compat ?? {},
        })
        const hasCompat = !!providerData.compat && Object.keys(providerData.compat).length > 0
        state.providers[providerData.id] = {
            ...existing,
            baseUrl: providerData.baseUrl,
            type: providerData.type,
            ...(providerData.apiKey !== undefined ? { apiKey: providerData.apiKey } : {}),
            api: providerData.api,
            headers: providerData.headers ?? {},
            // compat 空时后端会删字段，本地 state 同步剔除，避免遗留 {}。
            ...(hasCompat ? { compat: providerData.compat } : { compat: undefined }),
        }
    } else {
        const newProvider: ProviderConfig = {
            baseUrl: providerData.baseUrl,
            type: providerData.type,
            apiKey: providerData.apiKey,
            api: providerData.api,
            headers: providerData.headers,
            compat: providerData.compat,
            models: [],
            custom: true
        }
        await apiPost('/api/models/providers', { id: providerData.id, ...newProvider })
        state.providers[providerData.id] = newProvider
    }
}

const deleteProvider = async (providerId: string) => {
    await apiDelete(`/api/models/providers/${providerId}`)
    delete state.providers[providerId]
}

const saveModel = async (providerId: string, model: AvailableModel) => {
    const provider = state.providers[providerId]
    if (!provider) throw new Error('Provider not found')
    const existingModelIndex = provider.models.findIndex(m => m.id === model.id)
    if (existingModelIndex !== -1) {
        await apiPatch(`/api/models/providers/${providerId}/models/${encodeURIComponent(model.id)}`, model)
        // 镜像后端 PATCH 的浅 merge 语义（{ ...existing, ...body }）：保留表单未涵盖的
        // 字段（如 per-model compat、headers），避免本地 state 被整对象替换冲掉、刷新前显示不一致。
        const merged: AvailableModel = { ...provider.models[existingModelIndex], ...model }
        // null 是发给后端的“删除”信号；后端 merge 后会 delete 该字段，本地同步剔除。
        if (model.thinkingLevelMap === null) {
            delete merged.thinkingLevelMap
        }
        provider.models[existingModelIndex] = merged
    } else {
        await apiPost(`/api/models/providers/${providerId}/models`, model)
        provider.models.push(model)
    }
}

const deleteModel = async (providerId: string, modelId: string) => {
    const provider = state.providers[providerId]
    if (!provider) return
    await apiDelete(`/api/models/providers/${providerId}/models/${encodeURIComponent(modelId)}`)
    provider.models = provider.models.filter(m => m.id !== modelId)
}

const clearProviderModels = async (providerId: string) => {
    const provider = state.providers[providerId]
    if (!provider) throw new Error('Provider not found')

    const res = await apiDelete<{ message: string, deleted: number }>(`/api/models/providers/${providerId}/models`)
    provider.models = []
    return res
}

/**
 * Trigger sync models from the server.
 */
const syncModels = async (providerId: string) => {
    const provider = state.providers[providerId]
    if (!provider) throw new Error('Provider not found')

    try {
        const res = await apiPost<any>(`/api/models/providers/${providerId}/models/sync`, {})

        if (res && res.models) {
            provider.models = res.models
        }

        return { created: res?.models?.length || provider.models?.length || 0, updated: 0 }
    } catch (err: any) {
        console.error('Sync failed:', err)
        throw err
    }
}


/** 
 * OAuth 认证相关动作 
 */

// 启动 OAuth 流程，返回会话 ID 和 授权 URL
const startOAuth = async (provider: string) => {
    return await apiPost<{ sessionId: string, url: string, instructions?: string, status: string }>(`/api/auth/oauth/${provider}`)
}

// 轮询 OAuth 状态
const pollOAuthStatus = async (sessionId: string) => {
    return await apiGet<{
        id: string,
        status: "pending" | "waiting_for_input" | "completed" | "failed",
        url?: string,
        instructions?: string,
        prompt?: { message: string, placeholder?: string },
        error?: string
    }>(`/api/auth/oauth/${sessionId}`)
}

// 提交用户手动输入（验证码、手动粘贴的回调 URL 等）
const submitOAuthInput = async (sessionId: string, input: string) => {
    return await apiPost(`/api/auth/oauth/${sessionId}/input`, { input })
}

// 终止 OAuth 流程并释放资源
const abortOAuthSession = async (sessionId: string) => {
    return await apiDelete(`/api/auth/oauth/${sessionId}`)
}

// ==================== Export ====================

const _modelsState = {
    availableModels,
    providers,
    loadModels,
    saveProvider,
    deleteProvider,
    saveModel,
    deleteModel,
    clearProviderModels,
    syncModels,
    startOAuth,
    pollOAuthStatus,
    submitOAuthInput,
    abortOAuthSession
}

export function useModelsState() {
    return _modelsState
}
