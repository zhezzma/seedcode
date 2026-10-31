<script setup lang="ts">
/**
 * TunnelProviderSection.vue — 单个远程隧道 provider 的共享展示区块。
 *
 * 多 provider 面板的公共抽象：ssh/devbridge/cloudflare 三个视图的绝大部分内容
 * 完全相同（label+状态徽标 / URL+二维码+复制 / 连接断开按钮 / error 行 / 公网
 * 探测警告 / 退避重连 / App 连接信息），差异点全部收敛为：
 *   - props：per-provider 状态切片与请求窗标记（starting/stopping）；
 *   - i18n 前缀键 `extensions.tunnel.providers.<id>.*`：label、状态文案、
 *     未配置指引、hint、verifyFailed 等可本地化文案。
 * 模板只有这一份——新增 provider 不新增任何模板/逻辑分支。
 *
 * 二维码 hash 协议与局域网直连一致：`${url}/#token=<token>`，手机首开由
 * seedcode 的 tunnel-hash 引导逻辑自动配置令牌。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import { writeClipboard } from '../../../utils/clipboard'
import type { TunnelStateEx } from './tunnel-panel-model'

const props = defineProps<{
    /** provider 机器标识（同时驱动 i18n 前缀键与元素 id 唯一化） */
    providerId: string
    /** 该 provider 的最新状态切片（首帧未返回时为 null，仅渲染头行徽标） */
    state: TunnelStateEx | null
    /** 该 provider 的 start 请求窗（POST 在途） */
    starting: boolean
    /** 该 provider 的 stop 请求窗（POST 在途） */
    stopping: boolean
    /** 全局访问令牌（来自 settings store，由父组件下发） */
    token: string
}>()

const emit = defineEmits<{
    start: []
    stop: []
}>()

const { t } = useI18n()

/** provider 前缀 i18n 键：本区块全部可本地化文案都在此前缀下 */
const prefix = computed(() => `extensions.tunnel.providers.${props.providerId}`)

const labelKey = computed(() => `${prefix.value}.label`)

/** 状态徽标文案：请求窗标记优先于状态机（连接中/断开中等过渡态不被轮询快照冲掉） */
const statusKey = computed(() => {
    if (props.starting) return `${prefix.value}.starting`
    if (props.stopping) return `${prefix.value}.stopping`
    switch (props.state?.status) {
        case 'ready': return `${prefix.value}.ready`
        case 'connecting': return `${prefix.value}.connecting`
        case 'failed': return `${prefix.value}.failed`
        default: return `${prefix.value}.idle`
    }
})

const badgeClass = computed(() => {
    if (props.starting) return 'badge-info'
    if (props.stopping) return 'badge-warning'
    switch (props.state?.status) {
        case 'ready': return 'badge-success'
        case 'connecting': return 'badge-info'
        case 'failed': return 'badge-error'
        default: return 'badge-ghost'
    }
})

/** 未配置：显示指引文案（去对应 provider 设置页），连接控件一并隐藏 */
const unconfigured = computed(() => !!props.state && !props.state.configured)

/** 对外分享链接：仅就绪且有令牌时有值（未就绪无地址可给，不展示空二维码） */
const shareUrl = computed(() => {
    const token = props.token.trim()
    const url = props.state?.url
    if (props.state?.status !== 'ready' || !url || !token) return null
    return `${url}/#token=${encodeURIComponent(token)}`
})

/** App 连接要填的裸地址（无 hash）：仅就绪后有远程地址 */
const appConnectUrl = computed(() =>
    props.state?.status === 'ready' && props.state.url ? props.state.url : '')

/** 连接按钮显隐：idle/failed（或首帧未返回）可发起连接，其余展示断开 */
const canStart = computed(() =>
    !props.state || props.state.status === 'idle' || props.state.status === 'failed')

/** 元素 id 按 provider 唯一化：剪贴板失败时退化选中文本的锚点不串行 */
const urlElementId = computed(() => `tunnel-share-url-${props.providerId}`)

const qrDataUrl = ref('')

async function renderQr(text: string) {
    const dataUrl = await QRCode.toDataURL(text, { margin: 1, width: 320 })
    // 时序守护：await 期间分享地址可能又变了（状态翻转/令牌更新），旧二维码不得写入
    if (shareUrl.value === text) qrDataUrl.value = dataUrl
}

// 分享地址变化（就绪/断开/令牌更新）时重渲染二维码；无地址清空，不留旧码
watch(shareUrl, (url) => {
    if (url) {
        renderQr(url).catch((e) => console.error(`[tunnel:${props.providerId}] qr render failed`, e))
    } else {
        qrDataUrl.value = ''
    }
}, { immediate: true })

