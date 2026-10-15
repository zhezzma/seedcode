// src/composables/extension-events.ts
// 客户端扩展事件总线：服务端扩展推送的瞬态 UI 事件（ext.goal_state 等）的统一订阅面。
// useChatState 按事件名前缀判别（isExtensionEvent）转发到本总线（switch default
// 分支 + attach handler 各一处），各扩展 composable 按事件名订阅。
// 零扩展知识：总线只认事件名字符串，不感知任何具体扩展。
// 前缀契约（两仓同步）：扩展事件名统一以 ext. 开头（服务端 contracts/extension-events.ts
// 的 EXTENSION_EVENT_PREFIX，注册中枢/emit 入口对不带前缀的事件 warn + 拦截）；
// 客户端判别据此进行——服务端新增核心事件客户端零改动。事件名具体值归扩展自有：
// 如 goal 扩展的 'ext.goal_state'（seedagent emitExtensionEvent 发射），
// 改名须两仓同步，否则状态条静默失去实时更新。

/** 扩展事件名前缀（与服务端 EXTENSION_EVENT_PREFIX 同值，改须两仓同步）。 */
export const EXTENSION_EVENT_PREFIX = 'ext.'

/** 扩展事件判别（前缀契约）：带前缀 → 转发本总线；否则按核心事件走 switch。 */
export function isExtensionEvent(name: string): boolean {
    return name.startsWith(EXTENSION_EVENT_PREFIX)
}

/** 监听器：data = 事件载荷（SSE JSON 解析产物）；sessionKey = 事件所在会话流
 *  （attach/run 流都按会话绑定，监听器据此过滤非当前会话的事件）。 */
export type ExtensionEventListener = (data: unknown, sessionKey?: string) => void

const listeners = new Map<string, Set<ExtensionEventListener>>()

/** 订阅扩展事件；返回注销函数。同名多监听器并存（都收到）。 */
export function onExtensionEvent(name: string, fn: ExtensionEventListener): () => void {
    let set = listeners.get(name)
    if (!set) {
        set = new Set()
        listeners.set(name, set)
    }
    set.add(fn)
    return () => {
        set.delete(fn)
    }
}

/** 转发事件（useChatState 调用）：单个监听器 throw 不饿死其余（同服务端扇出错误策略）。 */
export function emitExtensionEvent(name: string, data: unknown, sessionKey?: string): void {
    const set = listeners.get(name)
    if (!set) return
    for (const fn of set) {
        try {
            fn(data, sessionKey)
        } catch (e) {
            console.error('[extension-events] listener failed:', name, e)
        }
    }
}
