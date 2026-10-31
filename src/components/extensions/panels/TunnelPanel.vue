<script setup lang="ts">
/**
 * tunnel 面板：移动端访问 + 手机扫码引导（统一面板，无模式二分）。
 * 端点契约（多 provider 并发）：GET /state → {serverPort, lanIps, providers}、
 * POST /api/extensions/:extensionId/start/:id | stop/:id。
 *
 * 结构（回应「每个 provider 视图大部分内容相同」的优雅性要求）：
 * - 局域网直连（始终可用）：常驻本机真实局域网地址二维码，与 provider 无关，
 *   手机与 PC 同网络即达，无需任何开关；
 * - 远程隧道：provider 元数据数组（TUNNEL_PROVIDER_IDS）驱动 v-for，每个 provider
 *   渲染同一份 TunnelProviderSection——状态徽标/二维码/连接断开/error/未配置指引
 *   等全部共享，差异仅来自 props（per-provider 状态与请求窗标记）与 i18n 前缀键。
 *   旧版单远程视图（视图切换 + 单份远程区块）已移除：多 provider 并发后
 *   「选中一个远程视图」不再成立，列表化让三条通道互不遮挡、各自可控。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import { apiGet, apiPost } from '../../../composables/api-client'
import { useUiSettingsStore } from '../../../stores/setting'
import { writeClipboard } from '../../../utils/clipboard'
import TunnelProviderSection from './TunnelProviderSection.vue'
import { TUNNEL_PROVIDER_IDS, type TunnelFullState, type TunnelStateEx } from './tunnel-panel-model'

const props = defineProps<{
    extensionId: string
}>()

const { t } = useI18n()
const settings = useUiSettingsStore()

const state = ref<TunnelFullState | null>(null)
/** per-provider 请求窗标记（reactive 簿记使各 provider 的按钮/徽标独立联动） */
const starting = reactive<Record<string, boolean>>({})
const stopping = reactive<Record<string, boolean>>({})
/** 多真实网卡时选中的局域网 IP */
const selectedLanIp = ref('')

const POLL_INTERVAL_MS = 3000
let pollTimer: ReturnType<typeof globalThis.setTimeout> | null = null
/**
 * per-provider 状态版本号：start/stop 写入权威结果后，在途轮询 GET 里该 provider
 * 的过期快照不得覆盖（其余 provider 的快照仍然有效，照常并入）。
 */
const stateRev: Record<string, number> = {}
const bumpRev = (id: string) => {
    stateRev[id] = (stateRev[id] ?? 0) + 1
}

const token = computed(() => settings.token?.trim() ?? '')
const tokenMissing = computed(() => !token.value)

/** 当前生效的局域网 IP：选中项已不在最新列表（网卡变化/列表清空）时回落首个，避免残留失效地址 */
const activeLanIp = computed(() => {
    const ips = state.value?.lanIps ?? []
    return ips.includes(selectedLanIp.value) ? selectedLanIp.value : ips[0] ?? ''
})

/** 局域网直连分享链接（二维码渲染目标） */
const lanShareUrl = computed(() => {
    const tok = token.value
    const ip = activeLanIp.value
    if (!tok || !ip || !state.value?.serverPort) return null
    return `http://${ip}:${state.value.serverPort}/#token=${encodeURIComponent(tok)}`
})

/** App 连接要填的局域网裸地址（无 hash）；远程地址由各 provider 区块自带，不在此处 */
const appConnectUrl = computed(() => {
    const ip = activeLanIp.value
    return ip && state.value?.serverPort ? `http://${ip}:${state.value.serverPort}` : ''
})

/**
 * per-provider 状态切片：v-for 的数据源是元数据 TUNNEL_PROVIDER_IDS（固定顺序），
 * 此处只负责按 id 从最新快照里取该 provider 的那一片（首帧未返回时为 null）
 */
function providerState(id: string): TunnelStateEx | null {
    return state.value?.providers[id] ?? null
}

/** 选中局域网 IP */
function selectLan(ip: string) {
    selectedLanIp.value = ip
}

async function refreshState(silent = true) {
    // 请求前对每个 provider 拍 rev 快照：响应只并入 rev 未变化的 provider，
    // 在途 start/stop 的 provider 保留上一帧，权威结果不被过期快照覆盖
    const revSnapshot: Record<string, number> = {}
    for (const id of TUNNEL_PROVIDER_IDS) revSnapshot[id] = stateRev[id] ?? 0
    try {
        const next = await apiGet<TunnelFullState>(`/api/extensions/${encodeURIComponent(props.extensionId)}/state`, silent)
        const prev = state.value
        const merged: Record<string, TunnelStateEx> = {}
        const ids = new Set<string>([...TUNNEL_PROVIDER_IDS, ...Object.keys(next.providers ?? {})])
        for (const id of ids) {
            const stale = (revSnapshot[id] ?? 0) !== (stateRev[id] ?? 0)
            merged[id] = stale
                ? prev?.providers[id] ?? next.providers?.[id]
                : next.providers?.[id] ?? prev?.providers[id]
        }
        state.value = {
            serverPort: next.serverPort ?? prev?.serverPort ?? 0,
            lanIps: next.lanIps ?? prev?.lanIps ?? [],
            providers: merged,
        }
        if (state.value.lanIps.length && !state.value.lanIps.includes(selectedLanIp.value)) {
            selectedLanIp.value = state.value.lanIps[0]
        }
    } catch {
        // 面板打开期间服务端暂不可达：保留上一次状态，下一轮轮询重试
    }
}

