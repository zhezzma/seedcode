<script setup lang="ts">
/**
 * team-chat 建群向导：群名 + 成员双 source（agent 引用 / inline 人格自定义
 * + 子代理级五件套配置）+ memory 开关。members[0]=群主（纯数组位置约定，
 * 无特权——首行即群主，UI 不做特殊标记）。创建走 team-chat 扩展 POST /groups；
 * 成功后跳群壳会话。
 *
 * 成员字段面全部复用 TeamMemberFields（建群 / 群管理添加 / 群管理编辑三处
 * 同一 view 同一字段面）：名字 / 类型 / 引用或人格 / 记忆 / 高级配置
 * （模型/思考/工具/技能/扩展，对齐预设子代理创建表单）。
 *
 * 首建 hub 默认模型/思考：hub agent 尚未创建（首次建群）时弹窗才显示选择器，
 * 透传 hubDefaults 由服务端惰性建 hub 时写为其 AgentConfig 默认三件——inline
 * 成员「跟随群默认」的真实来源；hub 已存在则不显示不传值。
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { CheckIcon, ChevronDownIcon, CpuChipIcon, LightBulbIcon, PlusIcon, TrashIcon, XMarkIcon, UsersIcon } from '@heroicons/vue/24/outline'

import { useSessionsState, type TeamGroupMemberInput, type TeamHubDefaults } from '../../composables/useSessionsState'
import { useToast } from '../../composables/useToast'
import { useAgentsState } from '../../composables/useAgentsState'
import { useModelsState } from '../../composables/useModelsState'
import { computeFloatingMenuStyle } from '../../utils/floating-menu'
import ModelSelectMenuContent from '../models/ModelSelectMenuContent.vue'
import TeamMemberFields, {
    newTeamMemberRow, teamMemberValid,
    type TeamMemberRow,
} from './TeamMemberFields.vue'
import { HUB_AGENT_ID, THINKING_LEVELS } from '../../utils/team-member'

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const router = useRouter()
const sessionsState = useSessionsState()
const agentsState = useAgentsState()
const toast = useToast()

const groupName = ref('')
const bulletin = ref('')
const creating = ref(false)
const members = ref<TeamMemberRow[]>([newTeamMemberRow()])
/** 成员字段组件实例（v-for ref 收集——提交投影 projectSource 用；非响应式
 *  够用：仅提交时读，模板 ref 函数写入） */
const memberRefs: Array<InstanceType<typeof TeamMemberFields> | null> = []

// ── 首建 hub 默认模型/思考（hub agent 尚未创建才显示：服务端惰性建 hub 时写为
//    其 AgentConfig 默认三件——inline 成员「跟随群默认」的真实来源；hub 已存在
//    则不显示不传值。菜单形态照 TeamMemberFields：Teleport+fixed 浮层，弹窗内
//    纯 dropdown 会被 overflow 裁剪）──
const modelsState = useModelsState()
const availableModels = computed(() => modelsState.availableModels.value)
const hubMissing = computed(() => !agentsState.agentsList.some(a => a.id === HUB_AGENT_ID))
const hubModel = ref('')
const hubThinkingLevel = ref('')

const hubModelMenuOpen = ref(false)
const hubModelTriggerRef = ref<HTMLElement | null>(null)
const hubModelPanelRef = ref<HTMLElement | null>(null)
const hubModelMenuStyle = ref<Record<string, string>>({})
const hubThinkingMenuOpen = ref(false)
const hubThinkingTriggerRef = ref<HTMLElement | null>(null)
const hubThinkingPanelRef = ref<HTMLElement | null>(null)
const hubThinkingMenuStyle = ref<Record<string, string>>({})

/** 浮层定位（公共 computeFloatingMenuStyle：上下自适应 + 视口内 maxHeight） */
const updateMenuPosition = (trigger: HTMLElement | null, style: Ref<Record<string, string>>) => {
    style.value = computeFloatingMenuStyle(trigger)
}

const toggleHubModelMenu = () => {
    hubModelMenuOpen.value = !hubModelMenuOpen.value
    hubThinkingMenuOpen.value = false
    if (hubModelMenuOpen.value) nextTick(() => updateMenuPosition(hubModelTriggerRef.value, hubModelMenuStyle))
}

