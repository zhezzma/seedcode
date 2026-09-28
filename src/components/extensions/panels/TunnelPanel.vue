<script setup lang="ts">
/**
 * tunnel 面板：移动端访问 + 手机扫码引导（统一面板，无模式二分）。
 * 端点契约：POST /api/extensions/:extensionId/start | stop、GET /state。
 *
 * - 局域网直连（始终可用）：常驻展示本机真实局域网地址二维码，手机与 PC 同网络即达，
 *   无需任何开关（服务端本就监听全部网卡）
 * - 远程隧道（外网访问）：「连接」一键完成 VPS 幂等预热 + 建立隧道；就绪后远程地址
 *   与局域网 IP 并列出现在上方切换行（像多网卡 IP 一样点选切换），二维码/链接/复制
 *   按钮随视图联动；App 连接信息与连接/断开控制仅远程模式渲染，局域网模式
 *   只保留纯净的扫码体验
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import { apiGet, apiPost } from '../../../composables/api-client'
import { useUiSettingsStore } from '../../../stores/setting'
import { writeClipboard } from '../../../utils/clipboard'

interface TunnelState {
    status: 'idle' | 'connecting' | 'ready' | 'failed'
    url: string | null
    error: string | null
    lastReadyAt: number | null
    pendingReconnect: number
    configured: boolean
    /** 公网可达性探测：true 可达 / false 不可达 / null 未探测 */
    urlVerified: boolean | null
    serverPort: number
    /** 真实局域网 IP（服务端已过滤虚拟网卡；多真实网卡时多于一个） */
    lanIps: string[]
}

const props = defineProps<{
    extensionId: string
}>()

const { t } = useI18n()
const settings = useUiSettingsStore()

const state = ref<TunnelState | null>(null)
const starting = ref(false)
const stopping = ref(false)
/** 多真实网卡时选中的局域网 IP */
const selectedLanIp = ref('')
/** 展示视图：局域网直连 / 远程隧道（远程项隧道就绪后才可选中） */
const selectedView = ref<'lan' | 'remote'>('lan')

const qrDataUrl = ref('')

const POLL_INTERVAL_MS = 3000
let pollTimer: ReturnType<typeof globalThis.setTimeout> | null = null
/** 状态版本号：start/stop 写入权威结果后，在途轮询 GET 的过期响应不得覆盖 */
let stateRev = 0

const statusKey = computed(() => {
    if (starting.value) return 'extensions.tunnel.starting'
    if (stopping.value) return 'extensions.tunnel.stopping'
    switch (state.value?.status) {
        case 'ready': return 'extensions.tunnel.ready'
        case 'connecting': return 'extensions.tunnel.connecting'
        case 'failed': return 'extensions.tunnel.failed'
        default: return 'extensions.tunnel.idle'
    }
})

/** 当前生效的局域网 IP：选中项已不在最新列表（网卡变化/列表清空）时回落首个，避免残留失效地址 */
const activeLanIp = computed(() => {
    const ips = state.value?.lanIps ?? []
    return ips.includes(selectedLanIp.value) ? selectedLanIp.value : ips[0] ?? ''
})

/** 局域网直连分享链接（默认展示；二维码渲染目标） */
const lanShareUrl = computed(() => {
    const token = settings.token?.trim()
    const ip = activeLanIp.value
    if (!token || !ip || !state.value?.serverPort) return null
    return `http://${ip}:${state.value.serverPort}/#token=${encodeURIComponent(token)}`
})

/** 远程隧道分享链接：隧道就绪后外网可用（未就绪时不展示，无地址可给） */
const remoteShareUrl = computed(() => {
    const token = settings.token?.trim()
    const url = state.value?.url
    if (!token || state.value?.status !== 'ready' || !url) return null
    return `${url}/#token=${encodeURIComponent(token)}`
})

/** 远程主机（切换 pill 标签，与局域网 IP 并列展示） */
const remoteHost = computed(() => {
    const url = state.value?.url
    if (!url) return ''
    try {
        return new URL(url).hostname
    } catch {
        return ''
    }
})

/** 当前视图的分享链接（二维码渲染目标）：远程视图用隧道地址，局域网视图用局域网地址 */
const shareUrl = computed(() =>
    selectedView.value === 'remote' ? remoteShareUrl.value : lanShareUrl.value)

/** 顶部说明随视图切换：局域网直连 / 远程隧道（未连接的远程模式也标明远程说明） */
const headerKey = computed(() =>
    selectedView.value === 'remote' ? 'extensions.tunnel.remoteTitle' : 'extensions.tunnel.lanReady')

/** 状态行显隐：远程视图就绪时说明/二维码/App 区已自证就绪，状态行纯冗余；
 *  连接中/断开中等过渡态始终显示 */
const showStatus = computed(() => {
    return starting.value || stopping.value
        || !(selectedView.value === 'remote' && state.value?.status === 'ready')
})

/** App 连接要填的裸地址（无 hash），随当前视图：
 *  局域网视图给局域网地址（App 两种模式都要填，文案两视图共用）；
 *  远程视图仅隧道就绪后有远程地址，未连接为空（App 区随之为隐）——
 *  不得回落局域网地址，远程模式下展示局域网地址是误导 */
