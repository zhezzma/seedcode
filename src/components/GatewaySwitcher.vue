<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { CheckIcon, Cog6ToothIcon, SunIcon, MoonIcon, ServerStackIcon, CloudIcon, ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline'
import { useUiSettingsStore, type GatewayProfile } from '../stores/setting'
import { localServer, switchGateway, gatewaySwitchBlockReason } from '../composables/local-server'
import { useToast } from '../composables/useToast'
import { gatewayHostLabel } from '../utils/gateway-url'
import { openExternalLink, parseExternalUrl } from '../utils/external-link'
import { apiGet } from '../composables/api-client'

defineProps<{ collapsed: boolean }>()

// 菜单关闭统一发 navigate：菜单内动作（跳转/外链）的收尾，如移动端收抽屉，交父级处理
const emit = defineEmits<{ (e: 'navigate'): void }>()

const { t } = useI18n()
const router = useRouter()
const toast = useToast()
const configStore = useUiSettingsStore()

const isOpen = ref(false)
const openUpward = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLElement | null>(null)


// 账号菜单项：local 托管条目（仅 bundled 构建）置顶 + 用户维护的 remote 条目
const menuEntries = computed<GatewayProfile[]>(() => {
    const local = configStore.gateways.filter((g) => g.type === 'local')
    const remote = configStore.gateways.filter((g) => g.type === 'remote')
    return localServer.bundled ? [...local, ...remote] : remote
})

const activeEntry = computed(() => configStore.activeGateway)

const activeName = computed(() => activeEntry.value?.name || t('gateway.noGateway'))
const activeIsLocal = computed(() => activeEntry.value?.type === 'local')

const entryHost = (entry: GatewayProfile): string => {
    if (entry.type === 'local') {
        return localServer.url ? gatewayHostLabel(localServer.url) : t('gateway.localManaged')
    }
    return gatewayHostLabel(entry.apiBaseUrl) || entry.apiBaseUrl
}

// 头像：名称首字母 + 按名称 hash 轮换色板（同 GatewayProfile 稳定同色）
const AVATAR_COLORS = ['bg-primary text-primary-content', 'bg-secondary text-secondary-content', 'bg-accent text-accent-content', 'bg-info text-info-content', 'bg-success text-success-content', 'bg-warning text-warning-content'] as const
const avatarClass = computed(() => {
    const name = activeName.value
    let hash = 0
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
    return AVATAR_COLORS[hash % AVATAR_COLORS.length]
})
const avatarLetter = computed(() => Array.from(activeName.value)[0]?.toUpperCase() ?? '?')

// 底部触发区与菜单头共用同一 host 展示逻辑
const activeHost = computed(() => activeEntry.value ? entryHost(activeEntry.value) : '')

// 菜单默认向下弹出；空间不足时翻向上（与 SessionActionMenu 同策略：以下方空间
// 不足且上方更宽裕为准，避免底部 footer 菜单被视口裁剪）
const determinePlacement = () => {
    const root = rootRef.value
    const trigger = triggerRef.value
    if (!root || !trigger) return
    const content = root.querySelector<HTMLElement>('.gateway-menu')
    if (!content) return
    const triggerRect = trigger.getBoundingClientRect()
    const spaceBelow = window.innerHeight - triggerRect.bottom
    const spaceAbove = triggerRect.top
    openUpward.value = spaceBelow < content.offsetHeight && spaceAbove >= spaceBelow
}

const openMenu = async () => {
    isOpen.value = true
    linksSubmenuOpen.value = false
    void loadExternalLinks()
    await nextTick()
    determinePlacement()
}

const closeMenu = () => {
    isOpen.value = false
    cancelLinksSubmenuClose()
    linksSubmenuOpen.value = false
    touchTapPending = false
    emit('navigate')
}

const toggleMenu = () => {
    if (isOpen.value) closeMenu()
    else void openMenu()
}

// 点击菜单外/按 Esc 关闭（浏览器在触屏设备上合成 mousedown，监听它即可同时覆盖鼠标/触摸）
const onDocumentMouseDown = (e: MouseEvent) => {
    if (!isOpen.value) return
    const target = e.target as Node | null
    if (target && rootRef.value?.contains(target)) return
    closeMenu()
}
const onDocumentKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isOpen.value) closeMenu()
}

watch(isOpen, (open) => {
    if (open) {
        document.addEventListener('mousedown', onDocumentMouseDown, true)
        document.addEventListener('keydown', onDocumentKeydown)
    } else {
        document.removeEventListener('mousedown', onDocumentMouseDown, true)
        document.removeEventListener('keydown', onDocumentKeydown)
    }
})

