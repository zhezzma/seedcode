<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUiSettingsStore } from './stores/setting'
import MessagePlugin from './components/MessagePlugin.vue'
import ConfirmPlugin from './components/ConfirmPlugin.vue'
import WindowControls from './components/WindowControls.vue'
import ExecApprovalModal from './components/ExecApprovalModal.vue'
import { useAppInit } from './composables/useAppInit'
import { ApiError } from './composables/api-client'
import { useSessionsState } from './composables/useSessionsState'
import { isForegroundReloadSuppressed } from './composables/useNotificationReloadGuard'
import { shouldReloadAfterForeground } from './utils/notification-routing'
import { listen } from '@tauri-apps/api/event'
import { localServer, isLocalServerBooting, isLocalServerBootFailed, restartLocalServer } from './composables/local-server'

// 内置服务端启动门控：local 模式下端口监听前 UI 照常渲染，仅盖淡磨砂 veil（数据加载已在 useAppInit 暂停）；
// 初始启动失败才显示错误与重启入口（reload 重走 init）。运行过一次后不再门控（崩溃走既有容错）。
const bootGateVisible = computed(() => isLocalServerBooting())
const bootFailedVisible = computed(() => isLocalServerBootFailed())
const onBootRestart = async () => {
    await restartLocalServer()
    window.location.reload()
}

// Initialize app
const uiSettings = useUiSettingsStore()
uiSettings.initTheme()
uiSettings.initLanguage()

const appInit = useAppInit()
appInit.init()




const router = useRouter()
const sessionsState = useSessionsState()
let unlistenFocus: (() => void) | null = null

const MOBILE_BACKGROUND_RELOAD_MS = 60_000
const FOREGROUND_RELOAD_GRACE_MS = 1_200
const isTauriApp = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__
const isMobileTauri = isTauriApp && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
let backgroundedAt: number | null = null
let pendingForegroundReloadTimer: number | null = null

const cancelPendingForegroundReload = () => {
    if (pendingForegroundReloadTimer != null) {
        window.clearTimeout(pendingForegroundReloadTimer)
        pendingForegroundReloadTimer = null
    }
}

const markBackgrounded = () => {
    // 仅在移动端 Tauri 启用：桌面端切窗口很常见，不应触发重载策略。
    if (!isMobileTauri) return
    if (document.visibilityState === 'hidden') {
        backgroundedAt = Date.now()
    }
}

const resolveForegroundResumeAction = async (): Promise<'reload' | 'go-home'> => {
    const routeName = router.currentRoute.value.name
    const sessionKey = typeof router.currentRoute.value.params.sessionkey === 'string'
        ? router.currentRoute.value.params.sessionkey
        : undefined

    const requiresSessionValidation = routeName === 'chat'
    if (!requiresSessionValidation || !sessionKey) {
        return 'reload'
    }

    try {
        const session = await sessionsState.getSessionById(sessionKey, {
            forceRefresh: true,
            throwOnError: true,
        })
        return session ? 'reload' : 'go-home'
    } catch (error: unknown) {
        if (error instanceof ApiError && error.code === 404) {
            return 'go-home'
        }
        // 非 404（如网络抖动）不应误伤为首页，保持原来的 reload 行为。
        console.warn('[app] failed to validate foreground session before reload', error)
        return 'reload'
    }
}

const handleForeground = () => {
    if (!isMobileTauri || backgroundedAt == null) return

    const elapsed = Date.now() - backgroundedAt
    backgroundedAt = null
    // Android/iOS 回前台后，WebView 内存往往还在，但长连接 / 本地缓存状态可能已漂移；
    // 短暂切后台（<60s）直接跳过，避免打断用户。
    // 但如果本次 focus 是由“点击通知”触发，需要跳过 reload，避免与通知跳转互相打架。
    if (!shouldReloadAfterForeground(elapsed, MOBILE_BACKGROUND_RELOAD_MS, isForegroundReloadSuppressed())) {
        // 快速回前台或被通知抑制：取消上一轮可能排定的重载定时器，避免旧 timer 仍触发 reload
        cancelPendingForegroundReload()
        return
    }

    cancelPendingForegroundReload()
    pendingForegroundReloadTimer = window.setTimeout(async () => {
        pendingForegroundReloadTimer = null

        if (isForegroundReloadSuppressed()) {
            return
        }

        const resumeAction = await resolveForegroundResumeAction()
        // await（含网络往返）期间可能刚收到通知点击：再查一次抑制窗口，避免 reload 冲掉刚发生的跳转
        if (isForegroundReloadSuppressed()) {
            return
        }
        if (resumeAction === 'go-home') {
            console.log(`[app] Mobile app resumed after ${elapsed}ms in background, session missing, redirecting home...`)
            window.location.replace('/')
            return
        }

        console.log(`[app] Mobile app resumed after ${elapsed}ms in background, reloading page...`)
        window.location.reload()
    }, FOREGROUND_RELOAD_GRACE_MS)
}

onMounted(async () => {
    document.addEventListener('visibilitychange', markBackgrounded)

    try {
        // Check if running in Tauri environment
        if (!isTauriApp) return;

        // Listen for app focus event (e.g. switching back from background)
        unlistenFocus = await listen('tauri://focus', () => {
            handleForeground()
            console.log('App focused, checking connection...')
            import('./composables/notify-server-connection').then(({ checkConnection }) => {
                checkConnection()
            })
        })
    } catch (e) {
        console.error('Failed to setup focus listener', e)
    }
})

onUnmounted(() => {
    document.removeEventListener('visibilitychange', markBackgrounded)
    cancelPendingForegroundReload()
    if (unlistenFocus) {
        unlistenFocus()
    }
})
</script>

<template>
    <div class="fixed inset-0 bg-base-100 overflow-hidden text-base-content font-sans">
        <RouterView />
        <WindowControls />
        <MessagePlugin />
        <ExecApprovalModal />
        <ConfirmPlugin />
        <!-- 内置服务端启动门控：Starting 时 UI 照常渲染，只盖一层淡磨砂透出内容（数据加载已暂停，无请求报错）；
             初始 Failed 才显示错误与重启入口 -->
        <div v-if="bootFailedVisible" class="absolute inset-0 z-40 bg-base-100/80 backdrop-blur-[2px] flex flex-col items-center justify-center gap-3 px-6">
            <p class="text-base font-medium text-error">{{ $t('settings.localServerFailed') }}</p>
            <p v-if="localServer.lastError" class="text-sm text-base-content/60 text-center max-w-md">{{ localServer.lastError }}</p>
            <div class="flex gap-2 mt-2">
                <button class="btn btn-primary btn-sm" @click="onBootRestart">{{ $t('settings.restartServer') }}</button>
            </div>
        </div>
        <div v-else-if="bootGateVisible" class="absolute inset-0 z-40 bg-base-100/30 backdrop-blur-[2px] pointer-events-none"></div>
    </div>
</template>

<style>
/* Global styles */
</style>
