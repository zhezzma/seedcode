<script setup lang="ts">
import { ref, watch } from 'vue'

import { useSkillsState } from '../../../composables/useSkillsState'
import { useToast } from '../../../composables/useToast'
import { useI18n } from 'vue-i18n'
import { TrashIcon, CubeTransparentIcon, DocumentTextIcon, PuzzlePieceIcon, ChevronDownIcon } from '@heroicons/vue/24/outline'

// Props
const props = defineProps<{
    agent: any
}>()

const skillsState = useSkillsState()
const toast = useToast()
const { t } = useI18n()

const loading = ref(false)
const processing = ref<Record<string, boolean>>({})

const globalSkills = ref<any[]>([])

// 扩展技能分组（客户端按 extensionId 分组，方案 B 2026-10-04：列表条目自带
// extensionId/extensionName/kind，不再调 /api/skills/extensions）
const extensionSkills = ref<any[]>([])
const expandedExtensions = ref<Record<string, boolean>>({})

// Agent skills are now full objects, not just strings
const agentSkills = ref<any[]>([])

// 全量 catalog 按归属分组：extensionId 条目进扩展区，其余按 scope 分 agent/global
// （system 条目沿旧口径不展示）
const groupSkills = (skills: any[]) => {
    const extGroups = new Map<string, any[]>()
    for (const skill of skills) {
        if (skill.extensionId) {
            const list = extGroups.get(skill.extensionId) ?? []
            list.push(skill)
            extGroups.set(skill.extensionId, list)
        }
    }
    agentSkills.value = skills.filter((s) => !s.extensionId && s.scope === 'agent')
    globalSkills.value = skills.filter((s) => !s.extensionId && s.scope === 'global')
    extensionSkills.value = [...extGroups.entries()].map(([extensionId, entries]) => {
        // 根身份位（kind 'extension-skill'）承载扩展开关；无根技能的扩展开关不可用
        const root = entries.find((s) => s.kind === 'extension-skill')
        const basis = root ?? entries[0]
        return {
            extensionId,
            name: basis.extensionName || extensionId,
            hasRootSkill: !!root,
            rootSkillName: root?.name,
            enabled: !!basis.enabled,
            globallyDisabled: !!basis.extensionGloballyDisabled,
            skills: entries.map((s) => ({
                name: s.name,
                description: s.description,
                root: s.kind === 'extension-skill'
            }))
        }
    })
}

const fetchSkills = async () => {
    if (!props.agent?.id) return
    loading.value = true
    try {
        groupSkills(await skillsState.loadAgentSkills(props.agent.id))
    } finally {
        loading.value = false
    }
}

watch(() => props.agent?.id, fetchSkills, { immediate: true })

const handleUninstall = async (skillId: string) => {
    if (!confirm(t('skills.confirmUninstall', { name: skillId }))) return

    processing.value[skillId] = true
    try {
        await skillsState.uninstallAgentSkill(props.agent.id, skillId)
        agentSkills.value = agentSkills.value.filter(s => s.id !== skillId)
        toast.success(t('skills.uninstallSuccess', { name: skillId }))
    } catch (e: any) {
        toast.error(t('skills.uninstallFailed', { error: e.message }))
    } finally {
        processing.value[skillId] = false
    }
}

// Extension-skill whose backing extension is globally disabled cannot be toggled on
const isExtensionGloballyDisabled = (skill: any) =>
    skill?.kind === 'extension-skill' && !!skill?.extensionGloballyDisabled

// Revert the checkbox DOM state when the request fails (:checked is one-way bound,
// so Vue won't reset a user-flipped checkbox by itself)
const revertToggle = (skill: any, event?: Event) => {
    const input = event?.target as HTMLInputElement | null
    if (input) input.checked = !!skill.enabled
}

const toggleSkill = async (skill: any, event?: Event) => {
    if (isExtensionGloballyDisabled(skill)) {
        revertToggle(skill, event)
        toast.error(t('skills.extensionGloballyDisabledHint'))
        return
    }
    const skillId = skill.id
    processing.value[skillId] = true
    try {
        const newEnabled = !skill.enabled
        await skillsState.toggleAgentSkill(props.agent.id, skillId, newEnabled)
        skill.enabled = newEnabled
    } catch (e: any) {
        revertToggle(skill, event)
        toast.error(t('skills.updateFailed', { error: e.message }))
    } finally {
        processing.value[skillId] = false
    }
}

const handleUninstallGlobal = async (skillId: string) => {
    if (!confirm(t('skills.confirmUninstall', { name: skillId }))) return

    processing.value[skillId] = true
    try {
        await skillsState.uninstallGlobalSkill(props.agent.id, skillId)
        globalSkills.value = globalSkills.value.filter(s => s.id !== skillId)
        toast.success(t('skills.uninstallSuccess', { name: skillId }))
    } catch (e: any) {
        toast.error(t('skills.uninstallFailed', { error: e.message }))
    } finally {
        processing.value[skillId] = false
    }
}