const appConnectUrl = computed(() => {
    if (selectedView.value === 'lan') {
        const ip = activeLanIp.value
        return ip && state.value?.serverPort ? `http://${ip}:${state.value.serverPort}` : ''
    }
    return state.value?.status === 'ready' && state.value.url ? state.value.url : ''
})

const tokenMissing = computed(() => !settings.token?.trim())

/** 选中局域网 IP：同时切回局域网视图（视图与 IP 双状态） */
function selectLan(ip: string) {
    selectedView.value = 'lan'
    selectedLanIp.value = ip
}

async function refreshState(silent = true) {
    const rev = stateRev
    try {
        const next = await apiGet<TunnelState>(`/api/extensions/${encodeURIComponent(props.extensionId)}/state`, silent)
        if (rev !== stateRev) return // start/stop 已写入更权威的结果，丢弃过期响应
        state.value = next
        if (next.lanIps?.length && !next.lanIps.includes(selectedLanIp.value)) {
            selectedLanIp.value = next.lanIps[0]
        }
    } catch {
        // 面板打开期间服务端暂不可达：保留上一次状态，下一轮轮询重试
    }
}

/** 一键连接：服务端自动完成 VPS 幂等预热（已就绪则秒过）+ 建立隧道 */
async function start() {
    if (starting.value) return
    starting.value = true
    stateRev++ // 使在途轮询 GET 失效：POST 返回的权威结果不得被过期响应覆盖
    try {
        state.value = await apiPost<TunnelState>(`/api/extensions/${encodeURIComponent(props.extensionId)}/start`)
    } catch {
        // 502（凭据缺失/预热失败）由 api-client 统一 toast；apiBaseUrl 为空的同步抛错
        //（fetchWithToast 之前）无 toast——仅 setup 未完成的裸浏览器场景命中，彼时全应用不可用
    } finally {
        // POST 窗口（秒级预热）内发出的轮询 GET 携带新 rev、拦不住——写入后/失败时
        // 再失效一轮，确保权威结果不被 POST 期间的过期快照覆盖；下轮轮询拿全新状态
        stateRev++
        starting.value = false
    }
}

/** 断开：SSH 连接关闭，VPS 侧 18799 监听随之自动释放（SSH 协议行为） */
async function stop() {
    if (stopping.value) return
    stopping.value = true
    stateRev++ // 同 start：POST 返回的权威结果不得被过期响应覆盖
    try {
        state.value = await apiPost<TunnelState>(`/api/extensions/${encodeURIComponent(props.extensionId)}/stop`)
    } catch {
        // 常规错误由 api-client 统一 toast；409/404 属 SILENT_CODES 静默（服务端幂等，无需打断用户）
    } finally {
        // 同 start：失效 POST 窗口内发出的轮询 GET
        stateRev++
        stopping.value = false
    }
}

async function copyText(text: string | null, elementId?: string) {
    if (!text) return
    try {
        await writeClipboard(text)
    } catch {
        // 剪贴板权限失败时退化选中文本，由用户手动复制
        if (!elementId) return
        const el = document.getElementById(elementId)
        if (el) globalThis.getSelection()?.selectAllChildren(el)
    }
}

function schedulePoll() {
    pollTimer = globalThis.setTimeout(async () => {
        await refreshState()
        if (pollTimer !== null) schedulePoll()
    }, POLL_INTERVAL_MS)
}

onMounted(() => {
    void refreshState(false)
    schedulePoll()
})

onUnmounted(() => {
    if (pollTimer !== null) {
        globalThis.clearTimeout(pollTimer)
        pollTimer = null
    }
})

async function renderQr(text: string) {
    const dataUrl = await QRCode.toDataURL(text, { margin: 1, width: 320 })
    // 时序守护：await 期间分享地址可能又变了（切换视图/快速切 IP/状态翻转），旧二维码不得写入
    if (shareUrl.value === text) qrDataUrl.value = dataUrl
}

// 隧道断开/未就绪时不得停留在远程视图：回落局域网，避免空二维码
watch(remoteShareUrl, (url) => {
    if (!url) selectedView.value = 'lan'
})

// 分享地址变化（视图切换 / IP 切换 / token 就绪 / 网卡变化）时重渲染二维码
watch(shareUrl, (url) => {
    if (url) {
        renderQr(url).catch((e) => console.error('[tunnel] qr render failed', e))
    } else {
        qrDataUrl.value = ''
    }
}, { immediate: true })
</script>

