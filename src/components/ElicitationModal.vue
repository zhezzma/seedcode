<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useElicitation } from '../composables/useElicitation'
import { useToast } from '../composables/useToast'
import { useI18n } from 'vue-i18n'

const elicit = useElicitation()
const toast = useToast()
const { t } = useI18n()

const currentRequest = computed(() => {
    return elicit.queue.length > 0 ? elicit.queue[0] : null
})

// ─── JSON Schema 解析 ──────────────────────────────────────────

interface SchemaProperty {
    key: string
    type: 'string' | 'number' | 'integer' | 'boolean' | 'unknown'
    title?: string
    description?: string
    enum?: unknown[]
    default?: unknown
    required: boolean
}

const properties = computed<SchemaProperty[]>(() => {
    const req = currentRequest.value
    if (!req) return []
    const schema = req.requestedSchema as Record<string, unknown> | undefined
    if (!schema || typeof schema !== 'object') return []
    // 顶层 type 应为 "object"；宽松处理——有 properties 就渲染
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined
    if (!props || typeof props !== 'object') return []
    const requiredList = Array.isArray(schema.required) ? schema.required as string[] : []
    return Object.entries(props).map(([key, def]) => ({
        key,
        type: (def.type === 'string' || def.type === 'number' || def.type === 'integer' || def.type === 'boolean')
            ? def.type
            : 'unknown',
        title: typeof def.title === 'string' ? def.title : undefined,
        description: typeof def.description === 'string' ? def.description : undefined,
        enum: Array.isArray(def.enum) ? def.enum : undefined,
        default: def.default,
        required: requiredList.includes(key),
    }))
})

// 表单值
const formValues = reactive<Record<string, unknown>>({})

// 初始化/重置表单值
watch(currentRequest, (newReq) => {
    // 清空旧值
    for (const key of Object.keys(formValues)) {
        delete formValues[key]
    }
    if (!newReq) return
    // 填入默认值
    for (const prop of properties.value) {
        if (prop.default !== undefined) {
            formValues[prop.key] = prop.default
        } else if (prop.type === 'boolean') {
            formValues[prop.key] = false
        } else if (prop.type === 'number' || prop.type === 'integer') {
            formValues[prop.key] = undefined
        } else {
            formValues[prop.key] = ''
        }
    }
}, { immediate: true })

// ─── 倒计时 ────────────────────────────────────────────────────

const timeLeft = ref<string>('')
let timer: number | null = null

const updateTime = () => {
    if (!currentRequest.value) return
    const ms = currentRequest.value.timeout - Date.now()
    if (ms <= 0) {
        timeLeft.value = t('elicitation.expired')
    } else {
        const mins = Math.floor(ms / 60000)
        const secs = Math.ceil((ms % 60000) / 1000)
        timeLeft.value = mins > 0
            ? t('elicitation.expiresInMin', { m: mins, s: secs })
            : t('elicitation.expiresIn', { s: secs })
    }
}

onMounted(() => {
    timer = window.setInterval(updateTime, 1000)
    updateTime()
})

onUnmounted(() => {
    if (timer) clearInterval(timer)
})

// ─── 应答 ──────────────────────────────────────────────────────

const handleAccept = async () => {
    if (!currentRequest.value) return
    // 必填校验：空值阻止提交（不塞 undefined——JSON.stringify 会静默丢字段）
    for (const prop of properties.value) {
        if (!prop.required) continue
        const value = formValues[prop.key]
        if (prop.type === 'number' || prop.type === 'integer') {
            if (value === '' || value === undefined || value === null) {
                toast.error(t('elicitation.requiredMissing', { field: prop.title || prop.key }))
                return
            }
        } else if (prop.type === 'string' || prop.type === 'unknown') {
            if (value === '' || value === undefined || value === null) {
                toast.error(t('elicitation.requiredMissing', { field: prop.title || prop.key }))
                return
            }
        }
    }
    // 收集表单值：空值选填 number 字段跳过不下发；string 空串原样下发
    const content: Record<string, unknown> = {}
    for (const prop of properties.value) {
        const value = formValues[prop.key]
        if (prop.type === 'number' || prop.type === 'integer') {
            if (value === '' || value === undefined || value === null) continue
            const num = prop.type === 'integer' ? Math.trunc(Number(value)) : Number(value)
            if (Number.isNaN(num)) continue
            content[prop.key] = num
        } else if (prop.type === 'boolean') {
            content[prop.key] = Boolean(value)
        } else {
            content[prop.key] = value ?? ''
        }
    }
    await doResolve({ action: 'accept', content })
}

