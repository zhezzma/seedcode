<script lang="ts">
/** 静态导出面（v7.4.3 起纯函数本体在 utils/team-member.ts——node:test 可
 *  直接 import 行为级测试；此处 re-export 保持三处消费面 import 路径零改）。 */
export {
    HUB_AGENT_ID, THINKING_LEVELS,
    newTeamMemberRow, memberDocToRow, teamMemberValid, buildInlineSource,
    loadHubToolsOnce, loadHubSkillsOnce, loadExtensionsOnce,
} from '../../utils/team-member'
export type { TeamMemberRow } from '../../utils/team-member'
</script>

<script setup lang="ts">
/**
 * 群成员字段表单（team-chat 三处统一复用：建群向导成员行 / 群管理添加成员 /
 * 群管理编辑成员——同一 view，同一字段面）。平铺无折叠，逐段对齐预设子代理
 * 创建表单（AgentSubagents.vue）规范形态：labeled 字段 + radio 模式切换 +
 * custom 卡片网格勾选（checkbox-sm，非平铺 checkbox 墙）+ 单个全选切换按钮。
 * 字段全量：名字 / 类型（inline|agent 互转，编辑态也开放）/ agent 引用或
 * inline 人格 / 记忆 / 默认模型（复用 ModelSelectMenuContent 浮层+Teleport
 * 定位）/ 思考程度（同款浮层菜单）/ 工具（inherit 全部 / custom 勾选，黑名单
 * 存 disabledTools）/ 技能（inherit hub 目录全量 / none / custom 勾选）/
 * 扩展（inherit / custom 白名单勾选）。
 *
 * 数据源组件自管：agentsList（引用下拉）、hubTools/hubSkills（team-chat-hub
 * 目录，与服务端 HUB_AGENT_ID 两仓契约）、全局 enabled 扩展清单、模型目录
 * （useModelsState）。加载失败一律降级空清单不阻断表单。
 *
 * 绑定形态：父持有 reactive 行对象传入 member prop，字段就地双向（行对象引用
 * 共享）；提交投影 buildInlineSource / 校验 memberValid 由组件静态导出，
 * 三处共用同一语义。
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDownIcon, CpuChipIcon, LightBulbIcon, CheckIcon } from '@heroicons/vue/24/outline'

import { useAgentsState } from '../../composables/useAgentsState'
import { computeFloatingMenuStyle } from '../../utils/floating-menu'
import { useModelsState } from '../../composables/useModelsState'
import ModelSelectMenuContent from '../models/ModelSelectMenuContent.vue'
import FilterModeSection from './FilterModeSection.vue'
import {
    HUB_AGENT_ID, THINKING_LEVELS, buildInlineSource,
    loadHubToolsOnce, loadHubSkillsOnce, loadExtensionsOnce,
    type TeamMemberRow,
} from '../../utils/team-member'
import type { TeamGroupInlineSource } from '../../composables/useSessionsState'



const props = defineProps<{ member: TeamMemberRow }>()

const { t } = useI18n()
const agentsState = useAgentsState()
const modelsState = useModelsState()

// ── 高级配置数据源（hub 目录/全局清单；加载失败降级空清单不阻断）──
const hubTools = computed(() => (agentsState.agentTools?.[HUB_AGENT_ID] ?? []).filter((tool: { name: string }) => tool.name !== 'subagent'))
const hubSkills = ref<Array<{ id: string, name: string }>>([])
const extensionOptions = ref<Array<{ id: string, name: string }>>([])
/** 模型分组直传 ModelSelectMenuContent（复用；不再手搓扁平 option 列表） */
const availableModels = computed(() => modelsState.availableModels.value)

// ── 全选切换（AgentSubagents 同款：单按钮在 全选/全不选 间切换）──
const allToolsSelected = computed(() =>
    hubTools.value.length > 0 && props.member.enabledTools.length === hubTools.value.length)
const allSkillsSelected = computed(() =>
    hubSkills.value.length > 0 && props.member.enabledSkills.length === hubSkills.value.length)
