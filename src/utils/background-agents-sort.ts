// 后台子代理展示排序（纯函数，无依赖——node:test 可直测，useBackgroundAgents 消费）。
// 服务端 ext.subagent_state 的 agents 是 Record（名字插入序 = spawn 先后），不区分
// 运行态；列表是纯展示面，排序在前端做（不动两仓契约）。

export interface SortableBackgroundAgent {
    status: string
    lastActivityAt?: number
}

/** 运行中置顶，其余按最近活动倒序（刚完成的贴着运行区，一眼看到在跑的 + 刚出结果的）。
 *  纯 createdAt 倒序会把早 spawn 但还在跑的老工人压到已完成堆下面，故按状态分层 +
 *  活动时间排。时间缺失（老快照）垫底；同序稳定（现代引擎稳定排序）。
 *  寻址（stop/send）按 name，与顺序无关。 */
export function sortBackgroundAgents<T extends SortableBackgroundAgent>(list: readonly T[]): T[] {
    const sorted = [...list]
    sorted.sort((a, b) => {
        if ((a.status === 'working') !== (b.status === 'working')) {
            return a.status === 'working' ? -1 : 1
        }
        return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })
    return sorted
}
