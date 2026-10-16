<script setup lang="ts">
/**
 * 通用 a2ui 表单弹层：从 loadUrl 拉取服务端声明的 a2ui 组件树并渲染，
 * 保存时把 dataModel 整体 POST 到 saveUrl（ExtensionSettingsModal 是它的固定端点包装）。
 * a2ui v1.0：响应必须携带 version:"v1.0"（服务端注入），不匹配即拒绝渲染（防两仓部署漂移）；
 * 树内 functionCall action（如 ChoicePicker 级联）经 /api/a2ui/events RPC 下行更新就地应用；
 * 表单型 rpc（条目增删类）可回推 updateComponents + updateDataModel(root) 整树刷新。
 * 错误提示由 api-client 统一 toast（400 不在静默白名单）。
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiGet, apiPost } from '../../composables/api-client'
import { useToast } from '../../composables/useToast'
import { A2UIRenderer, A2UI_VERSION } from '../a2ui'
import type { Action } from '../a2ui/types'
import { setByPath, resolveDynamicRecord, createA2uiRpcScheduler } from '../../composables/useA2UIState'
import { callA2uiAgentFunction, type A2uiResponseMessage } from '../../composables/a2uiClient'

const props = defineProps<{
    title: string
    loadUrl: string
    saveUrl: string
}>()

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()

const { t } = useI18n()
const toast = useToast()

const components = ref<any[]>([])
const dataModel = ref<Record<string, any>>({})
const loading = ref(false)
const saving = ref(false)

watch(
    () => props.loadUrl,
    async (url) => {
        if (!url) return
        loading.value = true
        components.value = []
        dataModel.value = {}
        try {
            const form = await apiGet<{ version?: string; components: any[]; dataModel: Record<string, any> }>(url)
            // a2ui v1.0：服务端注入的版本不匹配 → 拒绝渲染（两仓部署漂移保护，硬切不兼容）
            if (form.version !== A2UI_VERSION) {
                toast.error(t('chat.a2uiVersionMismatch'))
                emit('close')
                return
            }
            components.value = form.components ?? []
            dataModel.value = form.dataModel ?? {}
        } catch (e: any) {
            // 加载失败：非静默错误已由 api-client 弹出；404 静默补本地提示后关闭
            if (e?.code === 404) toast.error(t('extensions.settingsLoadFailed'))
            emit('close')
        } finally {
            loading.value = false
        }
    },
    { immediate: true },
)

// 设置表单无 surfaceId：rpc 路由按函数名转发，伪 id 仅透传记录
const formSurfaceId = `form-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Date.now()}`

// rpc 调度：快操作（级联）串行防乱序；慢操作（安装类，声明 pendingPath/pendingText）
// 旁路独立执行——分钟级安装若入链，save()（await 链落地防半更新 dataModel）会被
// 卡到安装结束（实测三个扩展全中）。慢操作只写状态行路径，与级联字段不相交。
const rpcScheduler = createA2uiRpcScheduler()

/** 树内 functionCall action（如 ChoicePicker 级联）：callAgentFunction RPC。
 *  args 内的 {path} 绑定必须先对本地 dataModel 解析（服务端不解析渲染端数据模型，
 *  未解析的绑定对象会导致 rpc 参数失配）；updateDataModel 按 surfaceId 过滤后就地
 *  应用；updateComponents 按 surfaceId 过滤后整树替换（表单型 rpc 的条目增删刷新）。
 *  慢操作反馈：rpc 是请求-响应语义，服务端无法中途推进度；扩展可在 args 里声明
 *  pendingPath/pendingText，发起 rpc 前就地写入 dataModel 让表单显示“稍候”提示，
 *  完成后由服务端回包的 updateDataModel 覆盖为最终状态。 */
