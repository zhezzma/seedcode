<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDownIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { useChatState } from '../../composables/useChatState'
import type { PendingItem } from '../../utils/pending-queue'
import { parseSubagentReport } from '../../utils/subagentReport'

// 自取全局 store（扩展自包含约定：容器不传 props）
const chatState = useChatState()

const { t } = useI18n()
const expanded = ref(false)

/** 后台子代理报告回执（busy 期入队：对话流不渲染为用户气泡，仅本条可见且不可删） */
const isSubagent = (item: PendingItem) => item.source === 'subagent'

/** 报告条目预览：机器格式解析为人话（名 + 状态 + 答案摘录）；解析失败回退原文 */
const reportPreview = (item: PendingItem) => {
    const r = parseSubagentReport(item.text)
    if (!r) return item.text
    const body = r.body.replace(/\s+/g, ' ').trim()
    const excerpt = body.length > 80 ? body.slice(0, 80) + '…' : body
    return `${r.name}${r.status === 'error' ? '❌' : '✅'}：${excerpt}`
}
</script>

<template>
    <!-- busy 期间 steer/follow-up 的排队提示条：挂在会话页输入框上方，队列非空才显示 -->
    <div v-if="chatState.pendingQueue.length > 0" class="border-t border-base-300 bg-base-100/40 px-4 py-1 text-xs select-none">
        <div class="mx-auto w-full max-w-3xl">
            <button type="button"
                class="flex w-full items-center gap-1.5 py-0.5 text-left text-base-content/70 hover:text-base-content transition-colors cursor-pointer"
                @click="expanded = !expanded">
                <span aria-hidden="true">⏳</span>
                <span class="font-medium">{{ t('chat.pendingQueue.count', { n: chatState.pendingQueue.length }) }}</span>
                <span class="text-base-content/40 truncate">· {{ t('chat.pendingQueue.hint') }}</span>
                <ChevronDownIcon class="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200"
                    :class="{ 'rotate-180': expanded }" />
            </button>
            <!-- 展开后逐条预览：用户条目 ✕ 请求服务端从队列删除该条（真删除，消息不再发送），
                 按响应快照对齐本地；子代理报告回执不可删（删除即永久丢失，服务端 deleteQueued
                 同步守卫，此处仅不渲染删除钮） -->
            <div v-if="expanded" class="flex flex-col gap-1 pb-1.5 pt-1">
                <div v-for="item in chatState.pendingQueue" :key="item.id"
                    class="flex items-center gap-2 rounded-lg border border-base-300 bg-base-200 px-2 py-1">
                    <span v-if="isSubagent(item)" class="badge badge-ghost badge-xs shrink-0 font-normal border-dashed border-base-content/20">
                        {{ t('chat.pendingQueue.subagentBadge') }}
                    </span>
                    <span v-else class="badge badge-ghost badge-xs shrink-0 font-normal">
                        {{ item.mode === 'follow' ? t('chat.pendingQueue.followBadge') : t('chat.pendingQueue.steerBadge') }}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-base-content/70" :title="item.text">
                        {{ isSubagent(item) ? reportPreview(item) : item.text }}
                    </span>
                    <button v-if="!isSubagent(item)" type="button"
                        class="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/50 hover:text-error"
                        :title="t('chat.pendingQueue.removeHint')" :aria-label="t('chat.pendingQueue.removeHint')"
                        @click="chatState.removePendingItem(item.id)">
                        <XMarkIcon class="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