const toggleGlobalOrSystemSkill = async (skill: any, event?: Event) => {
    if (isExtensionGloballyDisabled(skill)) {
        revertToggle(skill, event)
        toast.error(t('skills.extensionGloballyDisabledHint'))
        return
    }
    const skillId = skill.id
    processing.value[skillId] = true
    try {
        const newEnabled = !skill.enabled
        await skillsState.toggleAgentSkill(props.agent.id, skillId, newEnabled)
        skill.enabled = newEnabled
    } catch (e: any) {
        revertToggle(skill, event)
        toast.error(t('skills.updateFailed', { error: e.message }))
    } finally {
        processing.value[skillId] = false
    }
}

// 扩展开关：语义 = 启停整个扩展（服务端按根技能名路由到 disabledExtensions）。
// 无根技能（无身份技能位）的扩展开关不可用；全局禁用下不允许 agent 级重新打开。
const revertExtToggle = (ext: any, event?: Event) => {
    const input = event?.target as HTMLInputElement | null
    if (input) input.checked = !!ext.enabled
}

const toggleExtension = async (ext: any, event?: Event) => {
    if (ext.globallyDisabled) {
        revertExtToggle(ext, event)
        toast.error(t('skills.extensionGloballyDisabledHint'))
        return
    }
    if (!ext.hasRootSkill || !ext.rootSkillName) {
        revertExtToggle(ext, event)
        toast.error(t('skills.extensionNoRootSkillHint'))
        return
    }
    processing.value[ext.extensionId] = true
    try {
        const newEnabled = !ext.enabled
        await skillsState.toggleAgentSkill(props.agent.id, ext.rootSkillName, newEnabled)
        ext.enabled = newEnabled
    } catch (e: any) {
        revertExtToggle(ext, event)
        toast.error(t('skills.updateFailed', { error: e.message }))
    } finally {
        processing.value[ext.extensionId] = false
    }
}

const toggleExpand = (ext: any) => {
    expandedExtensions.value[ext.extensionId] = !expandedExtensions.value[ext.extensionId]
}

// View Skill Doc Logic
const currentSkillDocTitle = ref('')
const currentSkillDocContent = ref('')
const loadingDoc = ref(false)

const openSkillDoc = async (skill: any, type: 'agent' | 'global') => {
    currentSkillDocTitle.value = skill.name
    currentSkillDocContent.value = ''
    loadingDoc.value = true

    const modal = document.getElementById('skill_doc_modal') as HTMLDialogElement
    if (modal) modal.showModal()

    try {
        let content = null
        if (type === 'agent') {
            content = await skillsState.getAgentSkillContent(props.agent.id, skill.id)
        } else if (type === 'global') {
            content = await skillsState.getGlobalSkillContent(props.agent.id, skill.id)
        }
        currentSkillDocContent.value = content || t('skills.noContent', 'No documentation available.')
    } catch (e: any) {
        currentSkillDocContent.value = t('skills.loadError', 'Failed to load documentation.')
        console.error(e)
    } finally {
        loadingDoc.value = false
    }
}
</script>

