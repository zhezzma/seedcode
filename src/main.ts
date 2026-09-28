import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style/main.css'
import App from './App.vue'
import router from './router'
import { initializeMermaid } from "./utils/markdown/mermaid-render";
import { i18n } from "./i18n";
import { parseTunnelHash, applyTunnelBootstrap, stripHashFromUrl } from './utils/tunnel-hash'
import { useUiSettingsStore } from './stores/setting'
import { isTauri } from './composables/notify-server-connection'
import { installNativeCopyInterceptor } from './utils/clipboard'

// 桌面端拦截选中复制（Ctrl+C/右键菜单/Ctrl+X）改走原生剪贴板写入，
// 否则内容进不了 Windows 剪贴板历史（内部自带环境判断，非 Tauri 环境为 no-op）
installNativeCopyInterceptor()

const app = createApp(App)
app.use(i18n)
app.use(createPinia())

// 隧道移动端引导：必须在 router/mount 之前完成——任何组件 setup 期的 API 调用
// （api-client.getBaseUrl() 在 apiBaseUrl 为空时直接 throw）都依赖 settings 已写入。
// pinia install 后即可在组件外使用 store。
// 仅浏览器环境执行：Tauri 客户端（桌面/Android）不会也不应被 #token 引导触碰
//（否则 origin 是 tauri:// 伪协议，会写坏 apiBaseUrl）。
try {
    const bootstrap = !isTauri ? parseTunnelHash(window.location.hash) : null
    if (bootstrap) {
        // 先抹 hash 再写 settings：抹除是安全动作（令牌不留在地址栏/历史），
        // 独立成步——抹除失败仅告警，不得阻断 settings 写入
        try {
            history.replaceState(null, '', stripHashFromUrl(window.location.href))
        } catch (e) {
            console.warn('[tunnel] strip hash failed:', e)
        }
        applyTunnelBootstrap(useUiSettingsStore(), window.location.origin, bootstrap)
    }
} catch (e) {
    console.error('[tunnel] hash bootstrap failed:', e)
}

app.use(router)

// 在Pinia初始化后初始化mermaid
initializeMermaid();

app.mount('#app')
