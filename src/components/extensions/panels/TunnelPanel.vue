<script setup lang="ts">
/**
 * tunnel 面板：移动端访问 + 手机扫码引导（统一面板，无模式二分）。
 * 端点契约（多 provider 并发）：GET /state → {serverPort, lanIps, providers}、
 * POST /api/extensions/:extensionId/start/:id | stop/:id。
 *
 * 结构（回应「面板要一个 tab 栏，每个 tab 下大部分内容相同」的优雅性要求）：
 * - tab 栏 = 局域网 + provider 元数据数组（TUNNEL_PROVIDER_IDS）驱动，每个 tab 右侧
 *   一颗实时状态圆点（轮询持续跑，未选中的通道也能一眼看到状态）；
 * - 内容区 = 一张同构「连接卡」：局域网 tab → TunnelLanSection，provider tab →
 *   TunnelProviderSection。状态徽标/二维码/连接断开/error/未配置指引等差异全部
 *   收敛在两个 Section 组件内部，面板只负责 tab 切换与全局轮询/守卫簿记。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiGet, apiPost } from '../../../composables/api-client'
import { useUiSettingsStore } from '../../../stores/setting'
import TunnelLanSection from './TunnelLanSection.vue'
import TunnelProviderSection from './TunnelProviderSection.vue'
import {
    TUNNEL_PROVIDER_IDS,
    TUNNEL_PROVIDER_TAB_LABELS,
    providerDotClass,
    type TunnelFullState,
    type TunnelStateEx,
    type TunnelTabId,
} from './tunnel-panel-model'

const props = defineProps<{
    extensionId: string
}>()

const { t } = useI18n()
const settings = useUiSettingsStore()

const state = ref<TunnelFullState | null>(null)
/** per-provider 请求窗标记（reactive 簿记使各 provider 的按钮/徽标独立联动） */
const starting = reactive<Record<string, boolean>>({})
const stopping = reactive<Record<string, boolean>>({})
/** 当前选中的 tab：默认局域网直连（与历史视觉顺序一致） */
const selected = ref<TunnelTabId>('lan')

/** 多真实网卡时选中的局域网 IP：挂在面板层，切 tab 往返不丢失用户显式选择 */
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

/**
 * per-provider 状态切片：tab 栏与内容区的数据源是元数据 TUNNEL_PROVIDER_IDS（固定顺序），
 * 此处只负责按 id 从最新快照里取该 provider 的那一片（首帧未返回时为 null）
 */
function providerState(id: string): TunnelStateEx | null {
    return state.value?.providers[id] ?? null
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
        // 网卡列表变化时同步局域网选中项（选中项已不在最新列表则回落首个）
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
</script>

<template>
    <div class="text-center">
        <!-- ── tab 栏：局域网 + 三 provider，一个 tab 一张同构「连接卡」──────────────
             圆点 = 该通道实时状态（含请求窗）；轮询对全部 provider 持续进行，与选中与否无关。
             daisyUI 5 类名：tabs-border（v4 旧写法已弃用，用错指示条不渲染） -->
        <div role="tablist" class="tabs tabs-border tabs-sm justify-center mb-4">
            <button type="button" role="tab" class="tab"
                :class="{ 'tab-active': selected === 'lan' }" @click="selected = 'lan'">
                {{ t('extensions.tunnel.lanTab') }}
            </button>
            <button v-for="id in TUNNEL_PROVIDER_IDS" :key="id" type="button" role="tab" class="tab gap-1.5"
                :class="{ 'tab-active': selected === id }" @click="selected = id">
                <span class="inline-block h-1.5 w-1.5 rounded-full align-middle"
                    :class="providerDotClass(providerState(id), !!starting[id], !!stopping[id])"></span>
                {{ TUNNEL_PROVIDER_TAB_LABELS[id] }}
            </button>
        </div>

        <!-- 共享内容区：每个 tab 一张连接卡，差异全部收敛在 Section 组件内部 -->
        <TunnelLanSection v-if="selected === 'lan'"
            :state="state" :token="token" :selected-ip="selectedLanIp"
            @select="selectedLanIp = $event" />
        <TunnelProviderSection v-else :key="selected"
            :provider-id="selected"
            :state="providerState(selected)"
            :starting="!!starting[selected]"
            :stopping="!!stopping[selected]"
            :token="token"
            @start="control(selected, 'start')"
            @stop="control(selected, 'stop')" />
    </div>
</template>
