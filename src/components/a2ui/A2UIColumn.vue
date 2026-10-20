<script setup lang="ts">
/**
 * A2UI Column 组件 - 垂直布局
 */
import { computed, inject, type Component as VueComponent } from 'vue'
import type { A2UIComponent, ChildList } from './types'

const props = defineProps<{ comp: A2UIComponent }>()

const resolveChildren = inject<(v: ChildList) => string[]>('a2ui-resolve-children')!
const getComponentById = inject<(id: string) => A2UIComponent | undefined>('a2ui-get-component')!
const getVueComponent = inject<(name: string) => VueComponent | null>('a2ui-get-vue-component')!

const childIds = computed(() => resolveChildren(props.comp.children))

const justifyClass = computed(() => {
  const map: Record<string, string> = {
    start: 'justify-start',
    center: 'justify-center',
    end: 'justify-end',
    spaceBetween: 'justify-between',
    spaceAround: 'justify-around',
    spaceEvenly: 'justify-evenly',
    stretch: 'justify-stretch',
  }
  return map[props.comp.justify || 'start'] || 'justify-start'
})

const alignClass = computed(() => {
  const map: Record<string, string> = {
    start: 'items-start',
    center: 'items-center',
    end: 'items-end',
    stretch: 'items-stretch',
  }
  return map[props.comp.align || 'stretch'] || 'items-stretch'
})

// 可选 gap 覆写（服务端紧凑排版用）；缺省仍 gap-2，对既有面板零影响。
// 字面量映射：Tailwind JIT 不编译动态拼接的 gap-${n}
const gapClass = computed(() => {
  const map: Record<number, string> = { 0: 'gap-0', 1: 'gap-1', 2: 'gap-2', 3: 'gap-3' }
  return map[props.comp.gap ?? 2] || 'gap-2'
})
</script>

<template>
  <div
    class="a2ui-column flex flex-col"
    :class="[gapClass, justifyClass, alignClass]"
    :style="comp.weight != null ? { flex: comp.weight } : undefined"
  >
    <template v-for="childId in childIds" :key="childId">
      <component
        v-if="getComponentById(childId) && getVueComponent(getComponentById(childId)!.component)"
        :is="getVueComponent(getComponentById(childId)!.component)!"
        :comp="getComponentById(childId)!"
      />
    </template>
  </div>
</template>
