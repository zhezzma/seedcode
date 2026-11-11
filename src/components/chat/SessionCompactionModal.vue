<script setup lang="ts">
/**
 * 会话级压缩设置弹窗（pi-durable 1.5.1 AgentState.compaction）。
 *
 * 语义对齐服务端 GET/POST /api/chat/:sessionId/compaction：
 * - 「跟随智能体」= compaction: null（清除覆盖，回落 agent/harness 级）；
 * - 「本会话覆盖」= 部分字段对象：enabled + 三个 token 计数；留空字段不写入，
 *   继续跟随智能体设置（上游逐字段解析序：会话字段 > harness 默认）。
 * modelOverrides（按模型覆盖）首版不暴露——服务端支持，但面向的例外场景
 * （本会话关压缩/调保留窗口）不需要它；与 agent 级 UI（AgentOverview）口径一致。
 * 打开时 GET 回显；保存 POST，服务端 400 校验文案直接 toast（宁拒不吞同源）。
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '../../composables/useToast'
import { apiGet, apiPost } from '../../composables/api-client'

/** 服务端 CompactionSettings 的 UI 暴露子集（pi-durable 1.5.1；modelOverrides 首版不进 UI）。 */
interface SessionCompaction {
    enabled?: boolean
    reserveTokens?: number
    keepRecentTokens?: number
    backgroundTokens?: number
}

