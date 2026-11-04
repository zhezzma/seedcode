/**
 * `/` 命令补全的统一名称匹配与排序规则。
 *
 * 服务端命令（builtin / extension / prompt / skill:<name>）与客户端命令
 * （clientCommands 注册表）共用同一条规则，不允许两套口径各自演化：
 *
 * 匹配（matchCommandQuery / commandMatchRank）：
 * 1. 精确同名：/taskbar === taskbar；
 * 2. 全名前缀：/skill:wait 命中 skill:wait-what，/tas 命中 taskbar
 *    （命名空间照常可以手打）；
 * 3. 名字段精确：/wait 命中 skill:wait（不打命名空间也能精确指名）；
 * 4. 名字段子串：最后一个 `:` 之后的段包含输入即命中——
 *    /what 命中 skill:wait-what，/bar 命中 taskbar，不限技能；
 *    无 `:` 的命令整名即名字段。命名空间本身（`skill:`）不参与子串搜索
 *    （输入 kill / ill 不会命中所有技能）；query 含 `:` 时只走精确/全名前缀。
 *
 * 排序（sortByCommandMatchRank）：精确 > 全名前缀 > 名字段精确 > 名字段子串，
 * 同级保持原相对顺序（V8 sort 稳定）。子串放宽后，若不分级，「手打全名 + Enter」
 * 默认确认的 index 0 可能被某个弱命中抢占（如 skill:x-taskbar 抢 /taskbar，
 * 或表序靠前的 skill:wait-what 抢 /wait 对应的 skill:wait）。
 *
 * 大小写不敏感；空查询恒匹配且全部按前缀档保持原序（输入裸 `/` 显示全量）。
 * 注意：这里只管「补全列表怎么过滤/排序」，不管「这条消息算不算命令调用」——
 * 后者仍是精确匹配（utils/command-invocation.ts），/what 不会被当成命令执行。
 */

/** 命中强度：-1 不命中；0 精确同名；1 全名前缀；2 名字段精确；3 名字段子串 */
export function commandMatchRank(name: string, query: string): number {
    const lcName = name.toLowerCase()
    const lcQuery = query.toLowerCase()
    if (!lcQuery) return 1
    if (lcName === lcQuery) return 0
    if (lcName.startsWith(lcQuery)) return 1
    // 名字段 = 最后一个 `:` 之后（skill:wait-what → wait-what）；无 `:` 则整名
    const sep = lcName.lastIndexOf(':')
    const segment = sep >= 0 ? lcName.slice(sep + 1) : lcName
    if (segment === lcQuery) return 2
    return segment.includes(lcQuery) ? 3 : -1
}

export function matchCommandQuery(name: string, query: string): boolean {
    return commandMatchRank(name, query) >= 0
}

/** 按统一匹配规则过滤（不排序，保持传入顺序；排序交给 sortByCommandMatchRank） */
export function filterByCommandQuery<T extends { name: string }>(
    commands: readonly T[],
    query: string,
): T[] {
    return commands.filter(cmd => matchCommandQuery(cmd.name, query))
}

/** 过滤 + 按命中强度稳定排序：精确 > 全名前缀 > 名字段精确 > 名字段子串，
 *  同级保持原相对顺序。不命中的条目不进结果（调用方即便忘了预过滤也不会把
 *  弱相关项顶到面板头部）。不异变传入数组。 */
export function sortByCommandMatchRank<T extends { name: string }>(
    commands: readonly T[],
    query: string,
): T[] {
    return commands
        .filter(cmd => matchCommandQuery(cmd.name, query))
        .sort((a, b) => commandMatchRank(a.name, query) - commandMatchRank(b.name, query))
}
