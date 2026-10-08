<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { KnownApi, useModelsState, OAuthProviders, OpenAICompletionsCompat, AnthropicMessagesCompat, OpenAIResponsesCompat } from '../../composables/useModelsState'
import { useI18n } from 'vue-i18n'
import { EyeIcon, EyeSlashIcon } from '@heroicons/vue/24/outline'

const props = defineProps<{
    show: boolean
    mode: 'add' | 'edit'
    custom?: boolean
    initialData?: {
        id: string
        baseUrl: string
        type?: 'api_key' | 'oauth'
        api: KnownApi
        apiKey?: string
        headers?: Record<string, string>
        compat?: OpenAICompletionsCompat | AnthropicMessagesCompat | OpenAIResponsesCompat
    }
}>()

const isReadonly = computed(() => props.mode === 'edit' && props.custom === false)

const emit = defineEmits<{
    (e: 'close'): void
    (e: 'saved', providerId: string): void
}>()

const { t } = useI18n()
const { saveProvider } = useModelsState()

const formData = reactive({
    id: '',
    baseUrl: '',
    type: 'api_key' as 'api_key' | 'oauth',
    apiKey: '',
    api: 'openai-completions' as KnownApi,
    headers: '',
    compat: {} as Record<string, unknown>,
})
const showApiKey = ref(false)
const isSubmitting = ref(false)

// ── Compat 字段定义（按 provider api 类型区分） ──
// compat 是 provider 级设置：pi 文档明确“provider 级设一次对该 provider 下所有模型生效”。
type CompatFieldDef =
    | { kind: 'bool'; name: string; labelKey: string }
    | { kind: 'enum'; name: string; labelKey: string; options: string[] }

