<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useUiSettingsStore, LOCAL_GATEWAY_ID } from '../stores/setting'
import { localServer, effectiveGatewayMode, restartLocalServer } from '../composables/local-server'
import { apiGet } from '../composables/api-client'
import { useModelsState, type KnownApi } from '../composables/useModelsState'
import { useAgentsState } from '../composables/useAgentsState'

import {
    ArrowRightIcon,
    EyeIcon,
    EyeSlashIcon,
    CheckCircleIcon,
    ServerIcon,
    UserCircleIcon,
    CpuChipIcon,
    SparklesIcon,
    CubeIcon,
    GlobeAltIcon,
    KeyIcon,
    PhotoIcon,
    IdentificationIcon
} from '@heroicons/vue/24/outline'

const router = useRouter()
const { t } = useI18n()
const configStore = useUiSettingsStore()
const modelsState = useModelsState()
const agentsState = useAgentsState()

// Wizard State
const currentStep = ref(1)
const steps = computed(() => [
    { id: 1, title: t('setup.steps.connect'), icon: ServerIcon },
    { id: 2, title: t('setup.steps.model'), icon: CpuChipIcon },
    { id: 3, title: t('setup.steps.agent'), icon: UserCircleIcon }
])

// Step 1: Connection State
const apiBaseUrl = ref('http://localhost:18789')
const authToken = ref('')
const isLoading = ref(false)
const error = ref('')
const showPassword = ref(false)
// 引导页名称输入：写入网关条目（GatewayProfile.name），留空走 store 兜底
const gatewayName = ref('')

// 内置服务端模式（Tauri + bundled）：本地服务由应用托管，
// 引导页不再要求手填网关地址；"连接远程服务器"是显式的高级选项
const isLocalMode = computed(() => effectiveGatewayMode() === 'local')
const showRemoteForm = ref(!isLocalMode.value)

// Step 2: Model State
const modelProviderId = ref('openai')
const customProviderId = ref('')
const modelBaseUrl = ref('https://api.openai.com/v1')
const modelApiKey = ref('')
const modelApiType = ref<KnownApi>('openai-completions')
const modelIsSubmitting = ref(false)

