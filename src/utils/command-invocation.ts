/**
 * 「投递类」命令：走控制 API（POST /steer|/follow-up|/abort）而非 /chat。
 * 服务端命令表为权威；新增/改名须同步此处（HomeView 的 deliveryCommandPattern
 * 由它派生，tests/busy-send-pills.test.ts 锚定）。
 */
export const DELIVERY_COMMANDS = ['follow-up', 'steer', 'abort'] as const

/**
 * busy 时仍放行走 /chat 的命令白名单（其余已知命令 busy 不可用）。
 * 投递类命令不在此列（见 DELIVERY_COMMANDS）。
 * goal 全系 busy 时不经 /chat（含 off）——停止/恢复走扩展路由按钮
 * （POST /api/extensions/goal/:sessionId/stop|resume），故白名单为空。
 */
export const BUSY_ALLOWED_COMMANDS = [] as const

/**
 * 判断一条用户消息是否会被后端按「命令」处理（而非作为普通 prompt 发给模型）。
 *
 * 后端（seedagent CommandHandler）的真实语义：
 * - `!` 开头 → bash 命令
 * - `/xxx` → 仅当命中 builtin / 扩展注册命令时才拦截；未知的 `/xxx`（如
 *   `/etc/hosts 是什么` 这类路径开头的正常消息）会作为普通 prompt 发给模型
 *
 * 因此 `/` 开头时须按命令表精确匹配首 token。knownCommandNames 传 null 表示
 * 命令表未加载，保守回退为「是命令」（与旧的 startsWith 行为一致）。
 */
export function isCommandInvocation(text: string, knownCommandNames: readonly string[] | null): boolean {
    const trimmed = text.trimStart()
    if (!trimmed) return false
    if (trimmed.startsWith('!')) return true
    if (!trimmed.startsWith('/')) return false
    if (!knownCommandNames || knownCommandNames.length === 0) return true
    const name = (trimmed.slice(1).split(/\s+/)[0] || '').toLowerCase()
    return knownCommandNames.some(cmd => cmd.toLowerCase() === name)
}