onBeforeUnmount(() => {
    document.removeEventListener('mousedown', onDocumentMouseDown, true)
    document.removeEventListener('keydown', onDocumentKeydown)
    cancelLinksSubmenuClose()
})

/** 切换账号：共享守卫（local 未就绪/remote 未填地址）拦截，通过则激活并 reload。 */
const switchTo = (entry: GatewayProfile) => {
    if (entry.id === configStore.activeGatewayId) {
        closeMenu()
        return
    }
    const blocked = gatewaySwitchBlockReason(entry)
    if (blocked) {
        toast.warning(t(blocked))
        return
    }
    closeMenu()
    switchGateway(entry.id)
}

const addServer = () => {
    closeMenu()
    // 深链：设置页连接弹窗读取 query 直接落入新增草稿态（与打开时聚焦激活条目区分）
    void router.push({ path: '/settings', query: { gateway: 'new' } })
}

const openSettings = () => {
    closeMenu()
    void router.push('/settings')
}

/** 外部链接（服务端 external-links 扩展清单的只读展示）：
 *  菜单打开时拉取一次（silent：服务器未部署该扩展/不可达不弹全局 toast，
 *  子面板内联提示），hover 条目右侧弹子面板，点行经 openExternalLink 打开。
 *  导航机制同旧实现：JS 触发一次性 <a target="_blank">（utils/external-link），
 *  不用 opener 插件、不用 window.open——后者在 Tauri WebView 内不可靠。 */
interface ExternalLinkItem {
    id: string
    name: string
    url: string
}

const externalLinks = ref<ExternalLinkItem[]>([])
const linksLoading = ref(false)
const linksLoadFailed = ref(false)
const linksSubmenuOpen = ref(false)
let linksCloseTimer: ReturnType<typeof setTimeout> | undefined
// 迟响应闸：跨网关切换/快速开关菜单时，旧服务器请求的响应不得覆盖当前列表
let linksRequestSeq = 0

// 触屏点按会派发兼容性 mouse 事件（pointerdown → mouseenter → click）：hover 处理器
// 若不设防，首点会被「mouseenter 开 + click」的重复处理吞掉或无法再点关。用
// pointerdown 的 pointerType 识别触控：触控点按期间抑制 hover 处理器，click 对
// 所有指针类型统一 toggle（首点开、再点关）；鼠标路径完全不受影响。
let touchTapPending = false

const onLinksButtonPointerDown = (e: PointerEvent) => {
    touchTapPending = e.pointerType !== 'mouse'
}

const onLinksEnter = () => {
    if (!touchTapPending) openLinksSubmenu()
}

const onLinksLeave = () => {
    if (!touchTapPending) scheduleLinksSubmenuClose()
}

const loadExternalLinks = async () => {
    linksLoading.value = true
    linksLoadFailed.value = false
    const requestSeq = ++linksRequestSeq
    try {
        const payload = await apiGet<{ links?: Array<{ id?: unknown; name?: unknown; url?: unknown }> }>(
            '/api/extensions/external-links/links', true)
        if (requestSeq !== linksRequestSeq) return // 迟响应：已有更新请求，丢弃本次结果
        // 服务端已做净化，这里只做形状防御：非字符串 url 的条目丢弃
        externalLinks.value = (payload?.links ?? []).map((link, index) => ({
            id: typeof link?.id === 'string' && link.id ? link.id : `idx-${index}`,
            name: typeof link?.name === 'string' ? link.name : '',
            url: typeof link?.url === 'string' ? link.url : '',
        })).filter((link) => link.url !== '')
    } catch {
        if (requestSeq === linksRequestSeq) linksLoadFailed.value = true
    } finally {
        if (requestSeq === linksRequestSeq) linksLoading.value = false
    }
}

/** 行显示名：名称留空回退 URL 域名（parseExternalUrl 过非法 URL 再退原始串） */
const linkLabel = (link: ExternalLinkItem): string => {
    if (link.name.trim()) return link.name
    return parseExternalUrl(link.url)?.host ?? link.url
}

const cancelLinksSubmenuClose = () => {
    if (linksCloseTimer !== undefined) {
        clearTimeout(linksCloseTimer)
        linksCloseTimer = undefined
    }
}

const scheduleLinksSubmenuClose = () => {
    cancelLinksSubmenuClose()
    // 短延迟跨越条目→子面板的间隙；子面板 mouseenter 会取消
    linksCloseTimer = setTimeout(() => {
        linksSubmenuOpen.value = false
        linksCloseTimer = undefined
    }, 150)
}