const allExtensionsSelected = computed(() =>
    extensionOptions.value.length > 0 && props.member.selectedExtensions.length === extensionOptions.value.length)

// ── 模型/思考下拉（复用 ModelSelectMenuContent + 思考菜单；浮层定位照
//    AgentSubagents：Teleport+fixed——成员行在弹窗（overflow 裁剪）内，纯
//    dropdown 会被容器裁剪）──
const modelMenuOpen = ref(false)
const modelTriggerRef = ref<HTMLElement | null>(null)
const modelPanelRef = ref<HTMLElement | null>(null)
const modelMenuStyle = ref<Record<string, string>>({})
const thinkingMenuOpen = ref(false)
const thinkingTriggerRef = ref<HTMLElement | null>(null)
const thinkingPanelRef = ref<HTMLElement | null>(null)
const thinkingMenuStyle = ref<Record<string, string>>({})

/** 浮层定位（公共 computeFloatingMenuStyle：上下自适应 + 视口内 maxHeight；
 *  AgentSubagents 同源） */
const updateMenuPosition = (trigger: HTMLElement | null, style: Ref<Record<string, string>>) => {
    style.value = computeFloatingMenuStyle(trigger)
}

const toggleModelMenu = () => {
    modelMenuOpen.value = !modelMenuOpen.value
    thinkingMenuOpen.value = false
    if (modelMenuOpen.value) nextTick(() => updateMenuPosition(modelTriggerRef.value, modelMenuStyle))
}

const toggleThinkingMenu = () => {
    thinkingMenuOpen.value = !thinkingMenuOpen.value
    modelMenuOpen.value = false
    if (thinkingMenuOpen.value) nextTick(() => updateMenuPosition(thinkingTriggerRef.value, thinkingMenuStyle))
}

/** 触发按钮标签：与 ModelSelectMenuContent.currentModelLabel 同规则（未知模型回退原值）；空=跟随群当前模型 */
const currentModelLabel = computed(() => {
    const val = props.member.model
    if (!val) return t('sidebar.memberFollowGroupModel')
    for (const group of availableModels.value) {
        const matched = (group.models ?? []).find((m) => `${group.provider}/${m.id}` === val)
        if (matched) return `${group.provider} / ${matched.name}`
    }
    return val
})

const onModelSelect = (modelId: string) => {
    modelMenuOpen.value = false
    props.member.model = modelId
}

const onThinkingSelect = (level: string) => {
    thinkingMenuOpen.value = false
    props.member.thinkingLevel = level
}

const handleMenuDocClick = (event: MouseEvent) => {
    const target = event.target as Node | null
    if (!target) return
    if (modelMenuOpen.value
        && !modelTriggerRef.value?.contains(target) && !modelPanelRef.value?.contains(target)) modelMenuOpen.value = false
    if (thinkingMenuOpen.value
        && !thinkingTriggerRef.value?.contains(target) && !thinkingPanelRef.value?.contains(target)) thinkingMenuOpen.value = false
}

const handleMenuViewportChange = () => {
    if (modelMenuOpen.value) updateMenuPosition(modelTriggerRef.value, modelMenuStyle)
    if (thinkingMenuOpen.value) updateMenuPosition(thinkingTriggerRef.value, thinkingMenuStyle)
}

onUnmounted(() => {
    document.removeEventListener('click', handleMenuDocClick)
    window.removeEventListener('resize', handleMenuViewportChange)
    window.removeEventListener('scroll', handleMenuViewportChange, true)
})

const agentsList = computed(() => agentsState.agentsList ?? [])

