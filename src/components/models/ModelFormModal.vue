<script setup lang="ts">
import { reactive, computed, watch } from 'vue'
import { AvailableModel, ThinkingLevelKey, ThinkingLevelMap } from '../../composables/useModelsState'
import { createDefaultModelFormData, applyModelFormData, buildModelCostForSave } from './model-form-state'

const props = defineProps<{
    show: boolean
    mode: 'add' | 'edit'
    providerId: string
    initialData?: AvailableModel
    custom?: boolean
}>()

const emit = defineEmits<{
    (e: 'close'): void
    (e: 'save', model: AvailableModel): void
}>()

const formData = reactive(createDefaultModelFormData())

// ── Thinking Level Map 编辑模型 ──
// 每个等级一行，一个三态选择器 + 一个值输入框：
//   default  → 不写进 map（用 provider 默认映射）
//   custom   → 显示右侧输入框，存字符串
//   disabled → 存 null（不支持）
// pi 对 xhigh/max 的“省略=不支持”在三态下无需特例：用户选 default 即省略（不支持），
// 要启用 xhigh/max 就选 custom 并填值。序列化与反序列化完全对称。
const THINKING_LEVELS: ThinkingLevelKey[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

type ThinkingMode = 'default' | 'custom' | 'disabled'

interface ThinkingRow {
    key: ThinkingLevelKey
    mode: ThinkingMode
    value: string
}

const thinkingRows = reactive<ThinkingRow[]>(
    THINKING_LEVELS.map((key) => ({ key, mode: 'default' as ThinkingMode, value: '' })),
)

function rebuildThinkingRows(map: ThinkingLevelMap | undefined) {
    for (const row of thinkingRows) {
        const raw = map?.[row.key]
        if (raw === null) {
            row.mode = 'disabled'
            row.value = ''
        } else if (typeof raw === 'string') {
            row.mode = 'custom'
            row.value = raw
        } else {
            // 字段缺省 → default（用 provider 默认映射）。
            row.mode = 'default'
            row.value = ''
        }
    }
}

function serializeThinkingMap(): ThinkingLevelMap {
    const map: ThinkingLevelMap = {}
    for (const row of thinkingRows) {
        if (row.mode === 'disabled') {
            map[row.key] = null
        } else if (row.mode === 'custom') {
            const v = row.value.trim()
            // custom 但未填值视为无意义，退回 default（省略），避免写出空字符串。
            if (v) map[row.key] = v
        }
        // default → 省略，不写进 map。
    }
    return map
}

watch(() => props.show, (newVal) => {
    if (!newVal) return

    if (props.mode === 'edit') {
        applyModelFormData(formData, props.initialData)
    } else {
        applyModelFormData(formData)
    }
    rebuildThinkingRows(formData.thinkingLevelMap)
})

const hasSelectedInput = computed(() => formData.input.length > 0)

const isFormValid = computed(() => {
    return formData.id.trim().length > 0
        && formData.name.trim().length > 0
        && hasSelectedInput.value
})

const isReadonly = computed(() => props.mode === 'edit' && props.custom === false)

const toggleInputType = (type: 'text' | 'image', enabled: boolean) => {
    const next = new Set(formData.input)

    if (enabled) {
        next.add(type)
    } else {
        next.delete(type)
    }

    formData.input = Array.from(next)
}

const handleClose = () => {
    emit('close')
}

const handleSubmit = () => {
    if (!isFormValid.value) return

    const model: AvailableModel = {
        id: formData.id,
        name: formData.name,
        type: formData.type,
        contextWindow: formData.contextWindow,
        maxTokens: formData.maxTokens,
        // 表单只编辑基础费率；tiers 不展示但必须随 cost 整对象 PATCH 带回，否则服务端会丢掉阶梯价。
        cost: buildModelCostForSave(formData.cost),
        reasoning: formData.reasoning,
        input: [...formData.input],
    }

    // thinkingLevelMap 处理：
    //  - reasoning 且 map 非空 → 写入。
    //  - 其余情况（非 reasoning / map 空）：编辑已有模型时显式发 null，让后端删掉旧值
    //    （后端 PATCH 是 merge 语义，省略无法清除）；新增模型无旧值可删，省略即可。
    if (formData.reasoning) {
        const map = serializeThinkingMap()
        if (Object.keys(map).length > 0) model.thinkingLevelMap = map
        else if (props.mode === 'edit') model.thinkingLevelMap = null
    } else if (props.mode === 'edit') {
        model.thinkingLevelMap = null
    }

    emit('save', model)
}
</script>

<template>
    <dialog :class="{ 'modal modal-open': show, 'modal': !show }">
        <div class="modal-box w-11/12 max-w-3xl">
            <h3 class="font-bold text-lg mb-6">
                {{ mode === 'add' ? $t('model.addTitle') : $t('model.editTitle') }}
            </h3>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <!-- Basic Info -->
                <div class="form-control md:col-span-2">
                    <label class="label"><span class="label-text">{{ $t('model.id') }} <span
                                class="text-error">*</span></span></label>
                    <input v-model="formData.id" type="text" placeholder="e.g. gpt-4-turbo"
                        class="input input-bordered w-full font-mono" :disabled="mode === 'edit' || isReadonly" />
                </div>

                <div class="form-control md:col-span-2">
                    <label class="label"><span class="label-text">{{ $t('model.name') }} <span
                                class="text-error">*</span></span></label>
                    <input v-model="formData.name" type="text" placeholder="e.g. GPT-4 Turbo"
                        class="input input-bordered w-full" :disabled="isReadonly" />
                </div>

                <!-- Parameters -->
                <div class="form-control">
                    <label class="label"><span class="label-text">{{ $t('model.contextWindow') }}</span></label>
                    <input v-model.number="formData.contextWindow" type="number" class="input input-bordered w-full"
                        :disabled="isReadonly" />
                </div>

                <div class="form-control">
                    <label class="label"><span class="label-text">{{ $t('model.maxOutputTokens') }}</span></label>
                    <input v-model.number="formData.maxTokens" type="number" class="input input-bordered w-full"
                        :disabled="isReadonly" />
                </div>

                <!-- Cost -->
                <div class="form-control">
                    <label class="label"><span class="label-text">{{ $t('model.inputCost') }}</span></label>
                    <input v-model.number="formData.cost!.input" type="number" step="0.01"
                        class="input input-bordered w-full" :disabled="isReadonly" />
                </div>

                <div class="form-control">
                    <label class="label"><span class="label-text">{{ $t('model.outputCost') }}</span></label>
                    <input v-model.number="formData.cost!.output" type="number" step="0.01"
                        class="input input-bordered w-full" :disabled="isReadonly" />
                </div>

                <!-- Model Type -->
                <div class="form-control md:col-span-2">
                    <label class="label">
                        <span class="label-text">{{ $t('model.type.label') }}</span>
                    </label>
                    <select v-model="formData.type" class="select select-bordered w-full" :disabled="isReadonly">
                        <option value="chat">{{ $t('model.type.chat') }}</option>
                        <option value="image">{{ $t('model.type.image') }}</option>
                        <option value="classifier">{{ $t('model.type.classifier') }}</option>
                    </select>
                    <p class="text-xs text-base-content/50 mt-1">{{ $t('model.type.hint') }}</p>
                </div>

                <!-- Capabilities -->
                <div class="form-control md:col-span-2">
                    <label class="label cursor-pointer justify-start gap-4">
                        <span class="label-text">{{ $t('model.reasoning') }}</span>
                        <input v-model="formData.reasoning" type="checkbox" class="checkbox" :disabled="isReadonly" />
                    </label>
                </div>

                <div class="form-control md:col-span-2">
                    <label class="label">
                        <span class="label-text">{{ $t('model.inputCapabilities') }}</span>
                    </label>
                    <div class="flex flex-wrap gap-6">
                        <label class="label cursor-pointer justify-start gap-3 py-0">
                            <span class="label-text">{{ $t('model.inputText') }}</span>
                            <input
                                :checked="formData.input.includes('text')"
                                type="checkbox"
                                class="checkbox"
                                :disabled="isReadonly"
                                @change="toggleInputType('text', ($event.target as HTMLInputElement).checked)"
                            />
                        </label>
                        <label class="label cursor-pointer justify-start gap-3 py-0">
                            <span class="label-text">{{ $t('model.inputImage') }}</span>
                            <input
                                :checked="formData.input.includes('image')"
                                type="checkbox"
                                class="checkbox"
                                :disabled="isReadonly"
                                @change="toggleInputType('image', ($event.target as HTMLInputElement).checked)"
                            />
                        </label>
                    </div>
                </div>

                <!-- Thinking Level Map (reasoning 模型才显示) -->
                <div v-if="formData.reasoning" class="form-control md:col-span-2 mt-2">
                    <label class="label">
                        <span class="label-text font-semibold">{{ $t('model.thinking.title') }}</span>
                    </label>
                    <p class="text-xs text-base-content/60 mb-2">{{ $t('model.thinking.hint') }}</p>
                    <div class="space-y-2">
                        <div v-for="row in thinkingRows" :key="row.key"
                            class="flex items-center gap-3">
                            <span class="w-20 shrink-0 font-mono text-sm">{{ row.key }}</span>
                            <select v-model="row.mode" class="select select-bordered select-sm w-28"
                                :disabled="isReadonly">
                                <option value="default">{{ $t('model.thinking.modeDefault') }}</option>
                                <option value="custom">{{ $t('model.thinking.modeCustom') }}</option>
                                <option value="disabled">{{ $t('model.thinking.modeDisabled') }}</option>
                            </select>
                            <input v-if="row.mode === 'custom'" v-model="row.value" type="text"
                                class="input input-bordered input-sm flex-1 font-mono"
                                :placeholder="row.key === 'xhigh' || row.key === 'max' ? $t('model.thinking.xhighPlaceholder') : $t('model.thinking.valuePlaceholder')"
                                :disabled="isReadonly" />
                            <span v-else class="flex-1"></span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="modal-action">
                <button @click="handleClose" class="btn">{{ $t('common.close') }}</button>
                <button v-if="!isReadonly" @click="handleSubmit" class="btn btn-primary" :disabled="!isFormValid">
                    {{ $t('common.save') }}
                </button>
            </div>
        </div>
        <form method="dialog" class="modal-backdrop">
            <button @click="handleClose">{{ $t('common.close') }}</button>
        </form>
    </dialog>
</template>