const OPENAI_COMPAT_FIELDS: CompatFieldDef[] = [
    { kind: 'bool', name: 'supportsReasoningEffort', labelKey: 'provider.compat.supportsReasoningEffort' },
    { kind: 'bool', name: 'supportsDeveloperRole', labelKey: 'provider.compat.supportsDeveloperRole' },
    { kind: 'bool', name: 'supportsStore', labelKey: 'provider.compat.supportsStore' },
    { kind: 'bool', name: 'supportsUsageInStreaming', labelKey: 'provider.compat.supportsUsageInStreaming' },
    { kind: 'bool', name: 'supportsFinishReason', labelKey: 'provider.compat.supportsFinishReason' },
    { kind: 'bool', name: 'supportsStrictMode', labelKey: 'provider.compat.supportsStrictMode' },
    { kind: 'bool', name: 'supportsOpenAIGrammarTools', labelKey: 'provider.compat.supportsOpenAIGrammarTools' },
    { kind: 'bool', name: 'supportsThinkingTokenBudget', labelKey: 'provider.compat.supportsThinkingTokenBudget' },
    { kind: 'enum', name: 'thinkingTokenBudgetField', labelKey: 'provider.compat.thinkingTokenBudgetField', options: ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'] },
    { kind: 'bool', name: 'supportsMidConvoSystemMessages', labelKey: 'provider.compat.supportsMidConvoSystemMessages' },
    { kind: 'bool', name: 'supportsMidConvoToolAdditions', labelKey: 'provider.compat.supportsMidConvoToolAdditions' },
    { kind: 'bool', name: 'requiresToolResultName', labelKey: 'provider.compat.requiresToolResultName' },
    { kind: 'bool', name: 'requiresAssistantAfterToolResult', labelKey: 'provider.compat.requiresAssistantAfterToolResult' },
    { kind: 'bool', name: 'requiresThinkingAsText', labelKey: 'provider.compat.requiresThinkingAsText' },
    { kind: 'bool', name: 'requiresReasoningContentOnAssistantMessages', labelKey: 'provider.compat.requiresReasoningContentOnAssistantMessages' },
    { kind: 'bool', name: 'zaiToolStream', labelKey: 'provider.compat.zaiToolStream' },
    { kind: 'bool', name: 'sendSessionAffinityHeaders', labelKey: 'provider.compat.sendSessionAffinityHeaders' },
    { kind: 'bool', name: 'supportsLongCacheRetention', labelKey: 'provider.compat.supportsLongCacheRetention' },
    { kind: 'enum', name: 'cacheControlFormat', labelKey: 'provider.compat.cacheControlFormat', options: ['anthropic'] },
    { kind: 'enum', name: 'maxTokensField', labelKey: 'provider.compat.maxTokensField', options: ['max_completion_tokens', 'max_tokens'] },
    { kind: 'enum', name: 'thinkingFormat', labelKey: 'provider.compat.thinkingFormat', options: ['openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'] },
    { kind: 'enum', name: 'sessionAffinityFormat', labelKey: 'provider.compat.sessionAffinityFormat', options: ['openai', 'openai-nosession', 'openrouter'] },
]

// 无 UI 的字段（嵌套对象与标量数字）：编辑 provider 时必须透传，否则 PATCH 会冲掉 models.json 里的配置。
const OPENAI_NON_UI_COMPAT_KEYS = ['chatTemplateKwargs', 'chatTemplateArgs', 'openRouterRouting', 'vercelGatewayRouting', 'vllmPriority'] as const

const ANTHROPIC_COMPAT_FIELDS: CompatFieldDef[] = [
    { kind: 'bool', name: 'forceAdaptiveThinking', labelKey: 'provider.compat.forceAdaptiveThinking' },
    { kind: 'bool', name: 'allowEmptySignature', labelKey: 'provider.compat.allowEmptySignature' },
    { kind: 'bool', name: 'supportsEagerToolInputStreaming', labelKey: 'provider.compat.supportsEagerToolInputStreaming' },
    { kind: 'bool', name: 'supportsCacheControlOnTools', labelKey: 'provider.compat.supportsCacheControlOnTools' },
    { kind: 'bool', name: 'supportsStrictTools', labelKey: 'provider.compat.supportsStrictTools' },
    { kind: 'bool', name: 'supportsMidConvoEffort', labelKey: 'provider.compat.supportsMidConvoEffort' },
    { kind: 'bool', name: 'supportsMidConvoSystemMessages', labelKey: 'provider.compat.supportsMidConvoSystemMessages' },
    { kind: 'bool', name: 'supportsMidConvoToolChanges', labelKey: 'provider.compat.supportsMidConvoToolChanges' },
    { kind: 'bool', name: 'supportsLongCacheRetention', labelKey: 'provider.compat.supportsLongCacheRetention' },
    { kind: 'bool', name: 'sendSessionAffinityHeaders', labelKey: 'provider.compat.sendSessionAffinityHeaders' },
    { kind: 'bool', name: 'supportsTemperature', labelKey: 'provider.compat.supportsTemperature' },
    { kind: 'enum', name: 'sessionAffinityFormat', labelKey: 'provider.compat.sessionAffinityFormat', options: ['openrouter'] },
]

// 无 UI 的复杂字段（如 allowedFallbackModels 降级模型列表）：同上必须透传。
const ANTHROPIC_NON_UI_COMPAT_KEYS = ['allowedFallbackModels'] as const

const OPENAI_RESPONSES_COMPAT_FIELDS: CompatFieldDef[] = [
    { kind: 'bool', name: 'supportsDeveloperRole', labelKey: 'provider.compat.supportsDeveloperRole' },
    { kind: 'bool', name: 'supportsStrictMode', labelKey: 'provider.compat.supportsStrictMode' },
    { kind: 'bool', name: 'supportsOpenAIGrammarTools', labelKey: 'provider.compat.supportsOpenAIGrammarTools' },
    { kind: 'bool', name: 'supportsAdditionalTools', labelKey: 'provider.compat.supportsAdditionalTools' },
    { kind: 'bool', name: 'supportsToolSearch', labelKey: 'provider.compat.supportsToolSearch' },
    { kind: 'bool', name: 'supportsExplicitPromptCacheMode', labelKey: 'provider.compat.supportsExplicitPromptCacheMode' },
    { kind: 'bool', name: 'supportsMaxOutputTokens', labelKey: 'provider.compat.supportsMaxOutputTokens' },
    { kind: 'bool', name: 'supportsMidConvoSystemMessages', labelKey: 'provider.compat.supportsMidConvoSystemMessages' },
    { kind: 'bool', name: 'supportsLongCacheRetention', labelKey: 'provider.compat.supportsLongCacheRetention' },
    { kind: 'enum', name: 'sessionAffinityFormat', labelKey: 'provider.compat.sessionAffinityFormat', options: ['openai', 'openai-nosession', 'openrouter'] },
]

const compatFields = computed<CompatFieldDef[]>(() => {
    if (formData.api === 'anthropic-messages') return ANTHROPIC_COMPAT_FIELDS
    if (formData.api === 'openai-completions') return OPENAI_COMPAT_FIELDS
    // azure/codex 同用 openai-responses wire 协议，compat 字段集一致（pi-ai 类型按 api 联合分派）。
    if (formData.api === 'openai-responses') return OPENAI_RESPONSES_COMPAT_FIELDS
    if (formData.api === 'azure-openai-responses') return OPENAI_RESPONSES_COMPAT_FIELDS
    if (formData.api === 'openai-codex-responses') return OPENAI_RESPONSES_COMPAT_FIELDS
    return []
})

const hasCompatFields = computed(() => compatFields.value.length > 0)

// bool 字段的三态 select：'' = 默认(不写) / 'true' / 'false'。
function getBoolCompat(name: string): string {
    const v = formData.compat[name]
    if (v === true) return 'true'
    if (v === false) return 'false'
    return ''
}
function setBoolCompat(name: string, next: string) {
    if (next === 'true') formData.compat[name] = true
    else if (next === 'false') formData.compat[name] = false
    else delete formData.compat[name]
}

// enum 字段的 select：'' = 默认(不写) / 具体值。
function getEnumCompat(name: string): string {
    const v = formData.compat[name]
    return typeof v === 'string' ? v : ''
}
function setEnumCompat(name: string, next: string) {
    if (next) formData.compat[name] = next
    else delete formData.compat[name]
}

// Watch for initial data
watch(() => props.show, (newVal) => {
    if (newVal) {
        if (props.mode === 'edit' && props.initialData) {
            formData.id = props.initialData.id
            formData.baseUrl = props.initialData.baseUrl
            formData.type = props.initialData.type || (OAuthProviders.includes(props.initialData.id) ? 'oauth' : 'api_key')
            formData.api = props.initialData.api as KnownApi
            formData.apiKey = props.initialData.apiKey || ''
            formData.headers = props.initialData.headers ? JSON.stringify(props.initialData.headers, null, 2) : ''
            // 深拷避免表单编辑直接窜改到 state.providers 里的原始对象
            //（含 chatTemplateKwargs / routing 等嵌套字段）。
            // 注意：initialData.compat 是 Vue reactive Proxy，structuredClone 对 Proxy
            // 会抛 DataCloneError；compat 全是 JSON-safe 数据，用 JSON 深拷。
            formData.compat = JSON.parse(JSON.stringify(props.initialData.compat ?? {}))
        } else {
            // Reset for add
            formData.id = ''
            formData.baseUrl = ''
            formData.type = 'api_key'
            formData.apiKey = ''
            formData.api = 'openai-completions'
            formData.headers = ''
            formData.compat = {}
        }
        hasAttemptedSubmit.value = false
    }
})

const hasAttemptedSubmit = ref(false)

const validationErrors = computed(() => {
    const errors: Record<string, string> = {}
    if (!formData.id.trim()) {
        errors.id = t('provider.validation.idRequired')
    }
    // 非 OAuth 时，baseUrl 必填；apiKey 允许留空以支持无密钥或后续补填的提供商。
    if (formData.type !== 'oauth' && (props.custom || props.mode === 'add') && !formData.baseUrl.trim()) {
        errors.baseUrl = t('provider.validation.baseUrlRequired')
    }
    // Headers JSON 格式验证
    if (formData.headers) {
        try {
            JSON.parse(formData.headers)
        } catch (e) {
            errors.headers = t('provider.invalidJson')
        }
    }
    return errors
})

const isFormValid = computed(() => Object.keys(validationErrors.value).length === 0)

type ValidationField = 'id' | 'baseUrl' | 'headers'

function shouldShowError(field: ValidationField): boolean {
    return !!validationErrors.value[field] && (hasAttemptedSubmit.value || formData[field] !== '')
}

const modalTitle = computed(() => {
    return props.mode === 'add' ? t('provider.addTitle') : t('provider.editTitle')
})

const submitLabel = computed(() => {
    return isSubmitting.value ? t('common.saving') : t('common.save')
})

const handleClose = () => {
    emit('close')
}

const handleSubmit = async () => {
    hasAttemptedSubmit.value = true
    if (!isFormValid.value) return

    isSubmitting.value = true
    try {
        let parsedHeaders: Record<string, string> | undefined = undefined
        if (formData.headers && formData.headers.trim()) {
            parsedHeaders = JSON.parse(formData.headers)
        }

        const shouldSendApiKey = !!formData.apiKey.trim() || props.mode === 'add' || props.initialData?.apiKey !== undefined

        // compat 只保留当前 api 类型下的字段，避免切换 api 后残留无关项；
        // 同时透传同 api 的无 UI 嵌套字段（如 chatTemplateKwargs），防止例行编辑冲掉配置。
        const nonUiKeys = formData.api === 'openai-completions'
            ? OPENAI_NON_UI_COMPAT_KEYS
            : formData.api === 'anthropic-messages'
                ? ANTHROPIC_NON_UI_COMPAT_KEYS
                : []
        const allowedNames = new Set<string>([
            ...compatFields.value.map((f) => f.name),
            ...nonUiKeys,
        ])
        const compat: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(formData.compat)) {
            if (allowedNames.has(k)) compat[k] = v
        }

        await saveProvider({
            id: formData.id,
            baseUrl: formData.baseUrl,
            type: formData.type,
            apiKey: shouldSendApiKey ? formData.apiKey : undefined,
            api: formData.api,
            headers: parsedHeaders,
            compat: Object.keys(compat).length > 0
                ? (compat as OpenAICompletionsCompat | AnthropicMessagesCompat | OpenAIResponsesCompat)
                : undefined,
        })

        emit('saved', formData.id)
        handleClose()
    } catch (err: any) {
        alert(err.message || t('provider.saveFailed'))
    } finally {
        isSubmitting.value = false
    }
}
</script>