<template>
    <div class="text-center">
        <!-- ── 局域网直连（始终可用，无需开关）────────────── -->
        <p class="text-sm text-base-content/60 mb-4">{{ t(headerKey) }}</p>

        <template v-if="state?.lanIps?.length && !tokenMissing">
            <!-- 地址切换：局域网 IP 与远程隧道并列，行本身即「局域网/远程」模式切换器；
                 远程 pill 常驻（未连接也可进入远程模式去连接隧道） -->
            <div class="flex flex-wrap justify-center gap-1.5 mb-4">
                <button v-for="ip in state.lanIps" :key="ip" class="btn btn-xs"
                    :class="selectedView === 'lan' && ip === activeLanIp ? 'btn-primary' : 'btn-outline'"
                    @click="selectLan(ip)">{{ ip }}</button>
                <button class="btn btn-xs"
                    :class="selectedView === 'remote' ? 'btn-primary' : 'btn-outline'"
                    @click="selectedView = 'remote'">{{ remoteHost || t('extensions.tunnel.remotePill') }}</button>
            </div>

            <!-- 未就绪（远程未连接/连接中）无码可展示：二维码、链接与提示整体隐藏 -->
            <template v-if="shareUrl">
                <div class="flex justify-center mb-4">
                    <img :src="qrDataUrl" :alt="t('extensions.tunnel.qrAlt')"
                        class="w-64 h-64 rounded-2xl border border-base-300 bg-white object-contain p-3" />
                </div>
                <p id="tunnel-share-url" class="text-xs text-base-content/60 mb-3 break-all select-all">{{ shareUrl }}</p>
                <button class="btn btn-outline btn-sm mb-2" @click="copyText(shareUrl, 'tunnel-share-url')">{{ t('extensions.tunnel.copyUrl') }}</button>
                <p class="text-xs text-base-content/40">{{ t('extensions.tunnel.hint') }}</p>
                <p v-if="selectedView === 'lan'" class="text-[10px] text-base-content/30 mt-1">{{ t('extensions.tunnel.lanFirewallHint') }}</p>
            </template>
        </template>

        <!-- state 为 null（首帧未返回）时三分支全部不命中：静默等待，不得把「尚未加载」渲染成「未检测到」 -->
        <div v-else-if="state && !state.lanIps?.length" class="text-sm text-warning mb-4">
            {{ t('extensions.tunnel.lanNoIp') }}
        </div>
        <div v-else-if="tokenMissing" class="text-sm text-warning mb-4">
            {{ t('extensions.tunnel.tokenMissing') }}
        </div>

        <!-- App 连接信息随视图展示对应地址（令牌缺失/无地址不渲染）：局域网视图给局域网地址，
             远程视图仅隧道就绪后给远程地址（未连接想填 App 先点「连接」，不得回落局域网地址）；
             标题/引导文案两视图共用，不作区分 -->
        <div v-if="appConnectUrl && !tokenMissing" class="mt-4 rounded-xl bg-base-200/40 p-3 text-left">
            <p class="text-xs font-medium mb-2 text-base-content/70">{{ t('extensions.tunnel.appConnectTitle') }}</p>
            <div class="text-xs font-mono space-y-1">
                <p class="break-all">{{ t('extensions.tunnel.urlLabel') }}<span class="select-all text-primary">{{ appConnectUrl }}</span></p>
                <p class="break-all">{{ t('extensions.tunnel.tokenLabel') }}<span class="select-all text-primary">{{ settings.token }}</span></p>
            </div>
            <p class="text-[10px] text-base-content/40 mt-2">{{ t('extensions.tunnel.appConnectHint') }}</p>
        </div>

        <!-- ── 远程隧道：状态/连接断开控制仅远程模式渲染；令牌缺失或未检测到
             局域网网卡时保持可见（彼时无 pill 可切，不能把连接入口藏没了）── -->
        <template v-if="selectedView === 'remote' || tokenMissing || (state && !state.lanIps?.length)">
            <p v-if="showStatus" class="text-sm text-base-content/60 mb-4">{{ t(statusKey) }}</p>

            <div v-if="state?.status === 'failed' && state.error" class="alert alert-error text-xs mb-4 break-words">
                {{ state.error }}
            </div>

            <!-- 公网探测失败警告（安全组未放行或 GatewayPorts 未生效）-->
            <div v-if="state?.status === 'ready' && state.urlVerified === false"
                class="alert alert-warning text-xs mb-4 text-left whitespace-pre-line">{{ t('extensions.tunnel.verifyFailed') }}</div>

            <p v-if="state?.status === 'failed' && state.pendingReconnect > 0" class="text-xs text-base-content/40 mt-2">
                {{ t('extensions.tunnel.reconnecting', { n: state.pendingReconnect }) }}
            </p>

            <!-- 连接中动画 -->
            <div v-if="state?.status === 'connecting' || starting" class="py-4">
                <span class="loading loading-spinner loading-lg"></span>
            </div>

            <div class="modal-action justify-center mt-4">
                <button v-if="!state || state.status === 'idle' || state.status === 'failed'"
                    class="btn btn-primary btn-sm" :disabled="starting" @click="start">
                    <span v-if="starting" class="loading loading-spinner loading-xs"></span>
                    {{ t('extensions.tunnel.start') }}
                </button>
                <button v-else class="btn btn-ghost btn-sm" :disabled="stopping" @click="stop">
                    <span v-if="stopping" class="loading loading-spinner loading-xs"></span>
                    {{ t('extensions.tunnel.stop') }}
                </button>
            </div>

            <p class="text-[10px] text-base-content/30 mt-2">{{ t('extensions.tunnel.startHint') }}</p>
        </template>
    </div>
</template>