onMounted(() => {
    document.addEventListener('click', handleMenuDocClick)
    window.addEventListener('resize', handleMenuViewportChange)
    window.addEventListener('scroll', handleMenuViewportChange, true)
    if (modelsState.providers.value && Object.keys(modelsState.providers.value).length === 0) {
        modelsState.loadModels()
    }
    if (!agentsState.agentsList?.length) agentsState.loadAgents?.()
    // 共享加载器（模块级 in-flight 去重）：向导 N 行成员并发挂载只发一次请求。
    // C-I3 守卫：全集加载失败/为空（ok=false）时保留 _pending 且不回算——
    // 空全集回算会把黑名单差集清成「全放行」（用户无感知的权限面扩大）；
    // _pending 留给 buildInlineSource 兜底路径直传差集，语义不漂移
    loadHubToolsOnce().then(({ ok }) => {
        if (!ok) return
        const pending = props.member._pendingDisabledTools
        if (pending && props.member.enabledTools.length === 0) {
            const disabled = new Set(pending)
            props.member.enabledTools = hubTools.value.map((tool: { name: string }) => tool.name).filter((name) => !disabled.has(name))
        }
        props.member._pendingDisabledTools = undefined
    })
    loadHubSkillsOnce().then(({ ok, items }) => {
        if (!ok) return
        hubSkills.value = items.map((id) => ({ id, name: id }))
        const pending = props.member._pendingDisabledSkills
        if (pending && props.member.enabledSkills.length === 0) {
            const disabled = new Set(pending)
            props.member.enabledSkills = hubSkills.value.map((s) => s.id).filter((id) => !disabled.has(id))
        }
        props.member._pendingDisabledSkills = undefined
    })
    loadExtensionsOnce().then((items) => {
        extensionOptions.value = items
    })
})

/** 工具/技能/扩展全选切换（custom 模式快捷操作）。显式操作即用户表态：
 *  清 pending 残留，否则 buildInlineSource 兜底会把旧差集写回（全不选被吞）。 */
const toggleAllTools = (on: boolean) => {
    props.member.enabledTools = on ? hubTools.value.map((tool: { name: string }) => tool.name) : []
    props.member._pendingDisabledTools = undefined
}
const toggleAllSkills = (on: boolean) => {
    props.member.enabledSkills = on ? hubSkills.value.map((s) => s.id) : []
    props.member._pendingDisabledSkills = undefined
}
const toggleAllExtensions = (on: boolean) => {
    props.member.selectedExtensions = on ? extensionOptions.value.map((e) => e.id) : []
}

/** 提交投影：表单行 → TeamGroupMemberInput.source（差集用组件内部全集，
 *  三处提交统一调本方法，免各自维护全集同步）。 */
const projectSource = (): TeamGroupInlineSource | { type: 'agent', agentId: string } =>
    props.member.type === 'agent'
        ? { type: 'agent', agentId: props.member.agentId }
        : buildInlineSource(
            props.member,
            hubTools.value.map((tool: { name: string }) => tool.name),
            hubSkills.value.map((s) => s.id),
        )

defineExpose({ projectSource })
</script>

