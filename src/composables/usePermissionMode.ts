// src/composables/usePermissionMode.ts
// 会话权限模式（seedagent permission-gate 扩展会话模式层）：输入栏下拉三档粗调。
// - 拉取线：挂载/切会话时 GET（silent：失败按缺省 autonomous 显示，不弹全局 toast）；
// - 写入线：POST 乐观更新（失败回滚 + toast）；busy 期允许切档
//   （服务端无 busy 门禁——运行中切 full 解卡是主用例）。
// 下拉显隐由 available 驱动：permission-gate 扩展未启用（全局/agent 级禁用，
// 或旧服务端无此扩展路由）时输入栏不渲染权限选择框。
// 模块级单例（useGoalState 同模式）：输入栏下拉跨组件共享一份现态。
import { ref, watch } from 'vue'
import { apiGet, apiPost, ApiError } from './api-client'
import { useChatState } from './useChatState'
import { useToast } from './useToast'
import { i18n } from '../i18n'

export type PermissionMode = 'careful' | 'autonomous' | 'full'

const MODES: readonly PermissionMode[] = ['careful', 'autonomous', 'full']

function isMode(value: unknown): value is PermissionMode {
    return MODES.includes(value as PermissionMode)
}

function modePath(sessionKey: string): string {
    return `/api/extensions/permission-gate/${encodeURIComponent(sessionKey)}/mode`
}

function statusPath(agentId: string): string {
    return `/api/extensions/permission-gate/status?agent=${encodeURIComponent(agentId)}`
}

function buildPermissionModeState() {
    const chatState = useChatState()
    const mode = ref<PermissionMode>('autonomous')

    // 可用性线：permission-gate 对当前 agent 是否启用（输入栏选择框显隐）。
    // - 状态源 GET /status?agent=<agentId>（agent 视图裁决：已装载且未被
    //   全局∪agent 级禁用才算启用）；
    // - fail-safe：初始/未知 = 不可用（隐藏），服务端明确 enabled:true 才显示；
    // - 确定性不可用（404）收敛为隐藏：全局禁用（挂载期门禁 404）与旧服务端
    //   （无此路由）都落在这一分支；
    // - 其余拉取失败（网络抖动等）保持现态：已显示不因瞬时错误闪隐，下次重探自愈。
    const available = ref(false)
    let probeSeq = 0

    async function refreshAvailability(agentId: string): Promise<void> {
        if (!agentId) {
            available.value = false
            return
        }
        const seq = ++probeSeq
        try {
            const res = await apiGet<{ enabled?: unknown }>(statusPath(agentId), true)
            if (seq !== probeSeq) return // 乱序响应丢弃：旧探测不得覆盖新判定
            available.value = res?.enabled === true
        } catch (e) {
            if (seq !== probeSeq) return
            if (e instanceof ApiError && e.code === 404) {
                // 确定性不可用：全局禁用（挂载期门禁 404）或旧服务端无此路由 → 隐藏；
                // 不区分会导致「已显示 → 全局禁用后永不收敛」，与 fail-safe 语义相悳
                available.value = false
            }
            /* 其余失败保持现态（已显示不闪隐，下次重探自愈） */
        }
    }

    // agent 切换/会话切换都重探：同一 agent 重复拉取无状态代价，
    // 且顺带自愈管理面刚切换扩展开关的陈旧显隐
    watch(
        () => [chatState.agentsSelectedId, chatState.sessionKey] as const,
        ([agentId]) => {
            void refreshAvailability(agentId)
        },
        { immediate: true },
    )

    // 组件挂载重探（ChatInput setup 调）：管理面刚开关扩展后返回聊天页能立即反映，
    // 不必等 agent/会话切换（同会话往返不触发上面的 watch）。静默 GET，同一读链。
    function pokeAvailability(): void {
        void refreshAvailability(chatState.agentsSelectedId)
    }

    // 创建期标记：新会话首条消息携带 permissionMode 时，HomeView 在 prompt 发出前
    // 调 markAppliedMode 本地落地；commitNewSession 触发的切会话 GET（必然早于
    // 服务端落账返回）用 appliedKey 丢弃，防把乐观值冲回 autonomous。一次性哨兵：
    // 消费后后续导航照常拉取。拉取在途期间被标记同样丢弃（检查放在 resolve 后）。
    let appliedKey: string | null = null

    function markAppliedMode(key: string, next: PermissionMode): void {
        if (!isMode(next)) return
        appliedKey = key
        mode.value = next
    }

    async function refresh(sessionKey: string): Promise<void> {
        if (!sessionKey) return
        if (sessionKey === appliedKey) {
            appliedKey = null
            return
        }
        try {
            const res = await apiGet<{ mode?: unknown }>(modePath(sessionKey), true)
            if (sessionKey === appliedKey) {
                // fetch 在途期间会话被标记（创建期链路）：服务端此刻必然还是缺省值，丢弃
                appliedKey = null
                return
            }
            mode.value = isMode(res?.mode) ? res.mode : 'autonomous'
        } catch {
            /* 读失败按缺省 autonomous 显示（模式是便利层，基线不受影响） */
        }
    }

    watch(
        () => chatState.sessionKey,
        key => {
            void refresh(key)
        },
        { immediate: true },
    )

    async function setMode(next: PermissionMode): Promise<void> {
        const key = chatState.sessionKey
        if (!key || !isMode(next) || next === mode.value) return
        const prev = mode.value
        mode.value = next // 乐观更新；失败回滚
        try {
            await apiPost(modePath(key), { mode: next })
        } catch (e) {
            mode.value = prev
            useToast().error((i18n.global as any).t('chat.permMode.updateFailed'), 5000)
            throw e
        }
    }

    return { mode, setMode, markAppliedMode, available, pokeAvailability }
}

const _state = buildPermissionModeState()

export function usePermissionMode() {
    return _state
}