const toggleHubThinkingMenu = () => {
    hubThinkingMenuOpen.value = !hubThinkingMenuOpen.value
    hubModelMenuOpen.value = false
    if (hubThinkingMenuOpen.value) nextTick(() => updateMenuPosition(hubThinkingTriggerRef.value, hubThinkingMenuStyle))
}

/** 触发按钮标签：与 ModelSelectMenuContent.currentModelLabel 同规则（未知模型回退
 *  原值）；空=跟随系统缺省（不写 hub 默认，成员回退链终点落到系统缺省） */
const hubModelLabel = computed(() => {
    const val = hubModel.value
    if (!val) return t('sidebar.hubDefaultFollowSystem')
    for (const group of availableModels.value) {
        const matched = (group.models ?? []).find((m) => `${group.provider}/${m.id}` === val)
        if (matched) return `${group.provider} / ${matched.name}`
    }
    return val
})

const onHubModelSelect = (modelId: string) => {
    hubModelMenuOpen.value = false
    hubModel.value = modelId
}

const onHubThinkingSelect = (level: string) => {
    hubThinkingMenuOpen.value = false
    hubThinkingLevel.value = level
}

const handleMenuDocClick = (event: MouseEvent) => {
    const target = event.target as Node | null
    if (!target) return
    if (hubModelMenuOpen.value
        && !hubModelTriggerRef.value?.contains(target) && !hubModelPanelRef.value?.contains(target)) hubModelMenuOpen.value = false
    if (hubThinkingMenuOpen.value
        && !hubThinkingTriggerRef.value?.contains(target) && !hubThinkingPanelRef.value?.contains(target)) hubThinkingMenuOpen.value = false
}

const handleMenuViewportChange = () => {
    if (hubModelMenuOpen.value) updateMenuPosition(hubModelTriggerRef.value, hubModelMenuStyle)
    if (hubThinkingMenuOpen.value) updateMenuPosition(hubThinkingTriggerRef.value, hubThinkingMenuStyle)
}

onMounted(() => {
    document.addEventListener('click', handleMenuDocClick)
    window.addEventListener('resize', handleMenuViewportChange)
    window.addEventListener('scroll', handleMenuViewportChange, true)
    // hubMissing 判定依赖 agentsList：未载时先拉一次（TeamMemberFields 同款守卫）
    if (!agentsState.agentsList?.length) agentsState.loadAgents?.()
    if (modelsState.providers.value && Object.keys(modelsState.providers.value).length === 0) {
        modelsState.loadModels()
    }
})

onUnmounted(() => {
    document.removeEventListener('click', handleMenuDocClick)
    window.removeEventListener('resize', handleMenuViewportChange)
    window.removeEventListener('scroll', handleMenuViewportChange, true)
})

const addMember = () => {
    members.value.push(newTeamMemberRow())
}

const removeMember = (index: number) => {
    // 至少保留一行（群不能没有成员）；首行=群主位置也不单独保护（数组约定而已）
    if (members.value.length > 1) {
        members.value.splice(index, 1)
        memberRefs.splice(index, 1)
    }
}

const valid = computed(() => {
    if (!groupName.value.trim()) return false
    return members.value.every(m => teamMemberValid(m))
})

const createGroup = async () => {
    if (!valid.value || creating.value) return
    creating.value = true
    try {
        const payload: { name: string, members: TeamGroupMemberInput[], bulletin?: string, hubDefaults?: TeamHubDefaults } = {
            name: groupName.value.trim(),
            members: members.value.map((m, index) => ({
                name: m.name.trim(),
                source: memberRefs[index]?.projectSource()
                    ?? { type: 'inline', systemPrompt: m.systemPrompt },
                memory: m.memory,
            })),
        }
        if (bulletin.value.trim()) payload.bulletin = bulletin.value.trim()
        // 首建 hub 才投影默认三件（hub 已存在不传：服务端静默忽略，UI 保证不出现）；
        // 门=模型含 / 或思考选了档位——两条独立路径（仅模型/仅思考），仅思考时
        // 用户选择不被静默丢弃；provider/model 拆分口径=首个 /（同
        // buildInlineSource：modelId 可含 /，lastIndexOf 会把 provider 切错）
        if (hubMissing.value && (hubModel.value.includes('/') || hubThinkingLevel.value)) {
            const slash = hubModel.value.indexOf('/')
            payload.hubDefaults = {
                ...(hubModel.value.includes('/') ? {
                    provider: hubModel.value.slice(0, slash),
                    model: hubModel.value.slice(slash + 1),
                } : {}),
                ...(hubThinkingLevel.value ? { thinkingLevel: hubThinkingLevel.value } : {}),
            }
        }
        const result = await sessionsState.createTeamGroup(payload)
        if (result?.shellSessionId) {
            emit('close')
            router.push({ name: 'chat', params: { sessionkey: result.shellSessionId } })
        }
    } catch (error) {
        toast.error((error as Error)?.message || t('sidebar.createGroup'), 5000)
    } finally {
        creating.value = false
    }
}
</script>

