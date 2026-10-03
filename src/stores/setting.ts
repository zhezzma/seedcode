import { defineStore } from 'pinia'
import { gatewayHostLabel } from '../utils/gateway-url.ts'

export type ASREngineType = 'fun-asr' | 'voice-gateway'
export type TTSEngineType = 'edge' | 'qwen' | 'voice-gateway'
export type BusySendBehavior = 'steer' | 'follow'

export type GatewayType = 'local' | 'remote'

/**
 * 网关账号（profile）：一台服务器 + 一份连接凭据 + 该服务器上的新会话页 agent 记忆。
 * - local：bundled 构建的内置服务端，id 固定 LOCAL_GATEWAY_ID，apiBaseUrl/token 由
 *   local-server 托管写入（端口漂移、首次生成 UUID），用户不可编辑。
 * - remote：用户维护的远程 seedagent 服务器，可任意增删改。
 * lastNewSessionAgentId 按条目隔离：各服务器 agent id 命名空间互不相通，
 * 共用单值会在切换时互相覆盖/窜台。
 */
export interface GatewayProfile {
    id: string
    type: GatewayType
    name: string
    apiBaseUrl: string
    token: string
    lastNewSessionAgentId: string
}

/** 托管 local 条目的固定 id：bundled 守卫、reconcile 与草稿哨兵都依赖它稳定。 */
export const LOCAL_GATEWAY_ID = 'local'

export interface EngineConfig<T extends string> {
    engine: T
    baseUrl: string
    token: string
    model: string
}

export interface UiSettings {
    /** 生效值：等于激活 remote 条目的 apiBaseUrl/token；激活 local 条目时由
     *  local-server 托管覆写（条目是账号模型镜像，reload 恢复靠这两个顶层值）。
     *  所有 API/SSE/WS 消费方只读这两个字段，不感知多网关。 */
    apiBaseUrl: string
    token: string
    /** 全部网关账号；local 条目最多一条且仅 bundled 构建存在。 */
    gateways: GatewayProfile[]
    /** 当前激活的 gateway id；顶层 apiBaseUrl/token 随它派生。 */
    activeGatewayId: string
    /** 首次引导是否已完成：bundled 本地模式下 apiBaseUrl 由服务托管、恒为已配置，
     *  是否弹回主界面只能以"跑完过向导"为准（否则永远进不了引导页） */
    setupDone: boolean
    theme: 'light' | 'dark'
    isSidebarOpen: boolean
    isSidebarCollapsed: boolean
    isSidebarGrouped: boolean
    /** 桌面端会话页左侧的 session tree rail（minimap 快速定位条）显隐 */
    isSessionTreeRailVisible: boolean
    asrEngine: ASREngineType
    ttsEngine: TTSEngineType
    asrConfigs: EngineConfig<ASREngineType>[]
    ttsConfigs: EngineConfig<TTSEngineType>[]
    silenceDuration: number
    autoSendCommands: boolean
    busySendBehavior: BusySendBehavior
    assistantMsgMerge: boolean
    language: 'zh' | 'en'
    showAllProviders: boolean  // 是否显示没有 apiKey 的提供商
    externalUrl: string  // 外部链接地址（侧边栏跳转按钮）
    workspacePanel: {
        open: boolean
        width: number
        tab: 'files' | 'git'
        repoByAgent: Record<string, string>
        /** 可折叠区域的展开状态，跨 session 持久化。
         *  - history: Git tab 的提交历史（默认展开，主要内容）
         *  - agentFiles: Files tab 的 agent 配置目录（默认折叠，次要内容） */
        bottomSections: {
            history: boolean
            agentFiles: boolean
        }
        /** Git tab 提交历史区高度（px），拖动顶部 handle 调整，跨 session 持久化。 */
        historyHeight: number
        statusGroups: {
            staged: boolean
            unstaged: boolean
        }
    }
}

const CONFIG_KEY = 'openclaw_config'
const DEFAULT_VOICE_GATEWAY_URL = 'https://voice.godgodgame.com'
const DEFAULT_LOCAL_GATEWAY_NAME = '本地服务'
const DEFAULT_REMOTE_GATEWAY_NAME = '默认服务器'

