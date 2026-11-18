<script setup lang="ts">
/**
 * 模式区段（v7.4.3 从 TeamMemberFields 三段 ~140 行近逐字复制收敛而来）：
 * 标题 + 全选切换按钮 + 模式 radio 组（两态/三态自适应）+ inherit 提示 +
 * custom 卡片网格勾选（checkbox-sm，勾选数组经 update:selected 双向）。
 * 工具/技能/扩展三段共用，仅字段名/值集/条目键/空态文案之差——全走 props。
 */
import { useI18n } from 'vue-i18n'

interface ModeOption { value: string, labelKey: string }

const props = withDefaults(defineProps<{
    /** 区段标题 i18n 键 */
    titleKey: string
    /** 模式选项（两态/三态自适应渲染） */
    modes: ModeOption[]
    /** 当前模式（v-model:mode） */
    mode: string
    /** 模式 radio 行换行排布（三态窄容器挤不下时） */
    wrap?: boolean
    /** inherit 模式提示文案键（缺省=不渲染） */
    inheritHintKey?: string
    /** custom 区内提示文案键 */
    customHintKey?: string
    /** 可选条目（空数组=空态文案） */
    items: ReadonlyArray<object>
    /** 条目勾选值字段名（进 checkbox value 与 selected 数组） */
    itemValue: string
    /** 条目显示名字段名 */
    itemLabel: string
    /** 名字用等宽字体（工具名） */
    itemMono?: boolean
    /** custom 空态文案键 */
    customEmptyKey: string
    /** 勾选数组（v-model:selected） */
    selected: string[]
}>(), {})

const emit = defineEmits<{
    (e: 'update:mode', value: string): void
    (e: 'update:selected', value: string[]): void
    (e: 'toggle-all', on: boolean): void
}>()

const { t } = useI18n()

const allSelected = () => props.items.length > 0
    && props.items.every((item) => props.selected.includes(String((item as never as Record<string, unknown>)[props.itemValue])))
</script>

<template>
    <div class="form-control w-full">
        <div class="flex items-center justify-between">
            <label class="label py-1"><span class="label-text font-medium">{{ t(titleKey) }}</span></label>
            <button v-if="mode === 'custom' && items.length > 0" type="button"
                class="btn btn-ghost btn-xs text-xs" @click="emit('toggle-all', !allSelected())">
                {{ allSelected() ? t('common.deselectAll') : t('common.selectAll') }}
            </button>
        </div>
        <div :class="wrap ? 'flex flex-wrap gap-x-4 gap-y-1 mb-2' : 'flex gap-4 mb-2'">
            <label v-for="m in modes" :key="m.value" class="label cursor-pointer gap-2 justify-start py-1">
                <input type="radio" class="radio radio-primary radio-sm" :value="m.value"
                    :checked="mode === m.value" @change="emit('update:mode', m.value)" />
                <span class="label-text">{{ t(m.labelKey) }}</span>
            </label>
        </div>
        <p v-if="mode === 'inherit' && inheritHintKey" class="text-xs text-base-content/50 mb-2">
            {{ t(inheritHintKey) }}
        </p>
        <div v-if="mode === 'custom'" class="bg-base-200/50 rounded-xl border border-base-300">
            <div class="p-3 max-h-48 overflow-y-auto custom-scrollbar">
                <p v-if="customHintKey" class="text-xs text-base-content/50 mb-2">{{ t(customHintKey) }}</p>
                <div v-if="items.length === 0" class="text-center text-sm text-base-content/50 py-2">
                    {{ t(customEmptyKey) }}
                </div>
                <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label v-for="item in items" :key="String((item as never as Record<string, unknown>)[itemValue])"
                        class="label cursor-pointer justify-start gap-2 bg-base-100 p-2 rounded-lg border border-base-300 hover:border-primary/30 transition-colors">
                        <input type="checkbox" class="checkbox checkbox-sm checkbox-primary"
                            :value="String((item as never as Record<string, unknown>)[itemValue])" :checked="selected.includes(String((item as never as Record<string, unknown>)[itemValue]))"
                            @change="emit('update:selected', ($event.target as HTMLInputElement).checked
                                ? [...selected, String((item as never as Record<string, unknown>)[itemValue])]
                                : selected.filter((v: string) => v !== String((item as never as Record<string, unknown>)[itemValue])))" />
                        <span class="label-text text-xs truncate" :class="itemMono ? 'font-mono' : ''"
                            :title="String((item as never as Record<string, unknown>)[itemLabel])">{{ (item as never as Record<string, unknown>)[itemLabel] }}</span>
                    </label>
                </div>
            </div>
        </div>
    </div>
</template>
