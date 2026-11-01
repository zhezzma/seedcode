<script setup lang="ts">
/**
 * 隧道面板 · 局域网直连区块：与 TunnelProviderSection 同构的「连接卡」。
 * 常驻本机真实局域网地址二维码——手机与 PC 同网络即达，无需任何开关。
 * IP 选择 / 二维码时序守护 / App 连接信息均内聚于此；面板只管 tab 切换与全局轮询。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import { writeClipboard } from '../../../utils/clipboard'
import type { TunnelFullState } from './tunnel-panel-model'

const props = defineProps<{
    state: TunnelFullState | null
    token: string
    /** 面板层持有的局域网 IP 选中项（切 tab 往返不丢失用户显式选择） */
    selectedIp: string
}>()

const emit = defineEmits<{ (e: 'select', ip: string): void }>()

const { t } = useI18n()

/** 当前生效的局域网 IP：选中项已不在最新列表（网卡变化/列表清空）时回落首个，避免残留失效地址 */
const activeLanIp = computed(() => {
    const ips = props.state?.lanIps ?? []
    return ips.includes(props.selectedIp) ? props.selectedIp : ips[0] ?? ''
})

/** 局域网直连分享链接（二维码渲染目标） */
const lanShareUrl = computed(() => {
    const tok = props.token.trim()
    const ip = activeLanIp.value
    if (!tok || !ip || !props.state?.serverPort) return null
    return `http://${ip}:${props.state.serverPort}/#token=${encodeURIComponent(tok)}`
})

const tokenMissing = computed(() => !props.token.trim())

/** App 连接要填的局域网裸地址（无 hash）；远程地址由各 provider 区块自带，不在此处 */
const appConnectUrl = computed(() => {
    const ip = activeLanIp.value
    return ip && props.state?.serverPort ? `http://${ip}:${props.state.serverPort}` : ''
})

/** 选中局域网 IP（选中态归面板层持有，跨 tab 往返不丢） */
function selectLan(ip: string) {
    emit('select', ip)
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

const qrDataUrl = ref('')

async function renderQr(text: string) {
    const dataUrl = await QRCode.toDataURL(text, { margin: 1, width: 320 })
    // 时序守护：await 期间分享地址可能又变了（快速切 IP/令牌就绪），旧二维码不得写入
    if (lanShareUrl.value === text) qrDataUrl.value = dataUrl
}

// 分享地址变化（IP 切换 / token 就绪 / 网卡变化）时重渲染二维码
watch(lanShareUrl, (url) => {
    if (url) {
        renderQr(url).catch((e) => console.error('[tunnel:lan] qr render failed', e))
    } else {
        qrDataUrl.value = ''
    }
}, { immediate: true })
</script>

<template>
    <div class="text-center">
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
    </div>
</template>