async function copyShareUrl() {
    const url = shareUrl.value
    if (!url) return
    try {
        await writeClipboard(url)
    } catch {
        // 剪贴板权限失败时退化选中文本，由用户手动复制
        const el = document.getElementById(urlElementId.value)
        if (el) globalThis.getSelection()?.selectAllChildren(el)
    }
}
</script>

<template>
    <div class="rounded-xl bg-base-200/40 p-3 text-left">
        <!-- 头行：provider 名 + 状态徽标（三 provider 共用同一结构，差异全在 i18n 前缀） -->
        <div class="flex items-center justify-between gap-2 mb-1">
            <p class="text-xs font-medium text-base-content/70">{{ t(labelKey) }}</p>
            <span class="badge badge-sm shrink-0" :class="badgeClass">{{ t(statusKey) }}</span>
        </div>

        <!-- state 为 null（首帧未返回）时只渲染头行：不得把「尚未加载」渲染成任何状态结论 -->
        <!-- 未配置：指引去对应 provider 设置页，控件与二维码一并隐藏 -->
        <p v-if="unconfigured" class="text-xs text-warning mt-2">
            {{ t(`${prefix}.unconfigured`) }}
        </p>

        <template v-else-if="state">
            <!-- 失败原因 / 公网探测警告（各 provider 自有文案）/ 退避重连 -->
            <div v-if="state.status === 'failed' && state.error"
                class="alert alert-error text-xs my-2 break-words">{{ state.error }}</div>
            <div v-if="state.status === 'ready' && state.urlVerified === false"
                class="alert alert-warning text-xs my-2 whitespace-pre-line">
                {{ t(`${prefix}.verifyFailed`) }}</div>
            <p v-if="state.status === 'failed' && state.pendingReconnect > 0"
                class="text-xs text-base-content/40 my-1">
                {{ t(`${prefix}.reconnecting`, { n: state.pendingReconnect }) }}</p>

            <!-- 连接中动画 -->
            <div v-if="state.status === 'connecting' || starting" class="py-3 text-center">
                <span class="loading loading-spinner loading-md"></span>
            </div>

            <!-- 就绪：二维码 + 链接 + App 连接信息（未就绪/无令牌不渲染空二维码） -->
            <template v-if="shareUrl">
                <div class="flex justify-center my-3">
                    <img :src="qrDataUrl" :alt="t('extensions.tunnel.qrAlt')"
                        class="w-56 h-56 rounded-2xl border border-base-300 bg-white object-contain p-3" />
                </div>
                <p :id="urlElementId" class="text-xs text-base-content/60 mb-2 break-all select-all">{{ shareUrl }}</p>
                <button class="btn btn-outline btn-sm mb-2" @click="copyShareUrl">{{ t('extensions.tunnel.copyUrl') }}</button>
                <p class="text-xs text-base-content/40">{{ t('extensions.tunnel.hint') }}</p>

                <!-- App 远程模式连接信息：地址随本 provider 就绪地址，文案与局域网区共用 -->
                <div class="mt-3 rounded-lg bg-base-100/60 p-2">
                    <p class="text-xs font-medium mb-1 text-base-content/70">{{ t('extensions.tunnel.appConnectTitle') }}</p>
                    <div class="text-xs font-mono space-y-1">
                        <p class="break-all">{{ t('extensions.tunnel.urlLabel') }}<span class="select-all text-primary">{{ appConnectUrl }}</span></p>
                        <p class="break-all">{{ t('extensions.tunnel.tokenLabel') }}<span class="select-all text-primary">{{ token }}</span></p>
                    </div>
                    <p class="text-[10px] text-base-content/40 mt-1">{{ t('extensions.tunnel.appConnectHint') }}</p>
                </div>
            </template>

            <!-- 就绪但全局令牌缺失：有地址无令牌，二维码/链接无从生成 -->
            <p v-else-if="state.status === 'ready' && !token.trim()" class="text-xs text-warning my-2">
                {{ t('extensions.tunnel.tokenMissing') }}
            </p>

            <!-- 连接/断开控制（按钮文案三 provider 共用） -->
            <div class="modal-action justify-center mt-3">
                <button v-if="canStart" class="btn btn-primary btn-sm" :disabled="starting" @click="emit('start')">
                    <span v-if="starting" class="loading loading-spinner loading-xs"></span>
                    {{ t('extensions.tunnel.start') }}
                </button>
                <button v-else class="btn btn-ghost btn-sm" :disabled="stopping" @click="emit('stop')">
                    <span v-if="stopping" class="loading loading-spinner loading-xs"></span>
                    {{ t('extensions.tunnel.stop') }}
                </button>
            </div>
            <p class="text-[10px] text-base-content/30 mt-2">{{ t(`${prefix}.hint`) }}</p>
        </template>
    </div>
</template>
