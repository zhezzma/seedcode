// src/composables/usePermissionMode.ts
// 会话权限模式（seedagent permission-gate 扩展会话模式层）：输入栏下拉三档粗调。
// - 拉取线：挂载/切会话时 GET（silent：失败按缺省 autonomous 显示，不弹全局 toast）；
// - 写入线：POST 乐观更新（失败回滚 + toast）；busy 期允许切档
//   （服务端无 busy 门禁——运行中切 full 解卡是主用例）。
// 下拉恒显示：连到旧服务端（无此扩展路由）时点切换会收到 404 toast，反馈直接可见，
// 不做静默隐藏。
// 模块级单例（useGoalState 同模式）：输入栏下拉跨组件共享一份现态。
import { ref, watch } from 'vue'
import { apiGet, apiPost } from './api-client'
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

function buildPermissionModeState() {
    const chatState = useChatState()
    const mode = ref<PermissionMode>('autonomous')

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

    return { mode, setMode, markAppliedMode }
}

const _state = buildPermissionModeState()

export function usePermissionMode() {
    return _state
}