<template>
    <dialog :class="{ 'modal modal-open': show, 'modal': !show }">
        <div class="modal-box w-11/12 max-w-3xl">
            <h3 class="font-bold text-lg mb-6">{{ modalTitle }}</h3>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div v-if="mode === 'add'" class="form-control md:col-span-2">
                    <label class="label"><span class="label-text">{{ $t('provider.id') }} <span
                                class="text-error">*</span></span></label>
                    <input v-model="formData.id" type="text" placeholder="e.g. openai, anthropic"
                        class="input input-bordered w-full font-mono" :class="{ 'input-error': shouldShowError('id') }" />
                </div>

                <div class="form-control ">
                    <label class="label"><span class="label-text">{{ $t('provider.baseUrl') }}
                        <span v-if="formData.type !== 'oauth'" class="text-error">*</span>
                    </span></label>
                    <input v-model="formData.baseUrl" type="text" placeholder="https://...com/v1"
                        class="input input-bordered w-full" :disabled="isReadonly"
                        :class="{ 'input-error': shouldShowError('baseUrl') }" />
                </div>

                <div class="form-control">
                    <label class="label"><span class="label-text">{{ $t('provider.apiType') }}</span></label>
                    <select v-model="formData.api" class="select select-bordered w-full" :disabled="isReadonly">
                        <option value="openai-completions">{{ $t('provider.apiOpenAI') }}</option>
                        <option value="mistral-conversations">{{ $t('provider.apiMistral') }}</option>
                        <option value="openai-responses">{{ $t('provider.apiOpenAIResponses') }}</option>
                        <option value="azure-openai-responses">{{ $t('provider.apiAzureOpenAIResponses') }}</option>
                        <option value="openai-codex-responses">{{ $t('provider.apiOpenAICodexResponses') }}</option>
                        <option value="anthropic-messages">{{ $t('provider.apiAnthropic') }}</option>
                        <option value="bedrock-converse-stream">{{ $t('provider.apiBedrock') }}</option>
                        <option value="google-generative-ai">{{ $t('provider.apiGoogle') }}</option>
                        <option value="google-vertex">{{ $t('provider.apiGoogleVertex') }}</option>
                    </select>
                </div>


                <div class="form-control">
                    <label class="label"><span class="label-text">{{ $t('provider.authType') }}</span></label>
                    <select v-model="formData.type" class="select select-bordered w-full">
                        <option value="api_key">{{ $t('provider.authTypeApiKey') }}</option>
                        <option value="oauth">{{ $t('provider.authTypeOAuth') }}</option>
                    </select>
                </div>

                <div class="form-control">
                    <label class="label"><span class="label-text">{{ $t('settings.apiKey') }}</span></label>
                    <div class="join w-full">
                        <input v-model="formData.apiKey" :type="showApiKey ? 'text' : 'password'" placeholder="sk-..."
                            class="input input-bordered join-item flex-1" />
                        <button type="button" @click="showApiKey = !showApiKey" class="btn btn-ghost join-item"
                            tabindex="-1">
                            <EyeSlashIcon v-if="showApiKey" class="w-4 h-4" />
                            <EyeIcon v-else class="w-4 h-4" />
                        </button>
                    </div>
                </div>

                <div class="form-control md:col-span-2">
                    <label class="label">
                        <span class="label-text">{{ $t('provider.customHeaders') }}</span>
                        <span class="label-text-alt text-base-content/50">{{ $t('common.optional') }}</span>
                    </label>
                    <textarea v-model="formData.headers" rows="3"
                        class="textarea textarea-bordered w-full font-mono text-sm"
                        :class="{ 'textarea-error': shouldShowError('headers') }"
                        placeholder='{"X-Proxy-Region": "us-west"}' :disabled="isReadonly"></textarea>
                    <p v-if="shouldShowError('headers')" class="text-error text-xs mt-1">
                        {{ validationErrors.headers }}
                    </p>
                </div>

                <!-- Provider Compatibility (按 api 类型区分) -->
                <div v-if="hasCompatFields" class="form-control md:col-span-2 mt-2">
                    <label class="label">
                        <span class="label-text font-semibold">{{ $t('provider.compat.title') }}</span>
                    </label>
                    <p class="text-xs text-base-content/60 mb-2">{{ $t('provider.compat.hint') }}</p>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div v-for="field in compatFields" :key="field.name"
                            class="flex items-center justify-between gap-3">
                            <span class="text-sm flex-1 min-w-0" :title="field.name">{{ $t(field.labelKey) }}</span>
                            <select v-if="field.kind === 'bool'"
                                :value="getBoolCompat(field.name)"
                                @change="setBoolCompat(field.name, ($event.target as HTMLSelectElement).value)"
                                class="select select-bordered select-sm w-32 shrink-0" :disabled="isReadonly">
                                <option value="">{{ $t('provider.compat.default') }}</option>
                                <option value="true">{{ $t('provider.compat.yes') }}</option>
                                <option value="false">{{ $t('provider.compat.no') }}</option>
                            </select>
                            <select v-else
                                :value="getEnumCompat(field.name)"
                                @change="setEnumCompat(field.name, ($event.target as HTMLSelectElement).value)"
                                class="select select-bordered select-sm w-44 shrink-0 font-mono" :disabled="isReadonly">
                                <option value="">{{ $t('provider.compat.default') }}</option>
                                <option v-for="opt in field.options" :key="opt" :value="opt">{{ opt }}</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>

            <div class="modal-action">
                <button @click="handleClose" class="btn">{{ $t('common.cancel') }}</button>
                <button @click="handleSubmit" class="btn btn-primary" :disabled="isSubmitting">{{
                    submitLabel
                    }}</button>
            </div>
        </div>
        <form method="dialog" class="modal-backdrop">
            <button @click="handleClose">{{ $t('common.close') }}</button>
        </form>
    </dialog>
</template>