/** 条目名称兜底：留空时 local 用默认名、remote 用地址 host（再退默认名）。 */
const resolveGatewayName = (type: GatewayType, name: string, apiBaseUrl: string): string => {
    if (name.trim() !== '') return name
    if (type === 'local') return DEFAULT_LOCAL_GATEWAY_NAME
    return gatewayHostLabel(apiBaseUrl) || DEFAULT_REMOTE_GATEWAY_NAME
}

const generateGatewayId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    // 兜底：老运行环境无 crypto.randomUUID（node:test 的旧版本 / 非安全上下文 http）
    return `gw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const defaultAsrConfigs = (): EngineConfig<ASREngineType>[] => ([
    { engine: 'fun-asr', baseUrl: '', token: '', model: '' },
    { engine: 'voice-gateway', baseUrl: DEFAULT_VOICE_GATEWAY_URL, token: '', model: '@cf/openai/whisper-large-v3-turbo' },
])

const defaultTtsConfigs = (): EngineConfig<TTSEngineType>[] => ([
    { engine: 'edge', baseUrl: '', token: '', model: '' },
    { engine: 'qwen', baseUrl: '', token: '', model: '' },
    { engine: 'voice-gateway', baseUrl: DEFAULT_VOICE_GATEWAY_URL, token: '', model: 'gemini-3.1-flash-tts-preview' },
])

const cloneEngineConfig = <T extends string>(config: EngineConfig<T>): EngineConfig<T> => ({ ...config })

const getDefaultAsrConfig = (engine: ASREngineType): EngineConfig<ASREngineType> => {
    const config = defaultAsrConfigs().find((item) => item.engine === engine)
    return config ? cloneEngineConfig(config) : { engine, baseUrl: '', token: '', model: '' }
}

const getDefaultTtsConfig = (engine: TTSEngineType): EngineConfig<TTSEngineType> => {
    const config = defaultTtsConfigs().find((item) => item.engine === engine)
    return config ? cloneEngineConfig(config) : { engine, baseUrl: '', token: '', model: '' }
}

const normalizeEngineConfig = <T extends string>(
    config: Partial<EngineConfig<T>> | null | undefined,
    fallback: EngineConfig<T>,
): EngineConfig<T> => ({
    engine: (config?.engine ?? fallback.engine) as T,
    baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl : fallback.baseUrl,
    token: typeof config?.token === 'string' ? config.token : fallback.token,
    model: typeof config?.model === 'string' ? config.model : fallback.model,
})

const mergeEngineConfigs = <T extends string>(
    defaults: EngineConfig<T>[],
    saved: unknown,
): EngineConfig<T>[] => {
    const merged = defaults.map((config) => cloneEngineConfig(config))

    if (!Array.isArray(saved)) {
        return merged
    }

    for (const rawItem of saved) {
        if (!rawItem || typeof rawItem !== 'object') {
            continue
        }

        const item = rawItem as Partial<EngineConfig<T>>
        const engine = typeof item.engine === 'string' ? item.engine as T : null
        if (!engine) {
            continue
        }

        const existingIndex = merged.findIndex((config) => config.engine === engine)
        const fallback = existingIndex >= 0
            ? merged[existingIndex]
            : { engine, baseUrl: '', token: '', model: '' }
        const normalized = normalizeEngineConfig(item, fallback)

        if (existingIndex >= 0) {
            merged[existingIndex] = normalized
        } else {
            merged.push(normalized)
        }
    }

    return merged
}

const upsertConfigInList = <T extends string>(
    list: EngineConfig<T>[],
    config: EngineConfig<T>,
): EngineConfig<T>[] => {
    const next = list.map((item) => cloneEngineConfig(item))
    const index = next.findIndex((item) => item.engine === config.engine)

    if (index >= 0) {
        next[index] = cloneEngineConfig(config)
    } else {
        next.push(cloneEngineConfig(config))
    }

    return next
}

const normalizeBusySendBehavior = (value: unknown): BusySendBehavior => {
    return value === 'steer' || value === 'follow' ? value : 'follow'
}

/**
 * 网关模型迁移（旧版 → GatewayProfile[] + activeGatewayId）：
 * 旧字段 gatewayMode / remoteApiBaseUrl / remoteToken / lastLocal|RemoteNewSessionAgentId
 * 全部收编进条目。local 条目无脑建（id 固定 'local'）：非 bundled 构建由
 * reconcileLocalGateway(false) 剔除；bundled 构建由它保活。
 * 顶层 apiBaseUrl/token（生效值）按激活条目重写，旧 remote* 值不会丢——
 * 它们在 remote 条目里，激活即恢复。
 */
const migrateGateways = (parsed: any): {
    gateways: GatewayProfile[]
    activeGatewayId: string
} => {
    if (Array.isArray(parsed?.gateways)) {
        // 新模型配置：仅做规范化（手改/损坏容错），不重建
        const gateways: GatewayProfile[] = []
        for (const raw of parsed.gateways) {
            if (!raw || typeof raw !== 'object') continue
            const item = raw as Partial<GatewayProfile>
            const type: GatewayType = item.type === 'local' ? 'local' : 'remote'
            // local 条目 id 强制归一：syncSettings/switchGateway/草稿哨兵都依赖
            // 'id === LOCAL_GATEWAY_ID' 不变量，手改配置的自定义 id 不予保留
            const id = type === 'local'
                ? LOCAL_GATEWAY_ID
                : (typeof item.id === 'string' && item.id.trim() !== '' ? item.id : generateGatewayId())
            gateways.push({
                id,
                type,
                name: resolveGatewayName(type, typeof item.name === 'string' ? item.name : '', typeof item.apiBaseUrl === 'string' ? item.apiBaseUrl : ''),
                apiBaseUrl: typeof item.apiBaseUrl === 'string' ? item.apiBaseUrl : '',
                token: typeof item.token === 'string' ? item.token : '',
                lastNewSessionAgentId: typeof item.lastNewSessionAgentId === 'string' ? item.lastNewSessionAgentId : '',
            })
        }
        // 同一 id 去重（保留先出现的）；local 条目最多一条（保留首个，其余剔除：
        // UI 不给 local 删按钮，多余 local 行永远是死行）
        const seen = new Set<string>()
        let localSeen = false
        const deduped = gateways.filter((g) => {
            if (seen.has(g.id)) return false
            if (g.type === 'local') {
                if (localSeen) return false
                localSeen = true
            }
            seen.add(g.id)
            return true
        })
        const activeGatewayId = typeof parsed.activeGatewayId === 'string'
            && deduped.some((g) => g.id === parsed.activeGatewayId)
            ? parsed.activeGatewayId
            : (deduped[0]?.id ?? '')
        return { gateways: deduped, activeGatewayId }
    }

    // ---- 旧配置迁移 ----
    // 旧 gatewayMode 归一化规则沿用：有远程地址 → remote，否则 local
    const legacyMode: GatewayType = parsed?.gatewayMode === 'local' || parsed?.gatewayMode === 'remote'
        ? parsed.gatewayMode
        : ((typeof parsed?.apiBaseUrl === 'string' && parsed.apiBaseUrl.trim() !== '') ? 'remote' : 'local')

    // 旧版 loadConfig 会把 local 模式的托管值无脑 backfill 进 remote*（remoteApiBaseUrl
    // 缺省时填 apiBaseUrl）：直接照搬会造出一条指向本机的幽灵 remote 条目，token 随
    // 端口漂移失效。非 remote 模式下仅当 remote* 与顶层生效值不同才认它是真远程配置
    const effectiveUrlLegacy = typeof parsed?.apiBaseUrl === 'string' ? parsed.apiBaseUrl : ''
    const backfilledRemote = legacyMode !== 'remote'
        && typeof parsed?.remoteApiBaseUrl === 'string'
        && parsed.remoteApiBaseUrl === effectiveUrlLegacy
    const legacyRemoteUrl = !backfilledRemote && typeof parsed?.remoteApiBaseUrl === 'string' && parsed.remoteApiBaseUrl.trim() !== ''
        ? parsed.remoteApiBaseUrl
        : (legacyMode === 'remote' ? effectiveUrlLegacy : '')
    const legacyRemoteToken = !backfilledRemote && typeof parsed?.remoteToken === 'string' && parsed.remoteToken.trim() !== ''
        ? parsed.remoteToken
        : (legacyMode === 'remote' && typeof parsed?.token === 'string' ? parsed.token : '')

    // 旧 last*AgentId 按模式归属；已拆分的 per-mode 字段优先于陈旧的单值（clobber guard）
    const legacySingle = typeof parsed?.lastNewSessionAgentId === 'string' ? parsed.lastNewSessionAgentId : ''
    const remoteAgentId = typeof parsed?.lastRemoteNewSessionAgentId === 'string'
        ? parsed.lastRemoteNewSessionAgentId
        : (legacyMode === 'remote' ? legacySingle : '')
    const localAgentId = typeof parsed?.lastLocalNewSessionAgentId === 'string'
        ? parsed.lastLocalNewSessionAgentId
        : (legacyMode === 'local' ? legacySingle : '')

    const remoteEntry: GatewayProfile = {
        id: generateGatewayId(),
        type: 'remote',
        name: gatewayHostLabel(legacyRemoteUrl) || DEFAULT_REMOTE_GATEWAY_NAME,
        apiBaseUrl: legacyRemoteUrl,
        token: legacyRemoteToken,
        lastNewSessionAgentId: remoteAgentId,
    }
    const localEntry: GatewayProfile = {
        id: LOCAL_GATEWAY_ID,
        type: 'local',
        name: DEFAULT_LOCAL_GATEWAY_NAME,
        apiBaseUrl: '',
        token: '',
        lastNewSessionAgentId: localAgentId,
    }
    // 从未配过远程的老用户（local-only）：不建空 URL 幽灵条目，账号菜单/设置列表只显示本地服务
    const hasLegacyRemote = legacyRemoteUrl.trim() !== ''
    const gateways = hasLegacyRemote ? [localEntry, remoteEntry] : [localEntry]
    const activeGatewayId = legacyMode === 'remote' && hasLegacyRemote ? remoteEntry.id : LOCAL_GATEWAY_ID
    return { gateways, activeGatewayId }
}

const migrateLegacyVoiceSettings = (parsed: any, next: UiSettings): UiSettings => {
    const asrConfigs = mergeEngineConfigs(defaultAsrConfigs(), parsed?.asrConfigs)
    const ttsConfigs = mergeEngineConfigs(defaultTtsConfigs(), parsed?.ttsConfigs)

    const asrEngine: ASREngineType = parsed?.asrEngine === 'voice-gateway' ? 'voice-gateway' : 'fun-asr'
    const ttsEngine: TTSEngineType = parsed?.ttsEngine === 'qwen' || parsed?.ttsEngine === 'voice-gateway'
        ? parsed.ttsEngine
        : 'edge'

    const legacyVoiceGatewayUrl = typeof parsed?.voiceGatewayUrl === 'string' ? parsed.voiceGatewayUrl : ''
    const legacyVoiceGatewayToken = typeof parsed?.voiceGatewayToken === 'string' ? parsed.voiceGatewayToken : ''
    const legacyAsrToken = typeof parsed?.asrToken === 'string' ? parsed.asrToken : ''
    const legacyAsrModel = typeof parsed?.asrModel === 'string' ? parsed.asrModel : ''
    const legacyTtsToken = typeof parsed?.ttsToken === 'string' ? parsed.ttsToken : ''
    const legacyTtsModel = typeof parsed?.ttsModel === 'string' ? parsed.ttsModel : ''

    const applyPatch = <T extends string>(
        list: EngineConfig<T>[],
        engine: T,
        patch: Partial<Omit<EngineConfig<T>, 'engine'>>,
        getFallback: (engine: T) => EngineConfig<T>,
    ) => {
        const current = list.find((item) => item.engine === engine) ?? getFallback(engine)
        const nextConfig = normalizeEngineConfig({
            ...current,
            engine,
            ...patch,
        }, current)
        const updated = upsertConfigInList(list, nextConfig)
        list.splice(0, list.length, ...updated)
    }

    if (legacyVoiceGatewayUrl || legacyVoiceGatewayToken) {
        applyPatch(asrConfigs, 'voice-gateway', {
            baseUrl: legacyVoiceGatewayUrl || (asrConfigs.find((item) => item.engine === 'voice-gateway')?.baseUrl ?? getDefaultAsrConfig('voice-gateway').baseUrl),
            token: legacyVoiceGatewayToken || (asrConfigs.find((item) => item.engine === 'voice-gateway')?.token ?? ''),
        }, getDefaultAsrConfig)

        applyPatch(ttsConfigs, 'voice-gateway', {
            baseUrl: legacyVoiceGatewayUrl || (ttsConfigs.find((item) => item.engine === 'voice-gateway')?.baseUrl ?? getDefaultTtsConfig('voice-gateway').baseUrl),
            token: legacyVoiceGatewayToken || (ttsConfigs.find((item) => item.engine === 'voice-gateway')?.token ?? ''),
        }, getDefaultTtsConfig)
    }

    if (legacyAsrToken || legacyAsrModel) {
        const targetEngine: ASREngineType = asrEngine === 'voice-gateway' ? 'voice-gateway' : 'fun-asr'
        applyPatch(asrConfigs, targetEngine, {
            token: legacyAsrToken || (asrConfigs.find((item) => item.engine === targetEngine)?.token ?? ''),
            model: legacyAsrModel || (asrConfigs.find((item) => item.engine === targetEngine)?.model ?? ''),
        }, getDefaultAsrConfig)
    }

    if ((legacyTtsToken || legacyTtsModel) && (ttsEngine === 'qwen' || ttsEngine === 'voice-gateway')) {
        const targetEngine: TTSEngineType = ttsEngine
        applyPatch(ttsConfigs, targetEngine, {
            token: legacyTtsToken || (ttsConfigs.find((item) => item.engine === targetEngine)?.token ?? ''),
            model: legacyTtsModel || (ttsConfigs.find((item) => item.engine === targetEngine)?.model ?? ''),
        }, getDefaultTtsConfig)
    }

    const {
        asrToken: _legacyAsrToken,
        asrModel: _legacyAsrModel,
        ttsToken: _legacyTtsToken,
        ttsModel: _legacyTtsModel,
        voiceGatewayUrl: _legacyVoiceGatewayUrl,
        voiceGatewayToken: _legacyVoiceGatewayToken,
        ...rest
    } = next as UiSettings & Record<string, unknown>

    return {
        ...(rest as UiSettings),
        asrEngine,
        ttsEngine,
        asrConfigs,
        ttsConfigs,
        busySendBehavior: normalizeBusySendBehavior(next.busySendBehavior),
    }
}

const getDefaultSettings = (): UiSettings => ({
    apiBaseUrl: '',
    token: '',
    gateways: [],
    activeGatewayId: '',
    setupDone: false,
    theme: typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    isSidebarOpen: false,
    isSidebarCollapsed: false,
    isSidebarGrouped: false,
    isSessionTreeRailVisible: true,
    asrEngine: 'fun-asr',
    ttsEngine: 'edge',
    asrConfigs: defaultAsrConfigs(),
    ttsConfigs: defaultTtsConfigs(),
    silenceDuration: 2000,
    autoSendCommands: true,
    busySendBehavior: 'follow',
    assistantMsgMerge: true,
    language: 'zh',
    showAllProviders: true,
    externalUrl: '',
    workspacePanel: {
        open: false,
        width: 360,
        tab: 'files',
        repoByAgent: {},
        bottomSections: {
            history: true,
            agentFiles: false,
        },
        historyHeight: 240,
        statusGroups: {
            staged: true,
            unstaged: true,
        },
    },
})

const loadConfig = (): UiSettings => {
    try {
        const saved = localStorage.getItem(CONFIG_KEY)
        if (saved) {
            const parsed = JSON.parse(saved)
            // 迁移：lastActiveSessionKey 已废弃（只写不读的死状态），从旧配置中剥离
            delete parsed.lastActiveSessionKey
            // 迁移：deviceName 已废弃（引导页名称改写入 GatewayProfile.name），从旧配置中剥离
            delete parsed.deviceName
            if (parsed.gatewayUrl && !parsed.apiBaseUrl) {
                let url = parsed.gatewayUrl as string
                url = url.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
                parsed.apiBaseUrl = url
                delete parsed.gatewayUrl
            }

            const defaults = getDefaultSettings()
            // workspacePanel 需要深合并：旧用户保存的子对象可能没有 bottomSections。
            // 浅拷贝会直接覆盖 defaults.workspacePanel，导致新字段丢失。
            const parsedWsPanel = parsed?.workspacePanel ?? {}
            const mergedWsPanel = {
                ...defaults.workspacePanel,
                ...parsedWsPanel,
                bottomSections: {
                    ...defaults.workspacePanel.bottomSections,
                    ...(parsedWsPanel.bottomSections ?? {}),
                },
                statusGroups: {
                    ...defaults.workspacePanel.statusGroups,
                    ...(parsedWsPanel.statusGroups ?? {}),
                },
            }
            // 网关模型迁移：旧 gatewayMode/remote*/last*AgentId 字段收编进 gateways 条目；
            // 旧键从 parsed 剥离，避免死键随 ...parsed 流入 state 被反复回写
            const { gateways, activeGatewayId } = migrateGateways(parsed)
            delete parsed.gatewayMode
            delete parsed.remoteApiBaseUrl
            delete parsed.remoteToken
            delete parsed.lastLocalNewSessionAgentId
            delete parsed.lastRemoteNewSessionAgentId
            delete parsed.lastNewSessionAgentId
            // 顶层生效值 = 激活条目（local 条目为空壳时保留旧托管值，
            // 由 local-server 就绪后 syncSettings 覆写）
            const activeEntry = gateways.find((g) => g.id === activeGatewayId) ?? null
            // 激活 remote 条目 → 条目值即生效值；local/空 → 沿用旧托管值
            // （由 local-server 就绪后 syncSettings 覆写）
            const fallbackUrl = typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : ''
            const fallbackToken = typeof parsed.token === 'string' ? parsed.token : ''
            const useActiveRemote = activeEntry !== null && activeEntry.type === 'remote'
            const effectiveUrl = useActiveRemote ? activeEntry.apiBaseUrl : fallbackUrl
            const effectiveToken = useActiveRemote ? activeEntry.token : fallbackToken
            const merged: UiSettings = {
                ...defaults,
                ...parsed,
                apiBaseUrl: effectiveUrl,
                token: effectiveToken,
                gateways,
                activeGatewayId,
                asrConfigs: defaults.asrConfigs,
                ttsConfigs: defaults.ttsConfigs,
                workspacePanel: mergedWsPanel,
            }

            const normalized = migrateLegacyVoiceSettings(parsed, merged)
            const serializedSaved = JSON.stringify(parsed)
            const serializedNormalized = JSON.stringify(normalized)

            if (serializedSaved !== serializedNormalized) {
                localStorage.setItem(CONFIG_KEY, serializedNormalized)
            }

            return normalized
        }
    } catch (e) {
        console.error('Failed to load config:', e)
    }
    return getDefaultSettings()
}

export const useUiSettingsStore = defineStore('ui-settings', {
    state: (): UiSettings => loadConfig(),

    getters: {
        isConfigured: (state) => state.apiBaseUrl.trim() !== '' && state.token.trim() !== '',
        authToken: (state) => state.token,
        activeGateway: (state): GatewayProfile | null =>
            state.gateways.find((g) => g.id === state.activeGatewayId) ?? null,
        isDark: (state) => state.theme === 'dark',
        getAsrConfig: (state) => (engine?: ASREngineType) => {
            const targetEngine = engine ?? state.asrEngine
            return state.asrConfigs.find((item) => item.engine === targetEngine) ?? getDefaultAsrConfig(targetEngine)
        },
        getTtsConfig: (state) => (engine?: TTSEngineType) => {
            const targetEngine = engine ?? state.ttsEngine
            return state.ttsConfigs.find((item) => item.engine === targetEngine) ?? getDefaultTtsConfig(targetEngine)
        },
        currentAsrConfig(): EngineConfig<ASREngineType> {
            return this.getAsrConfig(this.asrEngine)
        },
        currentTtsConfig(): EngineConfig<TTSEngineType> {
            return this.getTtsConfig(this.ttsEngine)
        },
        hasAsrToken(): boolean {
            return this.currentAsrConfig.token.trim() !== ''
        },
        hasTtsToken(): boolean {
            return this.ttsEngine === 'edge' || this.currentTtsConfig.token.trim() !== ''
        },
        isCurrentAsrConfigured(): boolean {
            if (!this.currentAsrConfig.token.trim()) {
                return false
            }

            if (this.asrEngine === 'voice-gateway') {
                return this.currentAsrConfig.baseUrl.trim() !== ''
            }

            return true
        },
        isCurrentTtsConfigured(): boolean {
            if (this.ttsEngine === 'edge') {
                return true
            }

            if (!this.currentTtsConfig.token.trim()) {
                return false
            }

            if (this.ttsEngine === 'voice-gateway') {
                return this.currentTtsConfig.baseUrl.trim() !== ''
            }

            return true
        },
    },

    actions: {
        persist() {
            localStorage.setItem(CONFIG_KEY, JSON.stringify(this.$state))
        },

        save(newConfig?: Partial<UiSettings>) {
            if (newConfig) Object.assign(this.$state, newConfig)
            this.persist()
        },

        clear() {
            Object.assign(this.$state, getDefaultSettings())
            localStorage.removeItem(CONFIG_KEY)
        },

        upsertAsrConfig(config: EngineConfig<ASREngineType>) {
            this.asrConfigs = upsertConfigInList(this.asrConfigs, normalizeEngineConfig(config, getDefaultAsrConfig(config.engine)))
            this.persist()
        },

        upsertTtsConfig(config: EngineConfig<TTSEngineType>) {
            this.ttsConfigs = upsertConfigInList(this.ttsConfigs, normalizeEngineConfig(config, getDefaultTtsConfig(config.engine)))
            this.persist()
        },

        saveAsrEngineConfig(engine: ASREngineType, patch: Partial<Omit<EngineConfig<ASREngineType>, 'engine'>>) {
            const current = this.getAsrConfig(engine)
            this.asrConfigs = upsertConfigInList(this.asrConfigs, normalizeEngineConfig({ ...current, engine, ...patch }, current))
            this.persist()
        },

        saveTtsEngineConfig(engine: TTSEngineType, patch: Partial<Omit<EngineConfig<TTSEngineType>, 'engine'>>) {
            const current = this.getTtsConfig(engine)
            this.ttsConfigs = upsertConfigInList(this.ttsConfigs, normalizeEngineConfig({ ...current, engine, ...patch }, current))
            this.persist()
        },

        // ---------- 网关账号（GatewayProfile）管理 ----------

        /** 顶层生效值同步：apiBaseUrl/token 永远等于激活条目（remote）或托管 local 的值。 */
        syncActiveGatewayEffective() {
            const active = this.activeGateway
            if (!active || active.type !== 'remote') return
            this.apiBaseUrl = active.apiBaseUrl
            this.token = active.token
        },

        addGateway(profile: Omit<GatewayProfile, 'id' | 'lastNewSessionAgentId'> & Partial<Pick<GatewayProfile, 'id' | 'lastNewSessionAgentId'>>): GatewayProfile {
            const entry: GatewayProfile = {
                // local 条目 id 恒为 LOCAL_GATEWAY_ID（同迁移规则，见 migrateGateways）
                id: profile.type === 'local'
                    ? LOCAL_GATEWAY_ID
                    : (profile.id && profile.id.trim() !== '' ? profile.id : generateGatewayId()),
                type: profile.type,
                name: resolveGatewayName(profile.type, profile.name, profile.apiBaseUrl),
                apiBaseUrl: profile.apiBaseUrl,
                token: profile.token,
                lastNewSessionAgentId: profile.lastNewSessionAgentId ?? '',
            }
            // 同 id 覆盖（upsert 语义：tunnel 引导等场景按 id 落条）
            const index = this.gateways.findIndex((g) => g.id === entry.id)
            if (index >= 0) {
                this.gateways[index] = entry
            } else {
                this.gateways.push(entry)
            }
            this.persist()
            return entry
        },

        updateGateway(id: string, patch: Partial<Omit<GatewayProfile, 'id' | 'type'>>) {
            const target = this.gateways.find((g) => g.id === id)
            if (!target) return
            // 名称与 addGateway 同一兜底规则：清空名称字段保存不留空白条目
            const next: GatewayProfile = {
                ...target,
                ...patch,
                id: target.id,
                type: target.type,
                name: resolveGatewayName(target.type, patch.name ?? target.name, patch.apiBaseUrl ?? target.apiBaseUrl),
            }
            const index = this.gateways.findIndex((g) => g.id === id)
            this.gateways[index] = next
            if (id === this.activeGatewayId) this.syncActiveGatewayEffective()
            this.persist()
        },

        removeGateway(id: string) {
            const index = this.gateways.findIndex((g) => g.id === id)
            if (index < 0) return
            this.gateways.splice(index, 1)
            if (this.activeGatewayId === id) {
                // 删激活条目：回落第一个剩余条目（无剩余则清空，由向导接管）。
                // local 条目的顶层值不在此处写（其 url/token 由 local-server 托管，
                // 就绪后 syncSettings 覆写）；但必须清掉被删 remote 的残留生效值，
                // 否则 UI 显示 local 激活而 API 仍打向已删除服务器
                this.activeGatewayId = this.gateways[0]?.id ?? ''
                const active = this.activeGateway
                if (active) {
                    this.apiBaseUrl = active.apiBaseUrl
                    this.token = active.token
                } else {
                    this.apiBaseUrl = ''
                    this.token = ''
                }
            }
            this.persist()
        },

        setActiveGateway(id: string) {
            if (!this.gateways.some((g) => g.id === id)) return
            this.activeGatewayId = id
            this.syncActiveGatewayEffective()
            this.persist()
        },

        /**
         * local 条目保活/自洁：bundled=true 确保有且仅有一条托管 local 条目（空壳保号，
         * 端口/token 由 local-server 就绪后写入）；bundled=false 剔除——
         * 未打包构建（Web/Android）没有内嵌服务端，留着会污染账号菜单。
         * 激活的 local 条目被剔除时回落第一个 remote 条目。
         */
        reconcileLocalGateway(bundled: boolean) {
            const localIndex = this.gateways.findIndex((g) => g.type === 'local')
            if (bundled) {
                if (localIndex < 0) {
                    this.addGateway({ id: LOCAL_GATEWAY_ID, type: 'local', name: DEFAULT_LOCAL_GATEWAY_NAME, apiBaseUrl: '', token: '' })
                }
                // bundled 全新安装：gateways 空转来的迁移产物只有空壳 local 条目且未激活。
                // 不激活则 effectiveGatewayMode() 落到 remote，引导页本地卡片不可达
                // （原默认 gatewayMode='local' 的行为回归）
                if (!this.activeGatewayId && this.gateways.length > 0) {
                    this.setActiveGateway(this.gateways[0].id)
                }
            } else if (localIndex >= 0) {
                this.removeGateway(this.gateways[localIndex].id)
            }
        },

        /** 新会话页最后选中的 agent 写入激活条目（per-gateway，不窜台）。 */
        setLastNewSessionAgentId(id: string) {
            const active = this.activeGateway
            if (!active) return
            active.lastNewSessionAgentId = id
            this.persist()
        },

        toggleSidebar() {
            this.isSidebarOpen = !this.isSidebarOpen
            this.persist()
        },

        openSidebar() {
            this.isSidebarOpen = true
            this.persist()
        },

        closeSidebar() {
            this.isSidebarOpen = false
            this.persist()
        },

        toggleSidebarCollapsed() {
            this.isSidebarCollapsed = !this.isSidebarCollapsed
            this.persist()
        },

        toggleSidebarGrouped() {
            this.isSidebarGrouped = !this.isSidebarGrouped
            this.persist()
        },

        toggleSessionTreeRail() {
            this.isSessionTreeRailVisible = !this.isSessionTreeRailVisible
            this.persist()
        },

        applyTheme(t: 'light' | 'dark') {
            document.documentElement.setAttribute('data-theme', t)
        },

        toggleTheme() {
            this.theme = this.theme === 'dark' ? 'light' : 'dark'
            this.applyTheme(this.theme)
            this.persist()
        },

        initTheme() {
            this.applyTheme(this.theme)
        },

        setLanguage(lang: 'zh' | 'en') {
            this.language = lang
            import('../i18n').then(({ i18n }) => {
                if (i18n.global.locale instanceof Object) {
                    // @ts-ignore
                    i18n.global.locale.value = lang
                } else {
                    // @ts-ignore
                    i18n.global.locale = lang
                }
            })
            this.persist()
        },

        initLanguage() {
            const lang = this.language
            import('../i18n').then(({ i18n }) => {
                if (i18n.global.locale instanceof Object) {
                    // @ts-ignore
                    i18n.global.locale.value = lang
                } else {
                    // @ts-ignore
                    i18n.global.locale = lang
                }
            })
        },
    },
})
