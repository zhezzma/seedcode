import type { CommandInfo } from './useCommandState'

// ==================== 客户端命令统一注册表 ====================
// 客户端命令 = 前端本地拦截处理、不经服务端的命令（如 /tasklist 重现会话工作步骤面板、
// /tree 打开会话树；服务端命令表 /api/commands 不含它们，故 / 补全需前端合并）。
// 本注册表是唯一事实来源，两处消费：
//   1. `/` 补全浮层：useChatInput 的 watch 按前缀合并（按 name 去重，防服务端未来同名下发）
//   2. 「命令」按钮下拉：ChatInput 渲染为「本地指令」分区
// 新增客户端命令只需在此追加一条，两处自动可见；HomeView 等调用方仍各自负责拦截执行
// （busy 拦截命令另需标注 intercept + handleSend 分支，见字段注释）。

/** 客户端命令 = CommandInfo + 下拉条目元数据 */
export interface ClientCommand extends CommandInfo {
    /** 「命令」下拉显示文案（如 '/tasklist (会话工作步骤)'）；缺省用 `/${name}` */
    dropdownLabel?: string
    /** 下拉选中后是否自动发送；缺省跟随全局 autoSendCommands 设置（与 CommandItem.autoSend 语义一致） */
    autoSend?: boolean
    /** busy 期间的客户端拦截语义：HomeView.handleSend 在 steer/follow-up mode 分流前拦截执行
     *  （mode 不被消费），ChatInput 据此在 busy 时回退原发送按钮而非双胶囊。
     *  - 'exact'：仅裸命令名命中（如 /tree，带参数会被当普通文本走 mode）；
     *  - 'prefix'：命令名后可跟参数（如 /tasklist xxx）。
     *  新增拦截命令时：在此标注 + 在 handleSend 写对应分支（两者由
     *  tests/busy-send-pills.test.ts 的注册表↔HomeView 对齐测试锚定）；
     *  缺省 = 不拦截，按普通文本走 mode。 */
    intercept?: 'exact' | 'prefix'
}

export const CLIENT_COMMANDS: ClientCommand[] = [
    { name: 'tasklist', description: '会话工作步骤面板', source: 'client', dropdownLabel: '/tasklist (会话工作步骤)', intercept: 'prefix' },
    { name: 'tree', description: '会话树', source: 'client', dropdownLabel: '/tree (会话树)', intercept: 'exact' },
    // 不能叫 /goal：那是服务端真命令（裸 /goal = 帮助），劫持会改变其语义；独立名避免冲突。
    // 同名时 / 补全按 name 去重会隐藏客户端条目（服务端优先），goalbar 无服务端同名，下拉可见
    { name: 'goalbar', description: '自动续跑状态条', source: 'client', dropdownLabel: '/goalbar (自动续跑状态条)', intercept: 'prefix' },
]

/**
 * busy UI 谓词：文本是否命中「会在 HomeView mode 分流前被客户端拦截」的命令。
 * 匹配语义与 handleSend 各分支逐字对齐：exact → 整段修剪文本 === '/name'
 * （区分大小写）；prefix → /^\/name(?:\s|$)/i。内部容忍未修剪文本。
 */
export const isClientInterceptedCommand = (text: string): boolean => {
    const trimmed = text.trim()
    return CLIENT_COMMANDS.some(cmd => {
        if (!cmd.intercept) return false
        if (cmd.intercept === 'exact') return trimmed === `/${cmd.name}`
        return new RegExp(`^\\/${cmd.name}(?:\\s|$)`, 'i').test(trimmed)
    })
}

/** 按输入前缀（不含 `/`）过滤客户端命令 → 纯 CommandInfo（供 / 补全合并） */
export const filterClientCommands = (prefix: string): CommandInfo[] =>
    CLIENT_COMMANDS
        .filter(cmd => cmd.name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map(cmd => ({ name: cmd.name, description: cmd.description, source: cmd.source }))