const providerOptions: Array<{ id: string, name: string, baseUrl: string, api: KnownApi }> = [
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
    { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages' },
    { id: 'google', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' },
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
    { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', api: 'openai-completions' },
    { id: 'custom', name: 'Custom', baseUrl: '', api: 'openai-completions' }
]

watch(modelProviderId, (newId) => {
    const provider = providerOptions.find(p => p.id === newId)
    if (provider && newId !== 'custom') {
        modelBaseUrl.value = provider.baseUrl
        modelApiType.value = provider.api
    } else if (newId === 'custom') {
        modelBaseUrl.value = ''
    }
})

// Step 3: Agent State
const agentName = ref(t('setup.agentStep.defaultDescription'))
const avatarFile = ref<File | null>(null)
const avatarPreview = ref('')
const fileInput = ref<HTMLInputElement | null>(null) // Add ref for file input
const agentIsSubmitting = ref(false)

const triggerFileInput = () => {
    fileInput.value?.click()
}

const handleFileChange = (event: Event) => {
    const input = event.target as HTMLInputElement
    if (input.files && input.files[0]) {
        const file = input.files[0]
        avatarFile.value = file

        const reader = new FileReader()
        reader.onload = (e) => {
            avatarPreview.value = e.target?.result as string
        }
        reader.readAsDataURL(file)
    }
}

// --- Step 1: Connection Logic ---

// 本地模式：服务端由 Rust 托管，无需手填地址；就绪后写 local 条目并进入后续步骤
const handleLocalSubmit = async () => {
    isLoading.value = true
    error.value = ''

    try {
        const profileName = gatewayName.value.trim()
        const existingLocal = configStore.gateways.find((g) => g.id === LOCAL_GATEWAY_ID)
        if (existingLocal) {
            // 保留条目上的 lastNewSessionAgentId（迁移来的本地 agent 记忆）：
            // addGateway 是整条目 upsert，会把记忆字段清掉
            // 名称留空时不覆盖：保留条目已有名称
            configStore.updateGateway(LOCAL_GATEWAY_ID, {
                apiBaseUrl: localServer.url ?? '',
                token: localServer.token ?? '',
                ...(profileName ? { name: profileName } : {}),
            })
        } else {
            configStore.addGateway({
                id: LOCAL_GATEWAY_ID,
                type: 'local',
                name: profileName || t('gateway.localManaged'),
                apiBaseUrl: localServer.url ?? '',
                token: localServer.token ?? '',
            })
        }
        configStore.setActiveGateway(LOCAL_GATEWAY_ID)
        if (localServer.url && localServer.token) {
            configStore.save({
                apiBaseUrl: localServer.url,
                token: localServer.token,
            })
        }
        await checkNextSteps()
    } catch (e: any) {
        error.value = e instanceof Error ? e.message : t('setup.connectionFailed')
        console.error(e)
        isLoading.value = false
    }
}

const restartServer = () => { restartLocalServer() }

const handleConnectionSubmit = async () => {
    // Validate
    if (!apiBaseUrl.value.trim()) {
        error.value = t('setup.enterGatewayUrl')
        return
    }
    if (!authToken.value.trim()) {
        error.value = t('setup.enterToken')
        return
    }

    // Validate URL format (HTTP API)
    if (!apiBaseUrl.value.startsWith('http://') && !apiBaseUrl.value.startsWith('https://')) {
        error.value = t('setup.gatewayUrlFormatError')
        return
    }

    isLoading.value = true
    error.value = ''

    try {
        // Save configuration first
        // 远程模式：创建（或按 URL 复用）第一个远程条目并激活
        const url = apiBaseUrl.value.trim()
        const token = authToken.value.trim()
        const profileName = gatewayName.value.trim()
        const existing = configStore.gateways.find(
            (g) => g.type === 'remote' && g.apiBaseUrl.replace(/\/+$/, '') === url.replace(/\/+$/, ''),
        )
        if (existing) {
            // 名称留空时不覆盖：保留条目已有名称
            configStore.updateGateway(existing.id, { token, ...(profileName ? { name: profileName } : {}) })
            configStore.setActiveGateway(existing.id)
        } else {
            // 留空时 addGateway 内部兜底为地址 host 标识
            const entry = configStore.addGateway({ type: 'remote', name: profileName, apiBaseUrl: url, token })
            configStore.setActiveGateway(entry.id)
        }

        // Connection successful.
        // Determine if we need to show Model/Agent setup steps.
        await checkNextSteps()

    } catch (e: any) {
        // Connection failed, show error
        error.value = e instanceof Error ? e.message : t('setup.connectionFailed')
        console.error(e)
        isLoading.value = false
    }
}

const checkNextSteps = async () => {
    try {
        // Load Models
        await modelsState.loadModels()
        // If no providers/models exist, go to Step 2
        if (modelsState.availableModels.value.length === 0) {
            currentStep.value = 2
            isLoading.value = false
            return
        }

        // Load Agents
        await agentsState.loadAgents()
        // If no agents exist, go to Step 3
        if (agentsState.agentsList.length === 0) {
            currentStep.value = 3
            isLoading.value = false
            return
        }

        // All good, go Home
        configStore.save({ setupDone: true })
        router.push('/')
    } catch (e) {
        console.error("Failed to check next steps", e)
        isLoading.value = false // Let user stay on step 1 to retry or maybe fail gracefully?
        error.value = t('setup.connectionFailed')
    }
}

// --- Step 2: Model Logic ---

const handleModelSubmit = async () => {
    const isCustom = modelProviderId.value === 'custom'
    const finalProviderId = isCustom ? customProviderId.value : modelProviderId.value

    if (!finalProviderId || !modelBaseUrl.value) {
        error.value = t('setup.modelStep.errorMissingFields')
        return
    }

    modelIsSubmitting.value = true
    error.value = ''

    try {
        // Save provider
        await modelsState.saveProvider({
            id: finalProviderId,
            baseUrl: modelBaseUrl.value,
            type: 'api_key',
            apiKey: modelApiKey.value,
            api: modelApiType.value
        })

        // Sync models (fetch from provider)
        // Note: syncModels triggers a fetch from the provider url.
        try {
            await modelsState.syncModels(finalProviderId)
        } catch (syncErr) {
            console.warn("Sync failed, but provider saved.", syncErr)
            // Even if sync fails, we might want to proceed or warn?
            // User can manually add models later.
        }

        // Refresh models list
        await modelsState.loadModels()

        // Go to Step 3
        currentStep.value = 3
    } catch (e: any) {
        error.value = e.message || t('setup.modelStep.errorSave')
    } finally {
        modelIsSubmitting.value = false
    }
}
// Removed skipModelStep function (Step 2 is mandatory)

// --- Step 3: Agent Logic ---

const handleAgentSubmit = async () => {
    if (!agentName.value) return

    agentIsSubmitting.value = true
    error.value = ''

    try {
        // Find a default model to use
        let defaultModel = ''
        let defaultProvider = ''

        const models = modelsState.availableModels.value
        if (models.length > 0) {
            const firstGroup = models[0]
            if (firstGroup.models.length > 0) {
                defaultProvider = firstGroup.id
                defaultModel = firstGroup.models[0].id // Use the first available model
            }
        }

        // Create Agent
        const data = new FormData()
        data.append('id', 'main') // Default ID for the first agent
        data.append('name', agentName.value)
        data.append('description', t('setup.agentStep.defaultDescription'))
        if (avatarFile.value) {
            data.append('avatar', avatarFile.value)
        }

        if (defaultModel && defaultProvider) {
            data.append('defaultModel', defaultModel)
            data.append('defaultProvider', defaultProvider)
        }

        await agentsState.createAgent(data)

        // Finish
        configStore.save({ setupDone: true })
        router.push('/')
    } catch (e: any) {
        error.value = e.message || t('setup.agentStep.errorCreate')
    } finally {
        agentIsSubmitting.value = false
    }
}

</script>

<template>
    <div
        class="min-h-screen bg-gradient-to-br from-base-300 via-base-200 to-base-300 flex items-center justify-center p-4">
        <!-- Decorative background elements -->
        <div class="absolute inset-0 overflow-hidden pointer-events-none">
            <div class="absolute -top-40 -right-40 w-80 h-80 bg-primary/10 rounded-full blur-3xl"></div>
            <div class="absolute -bottom-40 -left-40 w-80 h-80 bg-secondary/10 rounded-full blur-3xl"></div>
        </div>

        <div
            class="card bg-base-100/80 backdrop-blur-xl shadow-2xl w-full max-w-md border border-base-300 relative z-10 transition-all duration-500">
            <div class="card-body p-8">
                <!-- Header -->
                <div class="text-center mb-8">
                    <div class="text-6xl mb-4 animate-bounce">🦀</div>
                    <h1
                        class="text-3xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
                        Seedcode
                    </h1>
                    <!-- Steps Indicator -->
                    <ul class="steps steps-sm w-full mt-6">
                        <li v-for="step in steps" :key="step.id" class="step"
                            :class="{ 'step-primary': currentStep >= step.id }">
                            {{ step.title }}
                        </li>
                    </ul>
                </div>

                <!-- Error message -->
                <div v-if="error" role="alert" class="alert alert-error alert-soft mb-4">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24"
                        stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span>{{ error }}</span>
                </div>


                <!-- Step 1a: Local bundled server card（内置服务端托管，无需手填地址） -->
                <div v-if="currentStep === 1 && isLocalMode && !showRemoteForm" class="space-y-6 animate-fade-in">
                    <div class="rounded-2xl border border-base-300 bg-base-200/60 p-5">
                        <div class="flex items-center gap-3">
                            <ServerIcon class="h-6 w-6 text-primary" />
                            <div class="flex-1">
                                <p class="font-medium">{{ $t('setup.localServerTitle') }}</p>
                                <p class="text-xs opacity-60">{{ $t('setup.localServerDesc') }}</p>
                            </div>
                            <span v-if="localServer.state === 'running'" class="badge badge-success badge-soft gap-1.5">
                                <span class="inline-block h-1.5 w-1.5 rounded-full bg-success animate-pulse"></span>
                                {{ $t('setup.localServerRunning') }}
                            </span>
                            <span v-else-if="localServer.state === 'failed'" class="badge badge-error badge-soft">
                                {{ $t('setup.localServerFailed') }}
                            </span>
                            <span v-else class="badge badge-warning badge-soft gap-1.5">
                                <span class="loading loading-spinner loading-xs"></span>
                                {{ $t('setup.localServerStarting') }}
                            </span>
                        </div>
                        <p v-if="localServer.state === 'running' && localServer.url"
                            class="mt-2 font-mono text-xs opacity-50">{{ localServer.url }}</p>
                        <div v-if="localServer.state === 'failed'" class="mt-2 space-y-2">
                            <p class="text-xs text-error">{{ localServer.lastError }}</p>
                            <button type="button" class="btn btn-outline btn-xs" @click="restartServer">
                                {{ $t('setup.localServerRetry') }}
                            </button>
                        </div>
                    </div>

                    <!-- Server Name -->
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend text-sm font-medium">
                            <ServerIcon class="w-4 h-4 inline mr-1" />
                            {{ $t('gateway.serverName') }}
                        </legend>
                        <input v-model="gatewayName" type="text" class="input w-full focus:input-primary transition-all" />
                        <p class="label text-xs opacity-60">{{ $t('gateway.serverNamePlaceholder') }}</p>
                    </fieldset>

                    <button type="button" @click="handleLocalSubmit"
                        class="btn btn-primary btn-block gap-2 h-12 text-base shadow-lg hover:shadow-primary/25 transition-all"
                        :disabled="isLoading || localServer.state !== 'running'">
                        <span v-if="isLoading || localServer.state !== 'running'"
                            class="loading loading-spinner loading-sm"></span>
                        <template v-else>
                            {{ $t('setup.startUsing') }}
                            <ArrowRightIcon class="h-5 w-5" />
                        </template>
                    </button>

                    <button type="button" class="btn btn-ghost btn-sm btn-block opacity-60"
                        @click="showRemoteForm = true">
                        {{ $t('setup.useRemoteServer') }}
                    </button>
                </div>

                <!-- Step 1b: Remote Connection Form -->
                <form v-if="currentStep === 1 && !(isLocalMode && !showRemoteForm)"
                    @submit.prevent="handleConnectionSubmit" class="space-y-6 animate-fade-in">
                    <!-- 本地模式下显式切来远程，给个返回入口 -->
                    <button v-if="isLocalMode" type="button" class="btn btn-ghost btn-sm opacity-60"
                        @click="showRemoteForm = false">
                        ← {{ $t('setup.useLocalServer') }}
                    </button>

                    <!-- Gateway URL -->
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend text-sm font-medium">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"
                                stroke="currentColor" class="w-4 h-4 inline mr-1">
                                <path stroke-linecap="round" stroke-linejoin="round"
                                    d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z" />
                            </svg>
                            {{ $t('setup.gatewayUrl') }}
                        </legend>
                        <input v-model="apiBaseUrl" type="text" class="input w-full focus:input-primary transition-all"
                            placeholder="http://localhost:18789" />
                        <p class="label text-xs opacity-60">{{ $t('setup.gatewayUrlHint') }}</p>
                    </fieldset>

                    <!-- Auth Token -->
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend text-sm font-medium">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"
                                stroke="currentColor" class="w-4 h-4 inline mr-1">
                                <path stroke-linecap="round" stroke-linejoin="round"
                                    d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
                            </svg>
                            {{ $t('setup.token') }}
                        </legend>
                        <div class="relative">
                            <input v-model="authToken" :type="showPassword ? 'text' : 'password'"
                                class="input w-full pr-12 focus:input-primary transition-all"
                                :placeholder="$t('setup.enterTokenPlaceholder')" />
                            <button type="button" @click="showPassword = !showPassword"
                                class="absolute right-3 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs btn-circle">
                                <EyeSlashIcon v-if="showPassword" class="h-4 w-4" />
                                <EyeIcon v-else class="h-4 w-4" />
                            </button>
                        </div>
                        <p class="label text-xs opacity-60">{{ $t('setup.tokenDesc') }}</p>
                    </fieldset>

                    <!-- Server Name -->
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend text-sm font-medium">
                            <ServerIcon class="w-4 h-4 inline mr-1" />
                            {{ $t('gateway.serverName') }}
                        </legend>
                        <input v-model="gatewayName" type="text" class="input w-full focus:input-primary transition-all" />
                        <p class="label text-xs opacity-60">{{ $t('gateway.serverNamePlaceholder') }}</p>
                    </fieldset>

                    <button type="submit"
                        class="btn btn-primary btn-block gap-2 h-12 text-base shadow-lg hover:shadow-primary/25 transition-all"
                        :disabled="isLoading">
                        <span v-if="isLoading" class="loading loading-spinner loading-sm"></span>
                        <template v-else>
                            {{ $t('setup.startUsing') }}
                            <ArrowRightIcon class="h-5 w-5" />
                        </template>
                    </button>
                </form>

                <!-- Step 2: Model Configuration -->
                <div v-if="currentStep === 2" class="space-y-6 animate-fade-in">
                    <p class="text-sm opacity-70 text-center">{{ $t('setup.modelStep.description') }}</p>

                    <!-- Provider -->
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend text-sm font-medium">
                            <CubeIcon class="w-4 h-4 inline mr-1" />
                            {{ $t('setup.modelStep.providerId') }}
                        </legend>
                        <select v-model="modelProviderId" class="select w-full focus:select-primary transition-all">
                            <option disabled value="">{{ $t('setup.modelStep.selectProvider') }}</option>
                            <option v-for="opt in providerOptions" :key="opt.id" :value="opt.id">
                                {{ opt.name }}
                            </option>
                        </select>
                        <div v-if="modelProviderId === 'custom'" class="mt-2 animate-fade-in">
                            <input v-model="customProviderId" type="text" class="input w-full focus:input-primary"
                                :placeholder="$t('setup.modelStep.customProvider')" />
                        </div>
                    </fieldset>

                    <!-- Base URL -->
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend text-sm font-medium">
                            <GlobeAltIcon class="w-4 h-4 inline mr-1" />
                            {{ $t('setup.modelStep.baseUrl') }}
                        </legend>
                        <input v-model="modelBaseUrl" type="text"
                            class="input w-full focus:input-primary transition-all"
                            :placeholder="$t('setup.modelStep.baseUrl')" />
                    </fieldset>

                    <!-- API Key -->
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend text-sm font-medium">
                            <KeyIcon class="w-4 h-4 inline mr-1" />
                            {{ $t('setup.modelStep.apiKey') }}
                        </legend>
                        <div class="relative">
                            <input v-model="modelApiKey" :type="showPassword ? 'text' : 'password'"
                                class="input w-full pr-12 focus:input-primary transition-all" placeholder="sk-..." />
                            <button type="button" @click="showPassword = !showPassword"
                                class="absolute right-3 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs btn-circle">
                                <EyeSlashIcon v-if="showPassword" class="h-4 w-4" />
                                <EyeIcon v-else class="h-4 w-4" />
                            </button>
                        </div>
                    </fieldset>

                    <button @click="handleModelSubmit"
                        class="btn btn-primary btn-block h-12 shadow-lg hover:shadow-primary/25 transition-all"
                        :disabled="modelIsSubmitting">
                        <span v-if="modelIsSubmitting" class="loading loading-spinner loading-sm"></span>
                        {{ $t('setup.modelStep.next') }}
                    </button>
                </div>

                <!-- Step 3: Agent Creation -->
                <div v-if="currentStep === 3" class="space-y-6 animate-fade-in">
                    <p class="text-sm opacity-70 text-center">{{ $t('setup.agentStep.description') }}</p>

                    <!-- Avatar Uploader (Centered) -->
                    <div class="flex flex-col items-center gap-6">
                        <div class="relative group cursor-pointer" @click="triggerFileInput">
                            <div
                                class="avatar placeholder ring-4 ring-base-200 ring-offset-2 ring-offset-base-100 rounded-full transition-all duration-300 group-hover:ring-primary/50 group-hover:shadow-lg">
                                <div
                                    class="bg-neutral text-neutral-content rounded-full w-32 h-32 shadow-inner overflow-hidden flex items-center justify-center">
                                    <img v-if="avatarPreview" :src="avatarPreview"
                                        class="object-cover w-full h-full transition-transform duration-500 group-hover:scale-105" />
                                    <span v-else class="text-6xl select-none animate-pulse-slow">🤖</span>
                                </div>
                            </div>

                            <!-- Overlay -->
                            <div
                                class="absolute inset-0 bg-black/40 rounded-full opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition-opacity duration-300 text-white gap-2">
                                <PhotoIcon class="w-8 h-8" />
                                <span class="text-xs font-bold uppercase tracking-wider">{{
                                    $t('setup.agentStep.uploadAvatar') ||
                                    'Upload' }}</span>
                            </div>

                            <input ref="fileInput" type="file" accept="image/*" class="hidden"
                                @change="handleFileChange" />
                        </div>
                    </div>

                    <!-- Identity Fields -->
                    <fieldset class="fieldset">
                        <legend class="fieldset-legend text-sm font-medium">
                            <SparklesIcon class="w-4 h-4 inline mr-1" />
                            {{ $t('setup.agentStep.name') }}
                        </legend>
                        <input v-model="agentName" type="text" class="input w-full focus:input-primary transition-all"
                            :placeholder="$t('setup.agentStep.namePlaceholder')" />
                    </fieldset>

                    <button @click="handleAgentSubmit"
                        class="btn btn-primary btn-block h-12 text-base shadow-lg hover:shadow-primary/25 transition-all"
                        :disabled="agentIsSubmitting">
                        <span v-if="agentIsSubmitting" class="loading loading-spinner loading-sm"></span>
                        {{ $t('setup.agentStep.finish') }}
                    </button>
                </div>


            </div>
        </div>
    </div>
</template>

<style scoped>
@keyframes fade-in {
    from {
        opacity: 0;
        transform: translateY(10px);
    }

    to {
        opacity: 1;
        transform: translateY(0);
    }
}

.animate-fade-in {
    animation: fade-in 0.3s ease-out forwards;
}

.animate-pulse-slow {
    animation: pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes pulse {

    0%,
    100% {
        opacity: 1;
    }

    50% {
        opacity: .7;
    }
}
</style>
