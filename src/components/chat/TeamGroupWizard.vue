<script setup lang="ts">
/**
 * team-chat 建群向导（最小版）：群名 + 成员双 source（agent 引用勾选 / inline 人格
 * 自定义）+ memory 开关。members[0]=群主（纯数组位置约定，无特权——首行即群主，
 * UI 不做特殊标记）。创建走 team-chat 扩展 POST /groups；成功后跳群壳会话。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { PlusIcon, TrashIcon, XMarkIcon } from '@heroicons/vue/24/outline'

import { useSessionsState, type TeamGroupMemberInput } from '../composables/useSessionsState'
import { useAgentsState } from '../composables/useAgentsState'
import { useToast } from '../composables/useToast'

interface MemberRow {
    name: string
    type: 'inline' | 'agent'
    systemPrompt: string
    agentId: string
    memory: boolean
}

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const router = useRouter()
const sessionsState = useSessionsState()
const agentsState = useAgentsState()
const toast = useToast()

const groupName = ref('')
const bulletin = ref('')
const creating = ref(false)
const members = ref<MemberRow[]>([
    { name: '', type: 'inline', systemPrompt: '', agentId: '', memory: false },
])

const agentsList = computed(() => agentsState.agentsList ?? [])

const addMember = () => {
    members.value.push({ name: '', type: 'inline', systemPrompt: '', agentId: '', memory: false })
}

const removeMember = (index: number) => {
    // 至少保留一行（群不能没有成员）；首行=群主位置也不单独保护（数组约定而已）
    if (members.value.length > 1) members.value.splice(index, 1)
}

const valid = computed(() => {
    if (!groupName.value.trim()) return false
    return members.value.every(m => {
        if (!m.name.trim()) return false
        if (m.type === 'agent') return Boolean(m.agentId)
        return Boolean(m.systemPrompt.trim())
    })
})

const createGroup = async () => {
    if (!valid.value || creating.value) return
    creating.value = true
    try {
        const payload: { name: string, members: TeamGroupMemberInput[], bulletin?: string } = {
            name: groupName.value.trim(),
            members: members.value.map(m => ({
                name: m.name.trim(),
                source: m.type === 'agent'
                    ? { type: 'agent', agentId: m.agentId }
                    : { type: 'inline', systemPrompt: m.systemPrompt },
                memory: m.memory,
            })),
        }
        if (bulletin.value.trim()) payload.bulletin = bulletin.value.trim()
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
    <!-- 遮罩层点击关闭；dialog 形态走 daisyUI（背景遮罩 + modal-box） -->
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="emit('close')">
        <div class="modal-box max-w-2xl bg-base-100 w-full">
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-semibold">{{ t('sidebar.newGroup') }}</h3>
                <button class="btn btn-ghost btn-sm" @click="emit('close')" :aria-label="t('sidebar.cancel')">
                    <XMarkIcon class="h-5 w-5" />
                </button>
            </div>

            <div class="space-y-4 max-h-[60vh] overflow-y-auto">
                <div>
                    <label class="text-sm text-base-content/70">{{ t('sidebar.groupName') }}</label>
                    <input v-model="groupName" class="input input-bordered input-sm w-full mt-1"
                        :placeholder="t('sidebar.groupName')" />
                </div>

                <div>
                    <label class="text-sm text-base-content/70">Bulletin</label>
                    <textarea v-model="bulletin" class="textarea textarea-bordered textarea-sm w-full mt-1" rows="2"
                        placeholder="群公告（可选，全体成员每回合共读）" />
                </div>

                <div>
                    <div class="text-sm text-base-content/70 mb-1">{{ t('sidebar.groupMembers') }}</div>
                    <div class="space-y-2">
                        <div v-for="(member, index) in members" :key="index"
                            class="flex flex-wrap items-center gap-2 rounded-lg border border-base-content/10 p-2">
                            <input v-model="member.name" class="input input-bordered input-sm flex-1 min-w-24"
                                :placeholder="t('sidebar.memberName')" />
                            <select v-model="member.type" class="select select-bordered select-sm">
                                <option value="inline">inline</option>
                                <option value="agent">agent</option>
                            </select>
                            <select v-if="member.type === 'agent'" v-model="member.agentId"
                                class="select select-bordered select-sm flex-1 min-w-32">
                                <option value="" disabled>{{ t('sidebar.memberAgent') }}</option>
                                <option v-for="agent in agentsList" :key="agent.id" :value="agent.id">
                                    {{ agent.name || agent.id }}
                                </option>
                            </select>
                            <textarea v-else v-model="member.systemPrompt"
                                class="textarea textarea-bordered textarea-sm flex-1 min-w-48"
                                :placeholder="t('sidebar.memberPrompt')" rows="1" />
                            <label class="label cursor-pointer gap-1 text-xs">
                                <span class="label-text">{{ t('sidebar.memoryToggle') }}</span>
                                <input v-model="member.memory" type="checkbox" class="toggle toggle-xs" />
                            </label>
                            <button class="btn btn-ghost btn-xs" @click="removeMember(index)"
                                :aria-label="t('sidebar.cancel')">
                                <TrashIcon class="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                    <button class="btn btn-ghost btn-sm mt-2 gap-1" @click="addMember">
                        <PlusIcon class="h-4 w-4" />
                        {{ t('sidebar.addMember') }}
                    </button>
                </div>
            </div>

            <div class="modal-action mt-4">
                <button class="btn btn-ghost btn-sm" @click="emit('close')">{{ t('sidebar.cancel') }}</button>
                <button class="btn btn-primary btn-sm" :disabled="!valid || creating" @click="createGroup">
                    {{ t('sidebar.createGroup') }}
                </button>
            </div>
        </div>
    </div>
</template>
