/**
 * hooks.ts — 钩子管理页的纯函数与类型（无框架依赖，可单测）。
 *
 * 对应服务端 seedagent hooks 扩展（src/extensions/hooks/types.ts）的
 * HookConfig 契约与 spec §3 事件表。校验规则镜像服务端：timeoutSec 整数
 * 1–600（ServerStop 上限 30）、custom 必须是 JSON 对象、服务器事件 agents
 * 强制 "*"。
 */

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'
    | 'PostToolUseFailure' | 'ServerStart' | 'ServerStop'

/** 服务端生命周期事件，7 个，顺序同 spec §3 表。 */
export const HOOK_EVENTS: readonly HookEvent[] = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'ServerStart',
    'ServerStop',
]

/** 工具事件：用 matcher 按工具名过滤（UI 据此显隐 matcher 输入）。 */
export function isToolEvent(e: HookEvent): boolean {
    return e === 'PreToolUse' || e === 'PostToolUse' || e === 'PostToolUseFailure'
}

/** 服务器事件：不用 matcher；服务端强制 agents 为 "*"（ServerStop 超时上限也更小）。 */
export function isServerEvent(e: HookEvent): boolean {
    return e === 'ServerStart' || e === 'ServerStop'
}

/** timeoutSec 上限：ServerStop 30（服务器关停要快），其余 600。 */
export function maxTimeoutFor(e: HookEvent): number {
    return e === 'ServerStop' ? 30 : 600
}

/** 与服务端 HookConfig 同形（spec §5.1 字段形状）。 */
export interface HookItem {
    id: string
    enabled: boolean
    event: HookEvent
    runMode: 'shell' | 'process'
    command: string
    /** 只在 process 模式使用 */
    args: string[]
    /** 只在 shell 模式使用；"" 表示默认 shell */
    shell: string
    /** 只对工具事件生效；"" 表示所有工具 */
    matcher: string
    /** 默认 false；只在 shell 模式生效 */
    background: boolean
    /** 整数 1–600，默认 60；ServerStop 最大 30 */
    timeoutSec: number
    /** 最多 200 字，只写进服务端日志 */
    statusMessage: string
    /** 表单「自定义字段 JSON」，必须是对象 */
    custom?: Record<string, unknown>
    /** 作用域；服务器事件只能是 "*" */
    agents: '*' | string[]
    createdAt: string
    updatedAt: string
}

/** 编辑弹窗表单模型：args 数组 → 逐行文本，custom 对象 → JSON 文本。 */
export interface HookForm {
    event: HookEvent
    runMode: 'shell' | 'process'
    command: string
    /** process 模式参数，一行一个 */
    argsText: string
    shell: string
    matcher: string
    background: boolean
    timeoutSec: number
    statusMessage: string
    /** 自定义字段 JSON 文本；空 = 不下发 custom */
    customText: string
    agentsAll: boolean
    agents: string[]
    enabled: boolean
}

export function emptyHookForm(): HookForm {
    return {
        event: 'PreToolUse',
        runMode: 'shell',
        command: '',
        argsText: '',
        shell: '',
        matcher: '',
        background: false,
        timeoutSec: 60,
        statusMessage: '',
        customText: '',
        agentsAll: true,
        agents: [],
        enabled: true,
    }
}

export function hookFormFromItem(item: HookItem): HookForm {
    return {
        ...emptyHookForm(),
        event: item.event,
        runMode: item.runMode,
        command: item.command,
        argsText: (item.args ?? []).join('\n'),
        shell: item.shell,
        matcher: item.matcher,
        background: item.background,
        timeoutSec: item.timeoutSec,
        statusMessage: item.statusMessage,
        customText: item.custom !== undefined ? JSON.stringify(item.custom, null, 2) : '',
        agentsAll: item.agents === '*',
        agents: item.agents === '*' ? [] : [...item.agents],
        enabled: item.enabled,
    }
}

/** argsText → args：逐行 trim，丢弃空行。 */
function parseArgsText(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
}

/** 表单 → 服务端 payload。调用前须 validateHookForm 通过（customText 会 JSON.parse）。 */
export function hookFormToPayload(form: HookForm): Record<string, unknown> {
    const customText = form.customText.trim()
    // 服务器事件：服务端先校验后强制，agents: [] 会被 400 拒绝，出口先行 coercion 保证必过校验
    const server = isServerEvent(form.event)
    return {
        event: form.event,
        runMode: form.runMode,
        command: form.command.trim(),
        args: parseArgsText(form.argsText),
        shell: form.shell.trim(),
        // matcher 只对工具事件有意义（服务端 candidatesFor 仅工具事件消费它）；
        // 非工具事件出口清空，避免「SessionStart · Bash」式永不生效的残留落库
        matcher: isToolEvent(form.event) ? form.matcher.trim() : '',
        // background 只在 shell 模式生效（spec §5.3），process 模式强制 false；
        // 服务器事件按 ServerStart true / ServerStop false 强制
        background: server ? form.event === 'ServerStart' : form.runMode === 'shell' ? form.background : false,
        timeoutSec: form.timeoutSec,
        statusMessage: form.statusMessage.trim(),
        ...(customText !== '' ? { custom: JSON.parse(customText) } : {}),
        agents: server ? '*' : form.agentsAll ? '*' : [...form.agents],
        enabled: form.enabled,
    }
}

export type HookFormErrorKey = 'commandRequired' | 'timeoutInvalid' | 'customInvalid' | 'agentsRequired' | 'argsMax' | 'customTooLarge'

/** customText 必须是 JSON 对象（数组/标量/null/残缺 JSON 都拒，镜像服务端）。 */
function parseCustomText(text: string): Record<string, unknown> | undefined {
    const trimmed = text.trim()
    if (trimmed === '') return undefined
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object')
    }
    return parsed as Record<string, unknown>
}

/** 表单校验：返回全部错误 key（空数组 = 通过）。服务端仍是最终裁判。 */
/** 服务端 store.ts 的 ARGS_MAX / CUSTOM_MAX_BYTES 镜像（提交前预检；服务端仍是最终裁判）。 */
const ARGS_MAX = 100
const CUSTOM_MAX_BYTES = 16 * 1024

export function validateHookForm(form: HookForm): HookFormErrorKey[] {
    const errors: HookFormErrorKey[] = []
    if (form.command.trim() === '') errors.push('commandRequired')
    const max = maxTimeoutFor(form.event)
    if (!Number.isInteger(form.timeoutSec) || form.timeoutSec < 1 || form.timeoutSec > max) {
        errors.push('timeoutInvalid')
    }
    if (parseArgsText(form.argsText).length > ARGS_MAX) errors.push('argsMax')
    try {
        const custom = parseCustomText(form.customText)
        // 与服务端同口径：JSON.stringify 后的 UTF-8 字节数
        if (custom !== undefined && new TextEncoder().encode(JSON.stringify(custom)).length > CUSTOM_MAX_BYTES) {
            errors.push('customTooLarge')
        }
    } catch {
        errors.push('customInvalid')
    }
    // 服务器事件 agents 强制 "*"（服务端行为），前端不拦
    if (!form.agentsAll && form.agents.length === 0 && !isServerEvent(form.event)) {
        errors.push('agentsRequired')
    }
    return errors
}