const props = defineProps<{
    open: boolean
    /** 会话 id（路由 key，同 /api/chat/:sessionId 的 sessionId）。 */
    sessionId: string
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

// ── 表单状态 ──
const loading = ref(false)
const saving = ref(false)
/** null = 跟随智能体；'override' = 本会话覆盖（部分字段）。 */
const mode = ref<'follow' | 'override'>('follow')
const enabled = ref(true)
/** token 计数输入：'' = 不设置该字段（跟随智能体）。 */
const reserveTokens = ref<number | ''>('')
const keepRecentTokens = ref<number | ''>('')
const backgroundTokens = ref<number | ''>('')

/** 回显请求代次：后发者覆盖先到者。同路由切会话时 ChatHeader 复用、弹窗保持
 *  打开，旧会话的 GET 若晚归不得覆盖新会话的表单值（否则保存写错目标）。 */
let echoSeq = 0

/** 数字输入合法：空（不设置）或非负安全整数（与服务端 validateCompactionSettings 同规则）。 */
function tokenInvalid(value: number | ''): boolean {
    return value !== '' && (!Number.isSafeInteger(value) || value < 0)
}
const hasInvalid = () => tokenInvalid(reserveTokens.value)
    || tokenInvalid(keepRecentTokens.value)
    || tokenInvalid(backgroundTokens.value)

/** 打开时/会话切换时回显服务端存储值（watch sessionId：同路由组件复用，
 *  sessionId 变化而弹窗未关时若不重载，表单仍是旧会话的值——保存会把
 *  A 会话的设置写进 B 会话）。 */
watch([() => props.open, () => props.sessionId], async ([open], [prevOpen]) => {
    if (!open || !props.sessionId) return
    // 打开或切换都重新回显；切会话时清空旧值，避免加载间隙显示 A 的值
    const seq = ++echoSeq
    if (prevOpen) {
        mode.value = 'follow'
        enabled.value = true
        reserveTokens.value = ''
        keepRecentTokens.value = ''
        backgroundTokens.value = ''
    }
    loading.value = true
    try {
        const res = await apiGet<{ compaction: SessionCompaction | null }>(
            `/api/chat/${encodeURIComponent(props.sessionId)}/compaction`, true,
        )
        if (seq !== echoSeq) return // 已被更新的回显取代
        const stored = res?.compaction ?? null
        mode.value = stored ? 'override' : 'follow'
        enabled.value = stored?.enabled ?? true
        reserveTokens.value = stored?.reserveTokens ?? ''
        keepRecentTokens.value = stored?.keepRecentTokens ?? ''
        backgroundTokens.value = stored?.backgroundTokens ?? ''
    } catch {
        if (seq === echoSeq) useToast().error(t('chat.compaction.loadFailed'))
    } finally {
        if (seq === echoSeq) loading.value = false
    }
})

async function save() {
    if (saving.value || hasInvalid()) return
    saving.value = true
    try {
        const compaction = mode.value === 'follow' ? null : {
            enabled: enabled.value,
            ...(reserveTokens.value !== '' ? { reserveTokens: reserveTokens.value } : {}),
            ...(keepRecentTokens.value !== '' ? { keepRecentTokens: keepRecentTokens.value } : {}),
            ...(backgroundTokens.value !== '' ? { backgroundTokens: backgroundTokens.value } : {}),
        }
        // 非 silent：服务端 400 校验文案由 api-client 统一 toast，此处不重复弹
        await apiPost(`/api/chat/${encodeURIComponent(props.sessionId)}/compaction`, { compaction })
        useToast().success(t('common.saved'))
        emit('close')
    } catch {
        // 错误已全局 toast（含 404/409 静默码由 api-client 按需弹），此处只复位保存态
    } finally {
        saving.value = false
    }
}
</script>

<template>
    <div :class="{ 'modal modal-open': open, modal: !open }" @keydown.esc.prevent="emit('close')">
        <div class="modal-box w-11/12 max-w-md">
            <h3 class="font-bold text-lg mb-1">{{ t('chat.compaction.title') }}</h3>
            <p class="text-sm text-base-content/70 mb-4">{{ t('chat.compaction.desc') }}</p>

            <div v-if="loading" class="text-sm opacity-60 py-4">{{ t('common.loading') }}…</div>
            <template v-else>
                <!-- 模式选择：跟随智能体 / 本会话覆盖 -->
                <div class="flex flex-col gap-2 mb-4">
                    <label class="label cursor-pointer justify-start gap-3 rounded-lg border px-3 py-2"
                        :class="mode === 'follow' ? 'border-primary/40 bg-primary/5' : 'border-base-300'">
                        <input type="radio" v-model="mode" value="follow" class="radio radio-primary radio-sm" />
                        <span>
                            <span class="label-text font-medium">{{ t('chat.compaction.followAgent') }}</span>
                            <span class="block text-xs text-base-content/60">{{ t('chat.compaction.followAgentHint') }}</span>
                        </span>
                    </label>
                    <label class="label cursor-pointer justify-start gap-3 rounded-lg border px-3 py-2"
                        :class="mode === 'override' ? 'border-primary/40 bg-primary/5' : 'border-base-300'">
                        <input type="radio" v-model="mode" value="override" class="radio radio-primary radio-sm" />
                        <span>
                            <span class="label-text font-medium">{{ t('chat.compaction.override') }}</span>
                            <span class="block text-xs text-base-content/60">{{ t('chat.compaction.overrideHint') }}</span>
                        </span>
                    </label>
                </div>

                <template v-if="mode === 'override'">
                    <div class="form-control w-full mb-3">
                        <label class="label cursor-pointer justify-start gap-4">
                            <input type="checkbox" v-model="enabled" class="toggle toggle-primary" />
                            <span class="label-text">{{ t('chat.compaction.enabled') }}</span>
                        </label>
                    </div>

                    <div class="grid grid-cols-1 gap-3">
                        <div class="form-control w-full">
                            <label class="label"><span class="label-text">{{ t('chat.compaction.reserveTokens') }}</span></label>
                            <input type="number" min="0" step="1" v-model.number="reserveTokens"
                                class="input input-bordered w-full" :class="{ 'input-error': tokenInvalid(reserveTokens) }"
                                :placeholder="t('chat.compaction.tokenPlaceholder')" />
                        </div>
                        <div class="form-control w-full">
                            <label class="label"><span class="label-text">{{ t('chat.compaction.keepRecentTokens') }}</span></label>
                            <input type="number" min="0" step="1" v-model.number="keepRecentTokens"
                                class="input input-bordered w-full" :class="{ 'input-error': tokenInvalid(keepRecentTokens) }"
                                :placeholder="t('chat.compaction.tokenPlaceholder')" />
                        </div>
                        <div class="form-control w-full">
                            <label class="label"><span class="label-text">{{ t('chat.compaction.backgroundTokens') }}</span></label>
                            <input type="number" min="0" step="1" v-model.number="backgroundTokens"
                                class="input input-bordered w-full" :class="{ 'input-error': tokenInvalid(backgroundTokens) }"
                                :placeholder="t('chat.compaction.tokenPlaceholder')" />
                            <span class="label-text-alt text-base-content/60 mt-1">{{ t('chat.compaction.backgroundHint') }}</span>
                        </div>
                    </div>
                </template>

                <div class="modal-action mt-6">
                    <button class="btn btn-ghost" @click="emit('close')">{{ t('common.cancel') }}</button>
                    <button class="btn btn-primary px-8" :disabled="saving || hasInvalid()" @click="save">
                        {{ saving ? t('common.saving') : t('common.save') }}
                    </button>
                </div>
            </template>
        </div>
        <form method="dialog" class="modal-backdrop" @click="emit('close')">
            <button>close</button>
        </form>
    </div>
</template>