function onFormAction(action: Action, dataModel: Record<string, any>, _sourceComponentId: string) {
    // 设置表单无 event action 语义（无对应 handler）：告警而非静默吞掉，便于发现表单树误用
    if (!('functionCall' in action)) {
        console.warn('[A2UI] form dialog received event action (unsupported):', (action as { event?: { name?: string } }).event?.name)
        return
    }
    const fn = action.functionCall
    const pendingPath = typeof fn.args?.pendingPath === 'string' ? fn.args.pendingPath : undefined
    const pendingText = typeof fn.args?.pendingText === 'string' ? fn.args.pendingText : undefined
    const pendingLabelPath = typeof fn.args?.pendingLabelPath === 'string' ? fn.args.pendingLabelPath : undefined
    if (pendingPath && pendingText) {
        setByPath(dataModel, pendingPath, pendingText)
    }
    // 慢操作判定沿用服务端约定：声明了 pendingPath/pendingText 即“慢操作反馈”
    // （快级联从不声明）；pendingLabelPath 同时翻按钮文案——否则会出现
    // 「关窗重开显示安装中、当场点击按钮却仍是可点的安装按钮」的不对称。
    // 字面量与表单内容同为中文（a2ui 表单文案由服务端声明，此处仅按钮态）。
    if (pendingLabelPath) {
        setByPath(dataModel, pendingLabelPath, '安装中…')
    }
    const slow = pendingPath !== undefined && pendingText !== undefined
    rpcScheduler
        .schedule(async () => {
            const result = await callA2uiAgentFunction({
                surfaceId: formSurfaceId,
                call: fn.call,
                args: resolveDynamicRecord(fn.args, dataModel) as Record<string, unknown>,
                surfaces: { [formSurfaceId]: dataModel },
            })
            for (const message of result.messages as A2uiResponseMessage[]) {
                if (message.updateDataModel && message.updateDataModel.surfaceId === formSurfaceId) {
                    setByPath(dataModel, message.updateDataModel.path ?? '/', message.updateDataModel.value)
                } else if (message.updateComponents && message.updateComponents.surfaceId === formSurfaceId) {
                    // 表单型 rpc（条目增删类，如 external-links 的添加/删除）：服务端重生成
                    // 整棵组件树回推，就地换树 + 配套 updateDataModel(root) 整模刷新——
                    // 新卡片即时出现、被删卡片即时消失，无需关窗重开
                    components.value = message.updateComponents.components
                } else if (message.agentFunctionResponse) {
                    // 响应回执（首个消息），值已在 result.value/error 里
                } else {
                    console.warn('[A2UI] form dialog dropped response message:', Object.keys(message)[1] ?? 'unknown')
                }
            }
            if (result.error) toast.error(result.error.message)
        }, slow)
        .catch(() => {
            // 调度器已就地消化，此处兜底（防御未来 schedule 实现变化）
        })
}

async function save() {
    saving.value = true
    try {
        // 等待在途快级联落地，避免半更新状态的 dataModel 被保存；
        // 安装类慢操作已旁路（不在此链上），安装中点保存立即落盘，不再被卡
        await rpcScheduler.settled
        await apiPost(props.saveUrl, {
            dataModel: dataModel.value,
        })
        toast.success(t('extensions.saveSuccess'))
        emit('saved')
        emit('close')
    } catch {
        // 保存失败（含服务端校验 message）：toast 已弹出，弹层保持打开供修正
    } finally {
        saving.value = false
    }
}
</script>

<template>
    <div class="modal modal-open">
        <div class="modal-box max-w-2xl">
            <h3 class="font-bold text-lg mb-4">{{ title }}</h3>

            <div v-if="loading" class="flex justify-center p-8">
                <span class="loading loading-spinner"></span>
            </div>
            <div v-else class="max-h-[60vh] overflow-y-auto">
                <A2UIRenderer :components="components" :data-model="dataModel" :root-ids="['root']" @action="onFormAction" />
            </div>

            <div class="modal-action">
                <button class="btn btn-ghost" :disabled="saving" @click="emit('close')">
                    {{ t('extensions.cancel') }}
                </button>
                <button class="btn btn-primary" :disabled="saving || loading" @click="save">
                    <span v-if="saving" class="loading loading-spinner loading-xs"></span>
                    {{ t('extensions.save') }}
                </button>
            </div>
        </div>
        <div class="modal-backdrop" @click="!saving && emit('close')"></div>
    </div>
</template>
