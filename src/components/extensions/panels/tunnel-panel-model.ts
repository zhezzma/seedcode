/**
 * tunnel-panel-model.ts — tunnel 面板的多 provider 共享模型。
 *
 * 类型与后端契约逐字同构（seedagent src/extensions/tunnel/{tunnel-provider,server-routes}.ts）：
 *   GET  /state              → TunnelFullState（providers: Record<id, TunnelStateEx>）
 *   POST /start/:id /stop/:id → TunnelStateEx
 * provider 元数据数组是面板展示顺序的唯一事实源：新增后端 = registry 加一行 +
 * 此处加一项 + i18n 补一个 `extensions.tunnel.providers.<id>` 前缀子树，面板零改动。
 */

/** 单 provider 纯状态切片（与后端 TunnelState 完全同构，各 provider 共用同一形状） */
export interface TunnelProviderState {
    status: 'idle' | 'connecting' | 'ready' | 'failed'
    /** 对外访问 URL（Ready 时为 http://host:port），其余为 null */
    url: string | null
    /** Failed 时的原因描述 */
    error: string | null
    /** 最近一次进入 Ready 的时间戳（ms），从未成功为 null */
    lastReadyAt: number | null
    /** 当前退避重连等待中的尝试序号（0 = 不在重连周期） */
    pendingReconnect: number
    /** Ready 后的公网可达性探测：true 可达 / false 不可达 / null 未探测 */
    urlVerified: boolean | null
}

/** /state 与 start/stop 响应的单 provider 记录（TunnelStateEx = TunnelState + configured/label） */
export interface TunnelStateEx extends TunnelProviderState {
    /** 该 provider 凭据是否齐备（未配置时面板显示指引） */
    configured: boolean
    /** 展示名（面板优先用 i18n 前缀键本地化，此字段仅作兜底） */
    label: string
}

/** GET /state 完整响应形状 */
export interface TunnelFullState {
    serverPort: number
    /** 真实局域网 IP（服务端已过滤虚拟网卡；多真实网卡时多于一个） */
    lanIps: string[]
    providers: Record<string, TunnelStateEx>
}

/**
 * provider 展示顺序（并发语义：ssh 为 VPS 自管，devbridge/cloudflare 为托管通道）。
 * 面板 v-for 与 per-provider rev/busy 簿记均以此数组驱动。
 */
export const TUNNEL_PROVIDER_IDS = ['ssh', 'devbridge', 'cloudflare'] as const

export type TunnelProviderId = (typeof TUNNEL_PROVIDER_IDS)[number]