<template>
    <!-- 名字 -->
    <div class="form-control w-full">
        <label class="label py-1"><span class="label-text font-medium">{{ t('sidebar.memberName') }}</span></label>
        <input v-model="props.member.name" class="input input-bordered input-sm w-full"
            :placeholder="t('sidebar.memberName')" />
    </div>

    <!-- 类型：radio 对（inline|agent 互转，编辑态也开放） -->
    <div class="form-control w-full mt-1">
        <label class="label py-1"><span class="label-text font-medium">{{ t('sidebar.memberType') }}</span></label>
        <div class="flex gap-4">
            <label class="label cursor-pointer gap-2 justify-start py-1">
                <input type="radio" class="radio radio-primary radio-sm" value="inline" v-model="props.member.type" />
                <span class="label-text">inline</span>
            </label>
            <label class="label cursor-pointer gap-2 justify-start py-1">
                <input type="radio" class="radio radio-primary radio-sm" value="agent" v-model="props.member.type" />
                <span class="label-text">agent</span>
            </label>
        </div>
    </div>

    <!-- agent 引用 / inline 人格（互斥字段面） -->
    <div v-if="props.member.type === 'agent'" class="form-control w-full">
        <label class="label py-1">
            <span class="label-text font-medium">{{ t('sidebar.memberAgent') }} <span class="text-error">*</span></span>
        </label>
        <select v-model="props.member.agentId" class="select select-bordered select-sm w-full font-sans">
            <option value="" disabled>{{ t('sidebar.memberAgent') }}</option>
            <option v-for="agent in agentsList" :key="agent.id" :value="agent.id">
                {{ agent.name || agent.id }}
            </option>
        </select>
    </div>
    <div v-else class="form-control w-full">
        <label class="label py-1">
            <span class="label-text font-medium">{{ t('sidebar.memberPrompt') }} <span class="text-error">*</span></span>
        </label>
        <textarea v-model="props.member.systemPrompt" class="textarea textarea-bordered h-24 text-sm w-full"
            :placeholder="t('sidebar.memberPrompt')" rows="3" />
    </div>

    <!-- 固定记忆 -->
    <label class="label cursor-pointer gap-2 justify-start py-1 w-fit">
        <span class="label-text text-sm">{{ t('sidebar.memoryToggle') }}</span>
        <input v-model="props.member.memory" type="checkbox" class="toggle toggle-sm toggle-primary" />
    </label>

    <!-- inline 成员子代理级配置（对齐 AgentSubagents 表单形态；agent 引用成员的
         模型/人格随其 agent 本体（编辑面在 agent 设置），不在此配置） -->
    <div v-if="props.member.type === 'inline'" class="border-t border-base-300 pt-3 mt-2 space-y-3">
        <div class="grid grid-cols-2 gap-2">
            <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs">{{ t('sidebar.memberModel') }}</span></label>
                <button ref="modelTriggerRef" type="button" @click.stop="toggleModelMenu"
                    class="btn btn-sm bg-base-200 gap-1 font-normal rounded-lg border border-base-300 hover:border-base-content/40 hover:bg-base-300 transition-all w-full justify-between h-8 min-h-8 px-2"
                    :title="t('provider.selectModel')">
                    <CpuChipIcon class="h-3.5 w-3.5 shrink-0" />
                    <span class="truncate flex-1 text-left">{{ currentModelLabel }}</span>
                    <ChevronDownIcon class="h-3 w-3 shrink-0 opacity-50 transition-transform"
                        :class="{ 'rotate-180': modelMenuOpen }" />
                </button>
            </div>
            <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs">{{ t('chat.thinkingLevel') }}</span></label>
                <button ref="thinkingTriggerRef" type="button" @click.stop="toggleThinkingMenu"
                    class="btn btn-sm bg-base-200 gap-1 font-normal rounded-lg border border-base-300 hover:border-base-content/40 hover:bg-base-300 transition-all w-full justify-between h-8 min-h-8 px-2">
                    <LightBulbIcon class="h-3.5 w-3.5 shrink-0" />
                    <span class="truncate flex-1 text-left">{{ props.member.thinkingLevel
                        ? t(`chat.thinkingLevels.${props.member.thinkingLevel}`) : t('sidebar.memberFollowGroupThinking') }}</span>
                    <ChevronDownIcon class="h-3 w-3 shrink-0 opacity-50 transition-transform"
                        :class="{ 'rotate-180': thinkingMenuOpen }" />
                </button>
            </div>
        </div>

        <!-- 模型/思考浮层（Teleport 出弹窗容器：成员行在 modal 内，纯 dropdown 会被 overflow 裁剪；
             定位/开合照 AgentSubagents 的模型下拉）── -->
        <Teleport to="body">
            <div v-if="modelMenuOpen" ref="modelPanelRef" :style="modelMenuStyle"
                class="z-[300] bg-base-100 rounded-box border border-base-300 shadow-xl overflow-hidden flex flex-col">
                <!-- 顶部清空项：跟随群默认（空值；同 AgentSubagents 的 Inherit Parent Model） -->
                <button type="button" @click="onModelSelect('')"
                    class="flex items-center gap-2 px-4 py-2 text-left text-xs hover:bg-base-200 transition-colors border-b border-base-300 shrink-0"
                    :class="{ 'bg-primary/10 text-primary': !props.member.model }">
                    {{ t('sidebar.memberFollowGroupModel') }}
                </button>
                <ModelSelectMenuContent :available-models="availableModels"
                    :current-model="props.member.model" @select="onModelSelect" />
            </div>
            <ul v-if="thinkingMenuOpen" ref="thinkingPanelRef" :style="thinkingMenuStyle"
                class="z-[300] menu p-2 bg-base-100 rounded-box border border-base-300 shadow-xl overflow-y-auto">
                <li>
                    <a @click="onThinkingSelect('')" class="flex items-center gap-2 rounded-lg"
                        :class="{ 'bg-primary/10 text-primary': !props.member.thinkingLevel }">
                        <span class="flex-1">{{ t('sidebar.memberFollowGroupThinking') }}</span>
                        <CheckIcon v-if="!props.member.thinkingLevel" class="h-4 w-4 shrink-0" />
                        <span v-else class="w-4 h-4 shrink-0"></span>
                    </a>
                </li>
                <li v-for="level in THINKING_LEVELS" :key="level">
                    <a @click="onThinkingSelect(level)" class="flex items-center gap-2 rounded-lg"
                        :class="{ 'bg-primary/10 text-primary': level === props.member.thinkingLevel }">
                        <span class="flex-1">{{ t(`chat.thinkingLevels.${level}`) }}</span>
                        <CheckIcon v-if="level === props.member.thinkingLevel" class="h-4 w-4 shrink-0" />
                        <span v-else class="w-4 h-4 shrink-0"></span>
                    </a>
                </li>
            </ul>
        </Teleport>

        <!-- 工具/技能/扩展：三段同构模式区收敛为 FilterModeSection（v7.4.3
             评审③I1——此前三段 ~140 行近逐字复制，仅字段名与三态/两态之差） -->
        <FilterModeSection title-key="agent.tab.tools" :modes="[
            { value: 'inherit', labelKey: 'sidebar.memberInheritHub' },
            { value: 'custom', labelKey: 'sidebar.memberCustom' },
        ]" v-model:mode="props.member.toolsMode"
            :inherit-hint-key="'sidebar.memberInheritHubHint'" :custom-hint-key="'agent.tools.hint'"
            :items="hubTools" item-value="name" item-label="name" item-mono
            :custom-empty-key="'agent.noTools'"
            :selected="props.member.enabledTools" @update:selected="props.member.enabledTools = $event"
            @toggle-all="(on: boolean) => toggleAllTools(on)" />

        <FilterModeSection title-key="agent.tab.skills" :modes="[
            { value: 'inherit', labelKey: 'sidebar.memberInheritHub' },
            { value: 'none', labelKey: 'sidebar.memberNone' },
            { value: 'custom', labelKey: 'sidebar.memberCustom' },
        ]" wrap v-model:mode="props.member.skillsMode"
            :custom-hint-key="'agent.skills.hint'"
            :items="hubSkills" item-value="id" item-label="name"
            :custom-empty-key="'agent.skills.noSkills'"
            :selected="props.member.enabledSkills" @update:selected="props.member.enabledSkills = $event"
            @toggle-all="(on: boolean) => toggleAllSkills(on)" />

        <FilterModeSection :title-key="'sidebar.memberExt'" :modes="[
            { value: 'inherit', labelKey: 'sidebar.memberInheritHub' },
            { value: 'custom', labelKey: 'sidebar.memberCustom' },
        ]" v-model:mode="props.member.extensionsMode"
            :custom-hint-key="'sidebar.memberExtHint'"
            :items="extensionOptions" item-value="id" item-label="name"
            :custom-empty-key="'agent.subagents.noExtensions'"
            :selected="props.member.selectedExtensions" @update:selected="props.member.selectedExtensions = $event"
            @toggle-all="(on: boolean) => toggleAllExtensions(on)" />
    </div>
</template>