/** 连接/断开指定 provider：POST 返回的 TunnelStateEx 是该 provider 的权威结果 */
async function control(id: string, action: 'start' | 'stop') {
    const busy = action === 'start' ? starting : stopping
    if (busy[id]) return
    busy[id] = true
    bumpRev(id) // 使在途轮询 GET 中该 provider 的快照失效
    try {
        const ex = await apiPost<TunnelStateEx>(
            `/api/extensions/${encodeURIComponent(props.extensionId)}/${action}/${encodeURIComponent(id)}`)
        // 写入权威结果，同一同步块内再失效一轮：POST 窗口（秒级预热）内发出的轮询 GET
        // 携带新 rev 拦不住，写入后立即再 bump 才能确保过期快照不覆盖权威结果
        bumpRev(id)
        state.value = {
            serverPort: state.value?.serverPort ?? 0,
            lanIps: state.value?.lanIps ?? [],
            providers: { ...state.value?.providers, [id]: ex },
        }
    } catch {
        // 502（凭据缺失/预热失败）由 api-client 统一 toast；404 属幂等静默（路由只有 404/502）
    } finally {
        busy[id] = false
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

const qrDataUrl = ref('')

async function renderQr(text: string) {
    const dataUrl = await QRCode.toDataURL(text, { margin: 1, width: 320 })
    // 时序守护：await 期间分享地址可能又变了（快速切 IP/令牌就绪），旧二维码不得写入
    if (lanShareUrl.value === text) qrDataUrl.value = dataUrl
}

// 分享地址变化（IP 切换 / token 就绪 / 网卡变化）时重渲染二维码
watch(lanShareUrl, (url) => {
    if (url) {
        renderQr(url).catch((e) => console.error('[tunnel] qr render failed', e))
    } else {
        qrDataUrl.value = ''
    }
}, { immediate: true })
</script>

<template>
    <div class="text-center">
        <!-- ── 局域网直连（始终可用，无需开关，与 provider 无关）────────────── -->
        <p class="text-sm text-base-content/60 mb-4">{{ t('extensions.tunnel.lanReady') }}</p>

        <template v-if="state?.lanIps?.length && !tokenMissing">
            <!-- 地址切换：多真实网卡时并列展示（单网卡也常驻，与旧版行为一致） -->
            <div class="flex flex-wrap justify-center gap-1.5 mb-4">
                <button v-for="ip in state.lanIps" :key="ip" class="btn btn-xs"
                    :class="ip === activeLanIp ? 'btn-primary' : 'btn-outline'"
                    @click="selectLan(ip)">{{ ip }}</button>
            </div>

            <!-- 未就绪（令牌缺失/地址缺失）无码可展示：二维码、链接与提示整体隐藏 -->
            <template v-if="lanShareUrl">
                <div class="flex justify-center mb-4">
                    <img :src="qrDataUrl" :alt="t('extensions.tunnel.qrAlt')"
                        class="w-64 h-64 rounded-2xl border border-base-300 bg-white object-contain p-3" />
                </div>
                <p id="tunnel-share-url" class="text-xs text-base-content/60 mb-3 break-all select-all">{{ lanShareUrl }}</p>
                <button class="btn btn-outline btn-sm mb-2" @click="copyText(lanShareUrl, 'tunnel-share-url')">{{ t('extensions.tunnel.copyUrl') }}</button>
                <p class="text-xs text-base-content/40">{{ t('extensions.tunnel.hint') }}</p>
                <p class="text-[10px] text-base-content/30 mt-1">{{ t('extensions.tunnel.lanFirewallHint') }}</p>
            </template>
        </template>

        <!-- 首帧未返回（state 为 null）时前两个分支不命中；tokenMissing 分支仍会命中且这是有意的——
             令牌缺失与加载时序无关，无需等快照就能给出缺失指引 -->
        <div v-else-if="state && !state.lanIps?.length" class="text-sm text-warning mb-4">
            {{ t('extensions.tunnel.lanNoIp') }}
        </div>
        <div v-else-if="tokenMissing" class="text-sm text-warning mb-4">
            {{ t('extensions.tunnel.tokenMissing') }}
        </div>

        <!-- App 局域网连接信息（令牌缺失/无地址不渲染）：远程模式连接信息由各 provider 区块自带 -->
        <div v-if="appConnectUrl && !tokenMissing" class="mt-4 rounded-xl bg-base-200/40 p-3 text-left">
            <p class="text-xs font-medium mb-2 text-base-content/70">{{ t('extensions.tunnel.appConnectTitle') }}</p>
            <div class="text-xs font-mono space-y-1">
                <p class="break-all">{{ t('extensions.tunnel.urlLabel') }}<span class="select-all text-primary">{{ appConnectUrl }}</span></p>
                <p class="break-all">{{ t('extensions.tunnel.tokenLabel') }}<span class="select-all text-primary">{{ token }}</span></p>
            </div>
            <p class="text-[10px] text-base-content/40 mt-2">{{ t('extensions.tunnel.appConnectHint') }}</p>
        </div>

        <!-- ── 远程隧道：provider 列表（元数据数组驱动 v-for，共享 TunnelProviderSection）── -->
        <p class="text-sm text-base-content/60 mt-6 mb-3">{{ t('extensions.tunnel.remoteTitle') }}</p>
        <div class="space-y-3">
            <TunnelProviderSection v-for="id in TUNNEL_PROVIDER_IDS" :key="id"
                :provider-id="id"
                :state="providerState(id)"
                :starting="!!starting[id]"
                :stopping="!!stopping[id]"
                :token="token"
                @start="control(id, 'start')"
                @stop="control(id, 'stop')" />
        </div>
    </div>
</template>