<template>
    <div class="h-full flex flex-col overflow-y-auto p-4 space-y-8">
        <!-- Agent Specific Skills -->
        <div>
            <h3 class="text-sm font-bold text-base-content/70 uppercase tracking-wider mb-4 px-1">
                {{ $t('skills.agentSkills') }}
            </h3>

            <div v-if="loading" class="flex justify-center p-4">
                <span class="loading loading-spinner text-primary"></span>
            </div>

            <div v-else-if="!agentSkills.length"
                class="text-center p-8 border-2 border-dashed border-base-300 rounded-lg">
                <CubeTransparentIcon class="w-10 h-10 mx-auto mb-2 text-base-content/30" />
                <p class="text-base-content/50">{{ $t('skills.noAgentSkills') }}</p>
                <p class="text-xs text-base-content/40 mt-1">{{ $t('skills.installFromStore') }}</p>
            </div>

            <div v-else class="grid grid-cols-1 gap-3">
                <div v-for="skill in agentSkills" :key="skill.id"
                    class="card bg-base-200 border border-base-300 shadow-sm">
                    <div class="card-body p-4 flex-row items-center justify-between gap-4">
                        <div class="flex items-center gap-3 overflow-hidden">
                            <div
                                class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                                <CubeTransparentIcon class="w-6 h-6" />
                            </div>
                            <div class="min-w-0">
                                <h3 class="font-bold truncate" :title="skill.name">
                                    {{ skill.name }}
                                </h3>
                                <div class="flex items-center gap-2">
                                    <p class="text-xs text-base-content/60 font-mono truncate">{{ skill.name }}</p>
                                    <!-- <span v-if="!skill.enabled" class="badge badge-xs badge-warning">{{
                                        $t('common.disabled') }}</span> -->
                                </div>
                            </div>
                        </div>

                        <div class="flex items-center gap-2 shrink-0">
                            <!-- Document button -->
                            <button class="btn btn-ghost btn-square btn-sm text-base-content/60 hover:text-primary"
                                :title="$t('common.viewDoc') || 'View Document'" @click="openSkillDoc(skill, 'agent')">
                                <DocumentTextIcon class="w-4 h-4" />
                            </button>

                            <!-- Helper to toggle -->
                            <span v-if="isExtensionGloballyDisabled(skill)"
                                class="badge badge-xs badge-warning">{{ $t('skills.extensionGloballyDisabled') }}</span>
                            <span
                                :title="isExtensionGloballyDisabled(skill) ? $t('skills.extensionGloballyDisabledHint') : ''">
                                <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="skill.enabled"
                                    :disabled="processing[skill.id] || isExtensionGloballyDisabled(skill)"
                                    @change="toggleSkill(skill, $event)" />
                            </span>

                            <button class="btn btn-ghost btn-square btn-sm text-error hover:bg-error/10"
                                :disabled="processing[skill.id]" @click="handleUninstall(skill.id)"
                                :title="$t('common.uninstall')">
                                <span v-if="processing[skill.id]" class="loading loading-spinner loading-xs"></span>
                                <TrashIcon v-else class="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Extension Skills（按扩展分组：开关 = 启停整个扩展；展开看全部技能） -->
        <div>
            <h3
                class="text-sm font-bold text-base-content/70 uppercase tracking-wider mb-4 px-1 flex items-center gap-2">
                {{ $t('skills.extensionSkills') }}
                <span class="badge badge-ghost badge-sm font-normal normal-case">{{ extensionSkills.length }}</span>
            </h3>

            <div v-if="!extensionSkills.length"
                class="text-center p-8 border-2 border-dashed border-base-300 rounded-lg">
                <p class="text-base-content/50">{{ $t('skills.noExtensionSkills') }}</p>
            </div>

            <div v-else class="grid grid-cols-1 gap-3">
                <div v-for="ext in extensionSkills" :key="ext.extensionId"
                    class="card bg-base-200 border border-base-300 shadow-sm">
                    <div class="card-body p-4 !gap-2">
                        <!-- 扩展行：图标/名称/技能数 + 开关 + 展开箭头 -->
                        <div class="flex-row flex items-center justify-between gap-4">
                            <div class="flex items-center gap-3 overflow-hidden cursor-pointer select-none flex-1 min-w-0"
                                @click="toggleExpand(ext)">
                                <div
                                    class="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center text-accent shrink-0">
                                    <PuzzlePieceIcon class="w-6 h-6" />
                                </div>
                                <div class="min-w-0">
                                    <h3 class="font-bold truncate" :title="ext.description || ext.extensionId">
                                        {{ ext.name }}
                                    </h3>
                                    <div class="flex items-center gap-2">
                                        <span class="text-xs text-base-content/60 font-mono truncate">{{
                                            ext.extensionId }}</span>
                                        <span class="badge badge-ghost badge-xs">{{
                                            $t('skills.extensionSkillCount', { n: ext.skills.length }) }}</span>
                                    </div>
                                </div>
                            </div>

                            <div class="flex items-center gap-2 shrink-0">
                                <span v-if="ext.globallyDisabled"
                                    class="badge badge-xs badge-warning">{{ $t('skills.extensionGloballyDisabled') }}</span>
                                <span :title="!ext.hasRootSkill
                                    ? $t('skills.extensionNoRootSkillHint')
                                    : (ext.globallyDisabled ? $t('skills.extensionGloballyDisabledHint') : $t('skills.extensionToggleHint'))">
                                    <input type="checkbox" class="toggle toggle-sm toggle-accent" :checked="ext.enabled"
                                        :disabled="processing[ext.extensionId] || !ext.hasRootSkill || ext.globallyDisabled"
                                        @change="toggleExtension(ext, $event)" />
                                </span>
                                <button class="btn btn-ghost btn-square btn-sm text-base-content/40"
                                    @click="toggleExpand(ext)">
                                    <ChevronDownIcon class="w-4 h-4 transition-transform"
                                        :class="expandedExtensions[ext.extensionId] ? 'rotate-180' : ''" />
                                </button>
                            </div>
                        </div>

                        <!-- 展开区：该扩展全部技能（根 + 子目录 + vendor，只读） -->
                        <div v-if="expandedExtensions[ext.extensionId]"
                            class="mt-1 pt-2 border-t border-base-300/60 space-y-1">
                            <div v-for="skill in ext.skills" :key="skill.name"
                                class="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-base-300/30">
                                <span v-if="skill.root" class="badge badge-xs badge-accent/80 shrink-0 mt-0.5">{{
                                    $t('skills.extensionRootSkill') }}</span>
                                <span class="font-mono text-xs font-semibold shrink-0">{{ skill.name }}</span>
                                <span class="text-xs text-base-content/60 truncate" :title="skill.description">{{
                                    skill.description }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Global Skills -->
        <div>
            <h3
                class="text-sm font-bold text-base-content/70 uppercase tracking-wider mb-4 px-1 flex items-center gap-2">
                {{ $t('skills.globalSkills') }}
                <span class="badge badge-ghost badge-sm font-normal normal-case">{{ globalSkills.length }}</span>
            </h3>

            <div v-if="!globalSkills.length" class="text-center p-8 border-2 border-dashed border-base-300 rounded-lg">
                <p class="text-base-content/50">{{ $t('skills.noGlobalSkills') }}</p>
            </div>

            <div v-else class="grid grid-cols-1 gap-3">
                <div v-for="skill in globalSkills" :key="skill.id"
                    class="card bg-base-200 border border-base-300 shadow-sm opacity-75 hover:opacity-100 transition-opacity">
                    <div class="card-body p-4 flex-row items-center justify-between gap-4">
                        <div class="flex items-center gap-3 overflow-hidden">
                            <div
                                class="w-10 h-10 rounded-lg bg-secondary/10 flex items-center justify-center text-secondary shrink-0">
                                <CubeTransparentIcon class="w-6 h-6" />
                            </div>
                            <div class="min-w-0">
                                <h3 class="font-bold truncate" :title="skill.name">
                                    {{ skill.name }}
                                </h3>
                                <p class="text-xs text-base-content/60 font-mono truncate">{{ skill.path }}</p>
                            </div>
                        </div>

                        <div class="flex items-center gap-2 shrink-0">
                            <!-- Document button -->
                            <button class="btn btn-ghost btn-square btn-sm text-base-content/60 hover:text-primary"
                                :title="$t('common.viewDoc') || 'View Document'" @click="openSkillDoc(skill, 'global')">
                                <DocumentTextIcon class="w-4 h-4" />
                            </button>

                            <!-- Toggle for Global Skill -->
                            <span v-if="isExtensionGloballyDisabled(skill)"
                                class="badge badge-xs badge-warning">{{ $t('skills.extensionGloballyDisabled') }}</span>
                            <span
                                :title="isExtensionGloballyDisabled(skill) ? $t('skills.extensionGloballyDisabledHint') : ''">
                                <input type="checkbox" class="toggle toggle-sm toggle-secondary" :checked="skill.enabled"
                                    :disabled="processing[skill.id] || isExtensionGloballyDisabled(skill)"
                                    @change="toggleGlobalOrSystemSkill(skill, $event)" />
                            </span>

                            <div class="badge badge-ghost badge-sm">{{ $t('common.global') }}</div>

                            <button class="btn btn-ghost btn-square btn-sm text-base-content/40 hover:text-error"
                                :disabled="processing[skill.id]" @click="handleUninstallGlobal(skill.id)"
                                :title="$t('common.uninstall')">
                                <span v-if="processing[skill.id]" class="loading loading-spinner loading-xs"></span>
                                <TrashIcon v-else class="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Skill Doc Modal -->
        <dialog id="skill_doc_modal" class="modal">
            <div class="modal-box w-11/12 max-w-4xl bg-base-100 p-0 overflow-hidden flex flex-col h-[80vh]">
                <div class="p-4 border-b border-base-300 flex justify-between items-center bg-base-200/50">
                    <h3 class="font-bold text-lg flex items-center gap-2">
                        <DocumentTextIcon class="w-5 h-5 text-primary" />
                        {{ currentSkillDocTitle }}
                    </h3>
                    <form method="dialog">
                        <button class="btn btn-sm btn-circle btn-ghost">✕</button>
                    </form>
                </div>
                <div class="p-4 overflow-y-auto flex-1 bg-base-100">
                    <div v-if="loadingDoc" class="flex justify-center items-center h-full">
                        <span class="loading loading-spinner loading-lg text-primary"></span>
                    </div>
                    <div v-else class="prose prose-sm max-w-none">
                        <pre
                            class="whitespace-pre-wrap font-mono text-sm bg-base-200/30 p-4 rounded-lg border border-base-300">{{ currentSkillDocContent }}</pre>
                    </div>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop">
                <button>close</button>
            </form>
        </dialog>
    </div>
</template>
