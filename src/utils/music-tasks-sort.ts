// 音乐生成展示排序（纯函数，无依赖——node:test 可直测，useMusicGen 消费）。
// 服务端 ext.music_state 的 musics 已按 working 置顶 + lastActivityAt 倒序到达，
// 但按钮线/快照线的清单来源各异（stop 响应覆写、旧快照重放），排序在前端收敛
// （不动两仓契约；bg-agents 同模式）。

export interface SortableMusicTask {
    status: string
    lastActivityAt?: number
}

/** 运行中置顶，其余按最近活动倒序（刚完成的贴着运行区，一眼看到在跑的 + 刚出
 *  结果的）。时间缺失（老快照）垫底；同序稳定（现代引擎稳定排序）。
 *  寻址（stop）按 taskId，与顺序无关。 */
export function sortMusicTasks<T extends SortableMusicTask>(list: readonly T[]): T[] {
    const sorted = [...list]
    sorted.sort((a, b) => {
        if ((a.status === 'working') !== (b.status === 'working')) {
            return a.status === 'working' ? -1 : 1
        }
        return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })
    return sorted
}
