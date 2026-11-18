/** Teleport+fixed 浮层菜单定位（上下自适应 + 视口内 maxHeight）。
 *
 * trigger 的 getBoundingClientRect → 面板 fixed 样式：下方空间不足且上方更宽裕时
 * 向上开（bottom 锚），否则向下开（top 锚）。AgentSubagents 的模型下拉与
 * TeamMemberFields 的模型/思考菜单共用（两处同构，不再各自内联抄写；
 * AgentOverview 的移动端专用简化版语义不同，不在此列）。 */
export function computeFloatingMenuStyle(trigger: HTMLElement | null): Record<string, string> {
    const rect = trigger?.getBoundingClientRect()
    if (!rect) return {}

    const margin = 8
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow
    const maxHeight = Math.max(160, Math.min(320, (openUpward ? spaceAbove : spaceBelow) - margin * 2))

    const style: Record<string, string> = {
        position: 'fixed',
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        maxHeight: `${maxHeight}px`,
    }
    if (openUpward) {
        style.bottom = `${window.innerHeight - rect.top + 4}px`
    } else {
        style.top = `${rect.bottom + 4}px`
    }
    return style
}