const openLinksSubmenu = () => {
    cancelLinksSubmenuClose()
    linksSubmenuOpen.value = true
}

const toggleLinksSubmenu = () => {
    // 所有指针类型统一 toggle：首点开、再点关（含触屏——点击外部链接可关闭已开的子菜单）
    touchTapPending = false
    if (linksSubmenuOpen.value) {
        cancelLinksSubmenuClose()
        linksSubmenuOpen.value = false
    } else {
        openLinksSubmenu()
    }
}

/** 打开链接：先关菜单再触发（关菜单发 navigate 收尾抽屉，如移动端），
 *  导航本身仍是原生 <a target="_blank">（openExternalLink） */
const openLink = (link: ExternalLinkItem) => {
    closeMenu()
    openExternalLink(link.url)
}
</script>

<template>
    <div ref="rootRef" class="relative shrink-0 border-t border-base-300 px-3 py-1.5">
        <!-- 触发区：当前网关头像 + 名称 + 地址（collapsed 时只留头像）；
             名称/地址与菜单头保持一致，不随视口宽度隐藏（移动端抽屉同样展示）。
             高度预算：以头像 h-8(32px) 为基准。两行文字必须压进 32px——默认行高
             text-sm(20px)+text-xs(16px)=36px 会反超头像成为高度元凶，故两行都挂
             leading-4(16px)；配触发容器 p-1 与容器 py-1.5，整块含上边框约 53px
             （原约 65px）。改头像尺寸时同步改这里的两行行高，否则文字会重新撑高 -->
        <!-- 外层 div 只做布局、不触发事件；头像+名称+图标包进内层 button，由它触发下拉 -->
        <div ref="triggerRef" class="flex w-full items-center gap-2 p-1"
            :class="collapsed && 'lg:justify-center lg:px-0'">
            <button type="button"
                class="flex flex-1 min-w-0 items-center gap-2 rounded-xl text-left transition-colors hover:bg-base-300/90  px-2  cursor-pointer"
                :class="collapsed && 'lg:justify-center lg:px-0'"
                :title="activeEntry ? `${activeName} · ${activeHost}` : activeName" :aria-label="t('gateway.switchAccount')"
                :aria-expanded="isOpen" aria-haspopup="menu" @click.stop="toggleMenu">
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                    :class="avatarClass">
                    {{ avatarLetter }}
                </span>
                <span v-if="!collapsed" class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-semibold leading-4 text-base-content">{{ activeName }}</span>
                    <span class="block truncate text-xs leading-4 text-base-content/50">{{ activeHost }}</span>
                </span>
                <ServerStackIcon v-if="!collapsed && activeIsLocal" class="h-4 w-4 shrink-0 text-primary" />
                <CloudIcon v-else-if="!collapsed" class="h-4 w-4 shrink-0 text-base-content/40" />
            </button>


            <!-- 折叠态只留头像（w-16 塞不下这两个按钮），与组件内其它 collapsed 类一致挂 lg: 前缀 -->
            <button @click="configStore.toggleTheme()" type="button"
                class="btn btn-ghost btn-circle btn-xs" :class="collapsed && 'lg:hidden'">
                <SunIcon v-if="configStore.isDark" class="h-4 w-4" />
                <MoonIcon v-else class="h-4 w-4" />
            </button>
            <button type="button" class="btn btn-ghost btn-circle btn-xs" :class="collapsed && 'lg:hidden'" @click="openSettings">
                <Cog6ToothIcon class="h-4 w-4" />
            </button>
        </div>

        <!-- 账号菜单（弹出层） -->
        <!-- 自定义 hook 类名 gateway-menu：不用 daisyUI 的 dropdown-content，
             避免无 .dropdown 祖先时依赖其对 closed 态样式的实现细节 -->
        <div v-if="isOpen"
            class="gateway-menu absolute z-50 w-64 rounded-2xl border border-base-300 bg-base-100 p-1 shadow-lg"
            :class="openUpward ? 'bottom-full mb-1 left-3' : 'top-full mt-1 left-3'" @click.stop>
            <!-- 当前网关详情头 -->
            <div class="flex items-center gap-2 px-3 py-2">
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                    :class="avatarClass">
                    {{ avatarLetter }}
                </span>
                <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-semibold leading-4">{{ activeName }}</span>
                    <span class="block truncate text-xs leading-4 text-base-content/50">{{ activeHost }}</span>
                </span>
            </div>
            <div class="mx-2 my-1 border-t border-base-300"></div>

            <!-- 账号列表：当前条目 ✓，点击切换；max-h 封顶内部滚动，条目多时不溢出视口 -->
            <ul class="menu menu-compact w-full p-0 max-h-64 overflow-y-auto" role="menu">
                <li v-for="entry in menuEntries" :key="entry.id" role="none">
                    <button type="button" role="menuitem" class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
                        :class="entry.id === configStore.activeGatewayId ? 'bg-base-300/60 font-semibold' : ''"
                        @click="switchTo(entry)">
                        <span
                            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                            :class="entry.type === 'local' ? 'bg-primary/15 text-primary' : 'bg-base-300 text-base-content/70'">
                            {{ Array.from(entry.name)[0]?.toUpperCase() ?? '?' }}
                        </span>
                        <span class="min-w-0 flex-1 truncate text-left">{{ entry.name }}</span>
                        <span class="shrink-0 text-xs text-base-content/40 truncate max-w-[6rem]">{{ entryHost(entry)
                            }}</span>
                        <CheckIcon v-if="entry.id === configStore.activeGatewayId"
                            class="h-4 w-4 shrink-0 text-primary" />
                    </button>
                </li>
            </ul>

            <ul class="menu menu-compact w-full p-0 mt-1" role="menu">
                <!-- 外部链接：服务端 external-links 扩展清单的只读展示。hover（触屏点击）
                     弹右侧子面板，链接的增删改在服务端扩展设置表单里做，这里纯展示。 -->
                <li role="none" class="relative pt-1 border-t border-base-300"
                    @mouseenter="onLinksEnter" @mouseleave="onLinksLeave">
                    <button type="button" role="menuitem" class="rounded-xl px-3 py-2 text-sm w-full"
                        :aria-expanded="linksSubmenuOpen" aria-haspopup="menu"
                        @pointerdown="onLinksButtonPointerDown" @click="toggleLinksSubmenu">
                        <ArrowTopRightOnSquareIcon class="h-4 w-4" />
                        {{ t('gateway.externalLink') }}
                    </button>
                    <!-- 链接子面板：桌面 lg: 飞出右侧（锚 li 底沿向上长，扫避视口下缘）；
                         移动端无 hover，叠在主菜单上方（抽屉 w-80 内右侧放不下）。
                         max-h 封顶内部滚动，同账号列表策略；PC 端可视高度加大到 96（移动端维持 64） -->
                    <div v-if="linksSubmenuOpen" class="external-links-submenu block absolute z-50 w-56 rounded-2xl border border-base-300 bg-base-100 p-1 shadow-lg
                             max-h-64 lg:max-h-96 overflow-y-auto max-lg:left-0 max-lg:right-0 max-lg:w-auto max-lg:bottom-full max-lg:mb-1
                             lg:left-full lg:bottom-0 lg:ml-1"
                        role="menu" @mouseenter="cancelLinksSubmenuClose" @mouseleave="scheduleLinksSubmenuClose" @click.stop>
                        <div v-if="linksLoading" class="flex items-center gap-2 px-3 py-2 text-sm text-base-content/50">
                            <span class="loading loading-spinner loading-sm"></span>
                            {{ t('common.loading') }}
                        </div>
                        <div v-else-if="linksLoadFailed" class="px-3 py-2 text-xs text-base-content/50">
                            {{ t('gateway.externalLinkLoadFailed') }}
                        </div>
                        <div v-else-if="externalLinks.length === 0" class="px-3 py-2 text-xs text-base-content/50">
                            {{ t('gateway.externalLinkEmpty') }}
                        </div>
                        <template v-else>
                            <button v-for="link in externalLinks" :key="link.id" type="button" role="menuitem"
                                class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-base-300/90"
                                :title="link.url" @click="openLink(link)">
                                <span class="min-w-0 flex-1 truncate text-left">{{ linkLabel(link) }}</span>
                            </button>
                        </template>
                    </div>
                </li>
            </ul>
        </div>
    </div>
</template>

<style scoped>
/* daisyUI .menu 的按下(:active)高亮默认取 --color-neutral（暗色下比弹出层背景还暗，
   视觉上是"点一下闪黑块"且随 0.2s transition 短暂停留）。这两个变量是 daisyUI
   直接声明在 .menu(ul) 自身上的，不能设在祖先靠继承覆盖（会被遮蔽），
   必须选中 ul 本身。改成与 hover 一致的 base-content 10% 混合色 */
.gateway-menu :where(ul.menu) {
    --menu-active-bg: color-mix(in oklab, var(--color-base-content) 10%, transparent);
    --menu-active-fg: var(--color-base-content);
}
</style>
