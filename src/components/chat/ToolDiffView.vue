<script setup lang="ts">
/**
 * 工具卡内嵌 diff 视图（write/edit 特化渲染）。
 * 数据由 utils/tool-diff.ts 纯客户端自算（write 全绿新增行 / edit 的 oldText→newText
 * 行级 LCS），行样式：+ 绿底、- 红底、ctx 正常、fold（...）灰。
 * 明暗主题经 daisyUI success/error 语义色自动适配。
 */
import type { DiffLine } from '../../utils/tool-diff'

defineProps<{
    lines: DiffLine[]
}>()

/** 空行占位：whitespace-pre-wrap 的空 span 高度塌陷，用 nbsp 撑起行高 */
function displayText(text: string): string {
    return text.length > 0 ? text : '\u00A0'
}
</script>

<template>
    <div class="rounded overflow-hidden border border-base-300 font-mono text-xs leading-5 max-h-96 overflow-y-auto">
        <div v-for="(l, i) in lines" :key="i" class="flex items-start"
            :class="{
                'bg-success/15 border-l-2 border-l-success/70': l.type === 'add',
                'bg-error/10 border-l-2 border-l-error/70': l.type === 'del',
                'border-l-2 border-l-transparent': l.type === 'ctx' || l.type === 'fold',
            }">
            <!-- +/- 符号列 -->
            <span class="w-4 flex-none text-center select-none shrink-0"
                :class="l.type === 'add' ? 'text-success font-bold' : l.type === 'del' ? 'text-error font-bold' : 'text-base-content/30'">
                {{ l.type === 'add' ? '+' : l.type === 'del' ? '-' : '' }}
            </span>
            <!-- 行号列（客户端自算无真实文件行号时留空） -->
            <span class="w-9 flex-none text-right pr-2 select-none shrink-0 text-base-content/40">{{ l.lineNo ?? '' }}</span>
            <!-- 内容列 -->
            <span v-if="l.type === 'fold'" class="flex-1 whitespace-pre-wrap break-all text-base-content/40 italic">{{ l.text }}</span>
            <span v-else class="flex-1 whitespace-pre-wrap break-all text-base-content/80">{{ displayText(l.text) }}</span>
        </div>
    </div>
</template>
