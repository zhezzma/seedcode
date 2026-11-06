<script setup lang="ts">
/**
 * A2UI ChoicePicker 组件
 * 支持 mutuallyExclusive/multipleSelection，displayStyle: checkbox/chips
 */
import { computed, inject, ref, watch, type Ref } from 'vue'
import type { A2UIComponent, DynamicString, DynamicStringList, DynamicBoolean, Action } from './types'
import { getWritePath, getByPath } from '../../composables/useA2UIState'

const props = defineProps<{ comp: A2UIComponent }>()

const resolveString = inject<(v: DynamicString) => string>('a2ui-resolve-string')!
const resolveStringList = inject<(v: DynamicStringList) => string[]>('a2ui-resolve-string-list')!
const resolveBoolean = inject<(v: DynamicBoolean) => boolean>('a2ui-resolve-boolean')!
const handleDataUpdate = inject<(path: string, value: any) => void>('a2ui-handle-data-update')!
const handleAction = inject<(action: Action, sourceComponentId: string) => void>('a2ui-handle-action')!
const dataModelRef = inject<Ref<Record<string, any>>>('a2ui-data-model')!

const label = computed(() => resolveString(props.comp.label))
const variant = computed(() => props.comp.variant || 'mutuallyExclusive')
const displayStyle = computed(() => props.comp.displayStyle || 'checkbox')
const filterable = computed(() => props.comp.filterable || false)
const options = computed(() => {
  const raw = props.comp.options
  // 静态选项数组（官方 catalog 形态）
  if (Array.isArray(raw)) {
    return raw.map((opt: any) => ({
      label: resolveString(opt.label),
      value: opt.value,
    }))
  }
  // 私有 catalog 扩展：options 可绑定数据模型路径（级联动态选项）。
  // 解析结果兼容 {label, value}[] 与 string[] 两种形态，string 项 label==value。
  if (raw && typeof raw === 'object' && 'path' in raw) {
    const items = getByPath(dataModelRef.value ?? {}, (raw as { path: string }).path)
    if (!Array.isArray(items)) return []
    return items.map((item: any) => {
      if (typeof item === 'string') return { label: item, value: item }
      if (item && typeof item === 'object') return { label: resolveString(item.label), value: item.value }
      return { label: String(item), value: String(item) }
    })
  }
  // 非法形态（缺省/非数组非 path 对象）：告警并按空选项处理，不炸渲染
  if (raw !== undefined && raw !== null) {
    console.warn('[A2UI] ChoicePicker invalid options shape, fallback to empty:', raw)
  }
  return []
})

const resolvedValue = computed(() => resolveStringList(props.comp.value))
const localSelected = ref<string[]>([...resolvedValue.value])

watch(resolvedValue, (v) => {
  localSelected.value = [...v]
}, { deep: true })

const filterText = ref('')

// select 下拉：变更事件提取选中值走 toggleOption（mutuallyExclusive 语义：单选重设）
function onSelectChange(e: Event) {
  const value = (e.target as HTMLSelectElement).value
  if (value) toggleOption(value)
}

// 级联刷新选项后旧搜索词会空滤新列表（看起来像无模型）：选项集变化时清空过滤
watch(options, (_next, _prev) => {
  filterText.value = ''
})

const filteredOptions = computed(() => {
  if (!filterable.value || !filterText.value) return options.value
  const q = filterText.value.toLowerCase()
  return options.value.filter((o: { label: string }) => o.label.toLowerCase().includes(q))
})

function toggleOption(value: string) {
  if (variant.value === 'mutuallyExclusive') {
    // 不跳过重复点击：级联失败后用户重选同一项是合法重试路径（服务端幂等）
    localSelected.value = [value]
  } else {
    const idx = localSelected.value.indexOf(value)
    if (idx >= 0) {
      localSelected.value.splice(idx, 1)
    } else {
      localSelected.value.push(value)
    }
  }
  syncValue()
}

function isSelected(value: string) {
  return localSelected.value.includes(value)
}

function syncValue() {
  const path = getWritePath(props.comp.value)
  if (path) {
    handleDataUpdate(path, [...localSelected.value])
  }
  // 私有 catalog 扩展：选中变更时触发组件 action（级联 callAgentFunction 的入口）。
  // 仅用户点击路径（toggleOption）到达这里；服务端 updateDataModel 引起的
  // watch 同步不会触发，避免级联回写循环。
  const action = props.comp.action
  if (action && props.comp.id) {
    handleAction(action, props.comp.id)
  }
}

const errorMessage = computed(() => {
  if (!props.comp.checks || props.comp.checks.length === 0) return ''
  for (const check of props.comp.checks) {
    if (!resolveBoolean(check.condition)) return check.message
  }
  return ''
})
</script>

<template>
  <div class="a2ui-choice-picker form-control w-full" :style="comp.weight != null ? { flex: comp.weight } : undefined">
    <label v-if="label" class="label">
      <span class="label-text text-sm font-medium">{{ label }}</span>
    </label>

    <!-- 搜索过滤 -->
    <input
      v-if="filterable"
      v-model="filterText"
      type="text"
      class="input input-bordered input-sm w-full mb-2 text-sm"
      placeholder="搜索..."
    />

    <!-- Chips 显示样式 -->
    <div v-if="displayStyle === 'chips'" class="flex flex-wrap gap-1.5">
      <button
        v-for="opt in filteredOptions"
        :key="opt.value"
        @click="toggleOption(opt.value)"
        class="btn btn-xs transition-all duration-150"
        :class="isSelected(opt.value) ? 'btn-primary' : 'btn-outline'"
      >
        {{ opt.label }}
      </button>
    </div>

    <!-- Select 下拉显示样式：设置表单的「默认 X」类字段用；芯片排布形似 Tab 头，
         与页面导航 Tab 混淆（用户实测误把默认提供商当 Tab 切）。仅 mutuallyExclusive——
         multipleSelection 声明 select 时落到下方 checkbox 分支（原生多选框体验差） -->
    <div v-else-if="displayStyle === 'select' && variant === 'mutuallyExclusive'">
      <select
        :value="localSelected[0] ?? ''"
        @change="onSelectChange"
        class="select select-bordered w-full select-sm text-sm font-normal"
        :class="{ 'select-error': errorMessage }"
      >
        <option v-for="opt in filteredOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
    </div>

    <!-- Checkbox / Radio 显示样式 -->
    <div v-else class="flex flex-col gap-1.5">
      <label
        v-for="opt in filteredOptions"
        :key="opt.value"
        class="flex items-center gap-2 cursor-pointer hover:bg-base-200 rounded-lg px-2 py-1 transition-colors"
      >
        <input
          v-if="variant === 'mutuallyExclusive'"
          type="radio"
          :name="comp.id || 'choice'"
          :value="opt.value"
          :checked="isSelected(opt.value)"
          @change="toggleOption(opt.value)"
          class="radio radio-sm radio-primary"
        />
        <input
          v-else
          type="checkbox"
          :checked="isSelected(opt.value)"
          @change="toggleOption(opt.value)"
          class="checkbox checkbox-sm checkbox-primary"
        />
        <span class="label-text text-sm">{{ opt.label }}</span>
      </label>
    </div>

    <!-- 错误信息 -->
    <label v-if="errorMessage" class="label pb-0">
      <span class="label-text-alt text-error font-medium">{{ errorMessage }}</span>
    </label>
  </div>
</template>
