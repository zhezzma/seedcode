<script setup lang="ts">
/**
 * 扩展管理页：列出服务端发现的全部扩展（全局 + 项目级），
 * 提供启用/禁用开关（乐观更新，失败回滚）与设置表单入口。
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PuzzlePieceIcon, AdjustmentsHorizontalIcon, InformationCircleIcon } from '@heroicons/vue/24/outline'
import ViewHeader from '../components/ViewHeader.vue'
import ExtensionSettingsModal from '../components/extensions/ExtensionSettingsModal.vue'
import ExtensionUsageModal from '../components/extensions/ExtensionUsageModal.vue'
import ExtensionPanelModal from '../components/extensions/ExtensionPanelModal.vue'
import { getExtensionPanelIcon, getExtensionPanelTitleKey } from '../components/extensions/panel-registry'
import { apiGet, apiPost } from '../composables/api-client'
import { useCommandState } from '../composables/useCommandState'

interface ExtensionItem {
    id: string
    name: string
    description: string
    enabled: boolean
    hasSettings: boolean
    hasUsage: boolean
    /** extension.json 声明的面板类型列表（如 ['qr-login']）；无面板为空数组 */
    panelTypes: string[]
    source: 'project' | 'global'
}

const { t } = useI18n()

const extensions = ref<ExtensionItem[]>([])
const loading = ref(false)
const loadError = ref('')

// 设置弹层当前目标（null = 关闭）
const settingsTarget = ref<ExtensionItem | null>(null)
// 说明弹层当前目标（null = 关闭）
const usageTarget = ref<ExtensionItem | null>(null)
// 面板弹层当前目标（null = 关闭；携带具体 panelType，同一扩展可有多个面板入口）
const panelTarget = ref<{ item: ExtensionItem; panelType: string } | null>(null)

async function loadExtensions() {
    loading.value = true
    loadError.value = ''
    try {
        // 规范化：旧版服务端不下发 panelTypes 时兜底为空数组，消除对隐式缺省的假设
        const raw = await apiGet<ExtensionItem[]>('/api/extensions')
        extensions.value = raw.map((e) => ({ ...e, panelTypes: e.panelTypes ?? [] }))
    } catch (e: any) {
        loadError.value = e?.message || String(e)
    } finally {
        loading.value = false
    }
}

async function toggleExtension(item: ExtensionItem) {
    const next = !item.enabled
    // 乐观更新：先切 UI，失败回滚（错误提示由 api-client 统一 toast）
    item.enabled = next
    try {
        await apiPost(`/api/extensions/${encodeURIComponent(item.id)}/${next ? 'enable' : 'disable'}`)
        // 扩展可注册命令：启停后强制刷新当前作用域的斜杠命令缓存，
        // 否则 / 命令面板保持陈旧直到整页刷新（未选 agent 的空 scope 下
        // 服务端命令为空，loadCommands 内部直接短路不发请求）
        void useCommandState().forceReload(useCommandState().currentAgentId.value)
    } catch {
        item.enabled = !next
    }
}

onMounted(loadExtensions)
</script>

<template>
    <div class="flex flex-col h-full">
        <ViewHeader :title="t('extensions.title')" wc-pad :is-main-page="true" />

        <div class="flex-1 overflow-y-auto p-4 md:p-6">
            <!-- 顶部提示 -->
            <p class="text-xs text-base-content/50 mb-4">{{ t('extensions.newSessionHint') }}</p>

            <!-- Loading -->
            <div v-if="loading" class="flex justify-center p-8">
                <span class="loading loading-spinner loading-lg text-primary"></span>
            </div>

            <!-- Error -->
            <div v-else-if="loadError" class="alert alert-error">{{ loadError }}</div>

            <!-- 空态 -->
            <div v-else-if="extensions.length === 0" class="text-center py-8 text-base-content/50">
                <PuzzlePieceIcon class="w-10 h-10 mx-auto mb-2 opacity-40" />
                <p class="text-sm">{{ t('extensions.noExtensions') }}</p>
            </div>

            <!-- 格子 -->
            <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div v-for="item in extensions" :key="item.id"
                    class="card bg-base-200 shadow-sm border border-base-300 hover:border-primary transition-colors hover:shadow-md h-full">
                    <div class="card-body p-4 gap-2">
                        <div class="flex items-center justify-between gap-2">
                            <div class="flex items-center gap-2 min-w-0">
                                <div class="w-2 h-2 rounded-full shrink-0"
                                    :class="item.enabled ? 'bg-success' : 'bg-base-content/30'"></div>
                                <h4 class="font-bold text-base truncate">{{ item.name }}</h4>
                            </div>
                            <span class="badge badge-sm badge-ghost shrink-0">
                                {{ item.source === 'project' ? t('extensions.sourceProject') : t('extensions.sourceGlobal') }}
                            </span>
                        </div>

                        <p class="text-xs text-base-content/50 line-clamp-2 min-h-8">{{ item.description || '—' }}</p>

                        <div class="card-actions justify-end items-center pt-1">
                            <template v-if="item.enabled">
                                <button v-for="ptype in item.panelTypes" :key="ptype"
                                    class="btn btn-ghost btn-sm btn-square" :title="t(getExtensionPanelTitleKey(ptype))"
                                    @click="panelTarget = { item, panelType: ptype }">
                                    <component :is="getExtensionPanelIcon(ptype)" class="h-5 w-5" />
                                </button>
                            </template>
                            <button v-if="item.hasUsage" class="btn btn-ghost btn-sm btn-square"
                                :title="t('extensions.usage')" @click="usageTarget = item">
                                <InformationCircleIcon class="h-5 w-5" />
                            </button>
                            <button v-if="item.hasSettings" class="btn btn-ghost btn-sm btn-square"
                                :title="t('extensions.settings')" @click="settingsTarget = item">
                                <AdjustmentsHorizontalIcon class="h-5 w-5" />
                            </button>
                            <input type="checkbox" class="toggle toggle-primary toggle-sm" :checked="item.enabled"
                                @change="toggleExtension(item)" />
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <ExtensionSettingsModal v-if="settingsTarget" :extension-id="settingsTarget.id"
            :extension-name="settingsTarget.name" @close="settingsTarget = null" />
        <ExtensionUsageModal v-if="usageTarget" :extension-id="usageTarget.id"
            :extension-name="usageTarget.name" @close="usageTarget = null" />
        <ExtensionPanelModal v-if="panelTarget" :key="panelTarget.item.id + ':' + panelTarget.panelType"
            :extension-id="panelTarget.item.id" :extension-name="panelTarget.item.name"
            :panel-type="panelTarget.panelType" @close="panelTarget = null" />
    </div>
</template>
