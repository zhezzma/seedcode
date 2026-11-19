/**
 * Teleport+fixed 浮层菜单单元与互斥组（TeamGroupWizard/TeamMemberFields 的
 * 模型+思考下拉共用接线——v7.6 收敛：此前两组件各持一份逐行同构的
 * 开合状态+外点关闭+视口跟随+生命周期挂卸，~70 行×2）。
 *
 * 单元（useFloatingMenu）：开合状态+触发钮/面板 ref+定位样式+开时定位。
 * 定位计算唯一实现仍是 utils/floating-menu 的 computeFloatingMenuStyle
 * （上下自适应+视口内 maxHeight，AgentSubagents 同源）。
 * 组（useFloatingMenuGroup）：document 点击外点关闭+resize/scroll 视口跟随
 * +挂载/卸载生命周期成对挂卸；菜单间互斥由消费侧一行组合（开 A 关 B）。
 */
import { nextTick, onMounted, onUnmounted, ref, type Ref } from 'vue'
import { computeFloatingMenuStyle } from '../utils/floating-menu'

export interface FloatingMenu {
    /** 菜单开合（模板绑定 v-if） */
    open: Ref<boolean>
    /** 触发按钮 ref（定位基准+外点判定） */
    triggerRef: Ref<HTMLElement | null>
    /** 浮层面板 ref（外点判定） */
    panelRef: Ref<HTMLElement | null>
    /** Teleport 面板内联定位样式 */
    menuStyle: Ref<Record<string, string>>
    /** 切换开合（开时 nextTick 定位） */
    toggle: () => void
    /** 关闭 */
    close: () => void
    /** 视口变化后重定位（开着的菜单由组统一驱动，个别场景可直调） */
    updatePosition: () => void
}

/** 单个浮层菜单单元（纯状态与动作，不含全局监听）。 */
export function useFloatingMenu(): FloatingMenu {
    const open = ref(false)
    const triggerRef = ref<HTMLElement | null>(null)
    const panelRef = ref<HTMLElement | null>(null)
    const menuStyle = ref<Record<string, string>>({})
    const updatePosition = () => {
        menuStyle.value = computeFloatingMenuStyle(triggerRef.value)
    }
    const close = () => {
        open.value = false
    }
    const toggle = () => {
        open.value = !open.value
        if (open.value) nextTick(updatePosition)
    }
    return { open, triggerRef, panelRef, menuStyle, toggle, close, updatePosition }
}

/** 浮层菜单组：外点全关 + resize/scroll 视口跟随 + 生命周期成对挂卸。 */
export function useFloatingMenuGroup(menus: readonly FloatingMenu[]): void {
    const onDocClick = (event: MouseEvent) => {
        const target = event.target as Node | null
        if (!target) return
        for (const menu of menus) {
            if (menu.open.value
                && !menu.triggerRef.value?.contains(target)
                && !menu.panelRef.value?.contains(target)) {
                menu.close()
            }
        }
    }
    const onViewportChange = () => {
        for (const menu of menus) {
            if (menu.open.value) menu.updatePosition()
        }
    }
    onMounted(() => {
        document.addEventListener('click', onDocClick)
        window.addEventListener('resize', onViewportChange)
        window.addEventListener('scroll', onViewportChange, true)
    })
    onUnmounted(() => {
        document.removeEventListener('click', onDocClick)
        window.removeEventListener('resize', onViewportChange)
        window.removeEventListener('scroll', onViewportChange, true)
    })
}