const handleDecline = async () => {
    await doResolve({ action: 'decline' })
}

const handleCancel = async () => {
    await doResolve({ action: 'cancel' })
}

const doResolve = async (value: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) => {
    if (!currentRequest.value) return
    try {
        const res: any = await elicit.resolveRequest(currentRequest.value.id, value)
        if (res && res.ok === false) {
            throw new Error(res.error?.message || 'Unknown error')
        }
    } catch (e: any) {
        console.error('Failed to resolve elicitation request', e)
        toast.error(`Error: ${e.message || String(e)}`)
    }
}
</script>

<template>
    <dialog v-if="currentRequest" class="modal modal-open z-[9999]">
        <div class="modal-backdrop"></div>
        <div class="row-start-1 col-start-1 bg-base-100 rounded-lg shadow-xl p-6 w-full max-w-lg border border-base-300 max-h-[90vh] overflow-y-auto scrollbar-thin scrollbar-thumb-base-300 scrollbar-track-transparent">
            <div class="mb-4">
                <h3 class="text-lg font-bold">{{
                    currentRequest.serverId
                        ? $t('elicitation.titleWithServer', { server: currentRequest.serverId })
                        : $t('elicitation.title')
                }}</h3>
                <p class="text-sm text-base-content/60">{{ timeLeft }}</p>
            </div>

            <!-- 服务器消息 -->
            <div v-if="currentRequest.message"
                class="bg-base-200/50 p-4 rounded-md text-sm break-all mb-6 border border-base-300 whitespace-pre-wrap">
                {{ currentRequest.message }}
            </div>

            <!-- 动态表单 -->
            <div v-if="properties.length > 0" class="space-y-4 mb-6">
                <div v-for="prop in properties" :key="prop.key">
                    <label class="block text-sm font-medium mb-1">
                        {{ prop.title || prop.key }}
                        <span v-if="prop.required" class="text-error">*</span>
                    </label>
                    <p v-if="prop.description" class="text-xs text-base-content/50 mb-1">{{ prop.description }}</p>

                    <!-- enum 下拉 -->
                    <select v-if="prop.enum"
                        v-model="formValues[prop.key]"
                        class="select select-bordered w-full">
                        <option value="" disabled>{{ $t('elicitation.selectPlaceholder') }}</option>
                        <option v-for="opt in prop.enum" :key="String(opt)" :value="opt">{{ opt }}</option>
                    </select>

                    <!-- boolean 开关 -->
                    <label v-else-if="prop.type === 'boolean'" class="cursor-pointer">
                        <input type="checkbox"
                            v-model="formValues[prop.key]"
                            class="checkbox checkbox-bordered" />
                        <span class="ml-2 text-sm">{{ formValues[prop.key] ? $t('common.yes') : $t('common.no') }}</span>
                    </label>

                    <!-- number/integer -->
                    <input v-else-if="prop.type === 'number' || prop.type === 'integer'"
                        v-model="formValues[prop.key]"
                        type="number"
                        class="input input-bordered w-full"
                        :step="prop.type === 'integer' ? 1 : 'any'" />

                    <!-- string（含未知类型回退） -->
                    <input v-else
                        v-model="formValues[prop.key]"
                        type="text"
                        class="input input-bordered w-full" />
                </div>
            </div>

            <!-- 无 schema 属性时提示 -->
            <div v-else class="text-sm text-base-content/60 mb-6">
                {{ $t('elicitation.noFields') }}
            </div>

            <!-- 操作按钮 -->
            <div class="flex gap-3">
                <button @click="handleAccept" class="btn btn-primary text-white flex-1">
                    {{ $t('elicitation.accept') }}
                </button>
                <button @click="handleDecline" class="btn btn-outline flex-1">
                    {{ $t('elicitation.decline') }}
                </button>
                <button @click="handleCancel" class="btn btn-ghost flex-1">
                    {{ $t('elicitation.cancel') }}
                </button>
            </div>
        </div>
    </dialog>
</template>