<template>
    <!-- daisyUI 5 的 .modal-box 默认 opacity:0，必须挂在 .modal.modal-open 下才
         可见——裸 div.fixed 包 modal-box 只会露出遮罩；Teleport 到 body 与
         SessionInfoModal 对齐，也避开移动端抽屉 transform 对 fixed 的包含块约束 -->
    <Teleport to="body">
        <dialog class="modal modal-open z-[210]">
            <button class="modal-backdrop" type="button" :aria-label="t('sidebar.cancel')"
                @click="emit('close')"></button>
            <div class="modal-box max-w-2xl bg-base-100 w-full p-4">
            <div class="flex justify-between items-center mb-4">
                <h3 class="font-bold text-lg">{{ t('sidebar.newGroup') }}</h3>
                <button class="btn btn-sm btn-circle btn-ghost" :aria-label="t('sidebar.cancel')" @click="emit('close')">
                    <XMarkIcon class="w-5 h-5" />
                </button>
            </div>

            <div class="space-y-4 max-h-[60vh] overflow-y-auto">
                <div class="form-control w-full">
                    <label class="label py-1"><span class="label-text font-medium">{{ t('sidebar.groupName') }}</span></label>
                    <input v-model="groupName" class="input input-bordered input-sm w-full"
                        :placeholder="t('sidebar.groupName')" />
                </div>

                <div class="form-control w-full">
                    <label class="label py-1"><span class="label-text font-medium">{{ t('sidebar.groupBulletin') }}</span></label>
                    <textarea v-model="bulletin" class="textarea textarea-bordered textarea-sm w-full" rows="2"
                        :placeholder="t('sidebar.groupBulletinHint')" />
                </div>

                <!-- 首建 hub 默认模型/思考（hub 尚未创建才显示：惰性建 hub 时写为其
                     AgentConfig 默认三件——inline 成员「跟随群默认」的来源；按钮/浮层
                     形态照 TeamMemberFields） -->
                <div v-if="hubMissing" class="form-control w-full">
                    <div class="grid grid-cols-2 gap-2">
                        <div class="form-control">
                            <label class="label py-1"><span class="label-text text-xs">{{ t('sidebar.hubDefaultModel') }}</span></label>
                            <button ref="hubModelTriggerRef" type="button" @click.stop="toggleHubModelMenu"
                                class="btn btn-sm bg-base-200 gap-1 font-normal rounded-lg border border-base-300 hover:border-base-content/40 hover:bg-base-300 transition-all w-full justify-between h-8 min-h-8 px-2"
                                :title="t('provider.selectModel')">
                                <CpuChipIcon class="h-3.5 w-3.5 shrink-0" />
                                <span class="truncate flex-1 text-left">{{ hubModelLabel }}</span>
                                <ChevronDownIcon class="h-3 w-3 shrink-0 opacity-50 transition-transform"
                                    :class="{ 'rotate-180': hubModelMenuOpen }" />
                            </button>
                        </div>
                        <div class="form-control">
                            <label class="label py-1"><span class="label-text text-xs">{{ t('sidebar.hubDefaultThinking') }}</span></label>
                            <button ref="hubThinkingTriggerRef" type="button" @click.stop="toggleHubThinkingMenu"
                                class="btn btn-sm bg-base-200 gap-1 font-normal rounded-lg border border-base-300 hover:border-base-content/40 hover:bg-base-300 transition-all w-full justify-between h-8 min-h-8 px-2">
                                <LightBulbIcon class="h-3.5 w-3.5 shrink-0" />
                                <span class="truncate flex-1 text-left">{{ hubThinkingLevel
                                    ? t(`chat.thinkingLevels.${hubThinkingLevel}`) : t('sidebar.hubDefaultFollowSystem') }}</span>
                                <ChevronDownIcon class="h-3 w-3 shrink-0 opacity-50 transition-transform"
                                    :class="{ 'rotate-180': hubThinkingMenuOpen }" />
                            </button>
                        </div>
                    </div>
                    <label class="label py-1"><span class="label-text-alt opacity-70">{{ t('sidebar.hubDefaultHint') }}</span></label>
                </div>

                <div>
                    <div class="flex items-center gap-2 mb-2">
                        <UsersIcon class="w-4 h-4 text-primary" />
                        <span class="text-sm font-medium">{{ t('sidebar.groupMembersSection') }}</span>
                        <div class="badge badge-sm font-mono badge-primary">{{ members.length }}</div>
                    </div>
                    <div class="space-y-2">
                        <div v-for="(member, index) in members" :key="member._rowId ?? index"
                            class="card bg-base-200 border border-base-300">
                            <div class="card-body p-3 gap-2">
                                <TeamMemberFields :ref="(el: any) => { memberRefs[index] = el }" :member="member" />
                                <div class="flex justify-end pt-1 border-t border-base-300">
                                    <button class="btn btn-ghost btn-xs btn-square text-error/50 hover:text-error"
                                        :disabled="members.length <= 1" :title="t('sidebar.groupRemoveMember')"
                                        @click="removeMember(index)">
                                        <TrashIcon class="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <button class="btn btn-ghost btn-sm mt-2 gap-1" @click="addMember">
                        <PlusIcon class="w-4 h-4" />
                        {{ t('sidebar.addMember') }}
                    </button>
                </div>
            </div>

            <!-- 首建 hub 默认模型/思考浮层（Teleport 出弹窗容器：同成员字段菜单，
                 纯 dropdown 会被 modal overflow 裁剪；顶部清空项=跟随系统缺省） -->
            <Teleport to="body">
                <div v-if="hubModelMenuOpen" ref="hubModelPanelRef" :style="hubModelMenuStyle"
                    class="z-[300] bg-base-100 rounded-box border border-base-300 shadow-xl overflow-hidden flex flex-col">
                    <button type="button" @click="onHubModelSelect('')"
                        class="flex items-center gap-2 px-4 py-2 text-left text-xs hover:bg-base-200 transition-colors border-b border-base-300 shrink-0"
                        :class="{ 'bg-primary/10 text-primary': !hubModel }">
                        {{ t('sidebar.hubDefaultFollowSystem') }}
                    </button>
                    <ModelSelectMenuContent :available-models="availableModels"
                        :current-model="hubModel" @select="onHubModelSelect" />
                </div>
                <ul v-if="hubThinkingMenuOpen" ref="hubThinkingPanelRef" :style="hubThinkingMenuStyle"
                    class="z-[300] menu p-2 bg-base-100 rounded-box border border-base-300 shadow-xl overflow-y-auto">
                    <li>
                        <a @click="onHubThinkingSelect('')" class="flex items-center gap-2 rounded-lg"
                            :class="{ 'bg-primary/10 text-primary': !hubThinkingLevel }">
                            <span class="flex-1">{{ t('sidebar.hubDefaultFollowSystem') }}</span>
                            <CheckIcon v-if="!hubThinkingLevel" class="h-4 w-4 shrink-0" />
                            <span v-else class="w-4 h-4 shrink-0"></span>
                        </a>
                    </li>
                    <li v-for="level in THINKING_LEVELS" :key="level">
                        <a @click="onHubThinkingSelect(level)" class="flex items-center gap-2 rounded-lg"
                            :class="{ 'bg-primary/10 text-primary': level === hubThinkingLevel }">
                            <span class="flex-1">{{ t(`chat.thinkingLevels.${level}`) }}</span>
                            <CheckIcon v-if="level === hubThinkingLevel" class="h-4 w-4 shrink-0" />
                            <span v-else class="w-4 h-4 shrink-0"></span>
                        </a>
                    </li>
                </ul>
            </Teleport>

            <div class="modal-action mt-4">
                <button class="btn btn-ghost" @click="emit('close')">{{ t('sidebar.cancel') }}</button>
                <button class="btn btn-primary" :disabled="!valid || creating" @click="createGroup">
                    <span v-if="creating" class="loading loading-spinner loading-xs"></span>
                    {{ t('sidebar.createGroup') }}
                </button>
            </div>
        </div>
        </dialog>
    </Teleport>
</template>
