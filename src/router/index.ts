import { createRouter, createWebHistory } from 'vue-router'
import { useUiSettingsStore } from '../stores/setting'
import { NEW_SESSION_ROUTE_NAME } from '../utils/route-helpers'
import { ensureLocalServerLoaded, effectiveGatewayMode } from '../composables/local-server'

// Layouts
import MainLayout from '../layouts/MainLayout.vue'

// Views
import SetupView from '../views/SetupView.vue'
import HomeView from '../views/HomeView.vue'
import SettingsView from '../views/SettingsView.vue'
import ExtensionsView from '../views/ExtensionsView.vue'
import AgentsView from '../views/AgentsView.vue'
import ModelsView from '../views/ModelsView.vue'
import McpView from '../views/McpView.vue'
import CronView from '../views/CronView.vue'
import LogView from '../views/LogView.vue'
import PromptsView from '../views/PromptsView.vue'



const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/setup',
            name: 'setup',
            component: SetupView
        },
        {
            path: '/',
            component: MainLayout,
            meta: { requiresConfig: true },
            children: [
                {
                    path: '',
                    name: 'home',
                    redirect: { name: 'chat' }
                },
                {
                    path: 'chat/:sessionkey?',
                    name: 'chat',
                    component: HomeView
                },
                {
                    path: 'new',
                    name: NEW_SESSION_ROUTE_NAME,
                    component: HomeView
                },
                {
                    path: 'settings',
                    name: 'settings',
                    component: SettingsView
                },
                {
                    path: 'extensions',
                    name: 'extensions',
                    component: ExtensionsView
                },
                {
                    path: 'agents',
                    name: 'agents',
                    component: AgentsView
                },
                {
                    path: 'models',
                    name: 'models',
                    component: ModelsView
                },
                {
                    path: 'mcp',
                    name: 'mcp',
                    component: McpView
                },
                {
                    path: 'cron',
                    name: 'cron',
                    component: CronView
                },
                {
                    path: 'logs',
                    name: 'logs',
                    component: LogView
                },
                {
                    path: 'prompts',
                    name: 'prompts',
                    component: PromptsView
                },
                {
                    path: 'a2ui-demo',
                    name: 'a2ui-demo',
                    component: () => import('../views/A2UIDemoView.vue')
                }
            ]
        }
    ]
})

// Navigation guard to check config
router.beforeEach(async (to, _from, next) => {
    await ensureLocalServerLoaded()
    const configStore = useUiSettingsStore()

    // If route requires config and user is not set up.
    // bundled 本地模式下 apiBaseUrl 由服务托管（syncSettings 抢先写入，
    // isConfigured 恒 true），是否首次引导只能看 setupDone；
    // remote（Android/Web/纯客户端）保持原 isConfigured 判断。
    const mode = effectiveGatewayMode()
    const needsSetup = mode === 'local' ? !configStore.setupDone : !configStore.isConfigured
    if (to.meta.requiresConfig && needsSetup) {
        next({ name: 'setup' })
        return
    }

    // If user is on setup page but already finished the wizard.
    // bundled 本地模式下 apiBaseUrl 由服务托管、恒为 isConfigured，
    // 弹回主界面必须看 setupDone，否则引导页永远进不去
    if (to.name === 'setup' && configStore.isConfigured && configStore.setupDone) {
        next({ name: 'home' })
        return
    }

    next()
})

export default router