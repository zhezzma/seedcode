<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
    BoltIcon,
    ListBulletIcon,
    PencilSquareIcon,
    PlusIcon,
    XMarkIcon,
} from '@heroicons/vue/24/outline'
import { useI18n } from 'vue-i18n'

import ViewHeader from '@/components/ViewHeader.vue'
import DeliveryTargetsEditor from '@/components/delivery/DeliveryTargetsEditor.vue'
import ExecutionTargetEditor from '@/components/cron/ExecutionTargetEditor.vue'
import { useToast } from '../composables/useToast'
import { useCronState, type CronFormState, type CronRunLogEntry, type TaskJob } from '../composables/useCronState'
import { useAgentsState } from '../composables/useAgentsState'
import { useConfirm } from '../composables/useConfirm'
import { useSessionsState } from '../composables/useSessionsState'
import { defaultCronDeliveryTargets, summarizeDeliveryTargets } from '../utils/delivery-targets'
import { summarizeExecutionTarget } from '../utils/cron-execution-target'
import { mergeExecutionTargetCandidates } from '../utils/cron-session-search'
import { validateCronForm } from '../utils/form-validation'

const toastStore = useToast()
const { confirm } = useConfirm()
const { t } = useI18n()
const cronState = useCronState()
const {
    addCronJob,
    loadCron,
    loadCronRuns,
    removeCronJob,
    runCronJob,
    toggleCronJob,
    updateCronJob,
    searchSessions,
} = cronState

const agentsState = useAgentsState()
const sessionsState = useSessionsState()

const defaultForm = (): CronFormState => ({
    name: '',
    description: '',
    executionTarget: { type: 'newSession', agentId: '' },
    enabled: true,
    scheduleKind: 'cron',
    scheduleAt: '',
    everyAmount: '30',
    everyUnit: 'minutes',
    cronExpr: '*/30 * * * *',
    cronTz: '',
    payloadText: '',
    timeoutSeconds: '',
    deliveryTargets: defaultCronDeliveryTargets(),
    newBranchEachRun: true,
})

const form = ref<CronFormState>(defaultForm())
const editingId = ref<string | null>(null)
const runningJobId = ref<string | null>(null)
const modalError = ref<string | null>(null)
const deliveryValidation = ref({ valid: true, errors: [] as string[] })
const executionTargetValid = ref(true)
const deliveryEditorKey = ref(0)

const logsJob = ref<TaskJob | null>(null)
const logsLoading = ref(false)
const cronRunLogs = ref<CronRunLogEntry[]>([])

const agents = computed(() => (agentsState.agentsList || []).map(agent => ({
    id: agent.id,
    name: agent.name || agent.id,
})))
const cachedSessionCandidates = computed(() => {
    const sessions = [
        ...(sessionsState.sessionsResult?.sessions || []),
        ...(sessionsState.taskSessionsResult?.sessions || []),
    ].map(session => ({
        id: session.id,
        name: session.name,
        agentId: session.agentId,
        agentName: session.agentName,
        sessionCategory: session.sessionCategory,
        modified: typeof session.modified === 'string' ? session.modified : undefined,
    }))

    return mergeExecutionTargetCandidates(sessions, [], '', Math.max(sessions.length, 10))
})
const modalTitle = computed(() => editingId.value ? t('cron.editJob') : t('cron.newJobModal'))

const formatDate = (ts: number | string | undefined) => {
    if (!ts) return '-'
    return new Date(ts).toLocaleString()
}

const getScheduleDisplay = (job: TaskJob) => {
    if (job.scheduleKind === 'cron') return t('cron.display.cron', { expr: job.cronExpr })
    if (job.scheduleKind === 'every') {
        return t('cron.display.every', { amount: job.everyAmount, unit: t(`cron.units.${job.everyUnit}`) })
    }
    if (job.scheduleKind === 'at') return t('cron.display.at', { date: job.scheduleAt })
    return t('cron.display.unknown')
}

const getDeliverySummary = (targets: TaskJob['deliveryTargets']) => summarizeDeliveryTargets(targets || [])
const getExecutionTargetSummary = (job: TaskJob) => {
    const target = job.executionTarget
    const agentName = target.type === 'newSession'
        ? agents.value.find(agent => agent.id === target.agentId)?.name
        : undefined
    const summary = summarizeExecutionTarget(target, agentName)
    return summary.mode === 'existingSession'
        ? `复用会话: ${summary.primaryText}`
        : `新建会话: ${summary.primaryText}`
}

const openModal = () => {
    const modal = document.getElementById('job_modal') as HTMLDialogElement | null
    modal?.showModal()
}

const closeModal = () => {
    const modal = document.getElementById('job_modal') as HTMLDialogElement | null
    modal?.close()
}

const resetDeliveryEditor = () => {
    deliveryValidation.value = { valid: true, errors: [] }
    executionTargetValid.value = true
    deliveryEditorKey.value += 1
}

const handleDeliveryValidationChange = (payload: { valid: boolean; errors: string[] }) => {
    deliveryValidation.value = payload
}

const handleExecutionTargetValidityChange = (valid: boolean) => {
    executionTargetValid.value = valid
}

const handleOpenAdd = () => {
    editingId.value = null
    modalError.value = null
    form.value = defaultForm()
    if (agents.value.length > 0) {
        form.value.executionTarget = { type: 'newSession', agentId: agents.value[0].id }
    }
    resetDeliveryEditor()
    openModal()
}

const handleOpenEdit = (job: TaskJob) => {
    editingId.value = job.id
    modalError.value = null
    form.value = {
        name: job.name,
        description: job.description || '',
        executionTarget: job.executionTarget || { type: 'newSession', agentId: agents.value[0]?.id || '' },
        enabled: job.enabled,
        scheduleKind: job.scheduleKind,
        scheduleAt: job.scheduleAt || '',
        everyAmount: job.everyAmount || '30',
        everyUnit: job.everyUnit || 'minutes',
        cronExpr: job.cronExpr || '*/30 * * * *',
        cronTz: job.cronTz || '',
        payloadText: job.payloadText || '',
        timeoutSeconds: job.timeoutSeconds || '',
        deliveryTargets: job.deliveryTargets?.length ? job.deliveryTargets : defaultCronDeliveryTargets(),
        newBranchEachRun: job.newBranchEachRun !== false,
    }
    resetDeliveryEditor()
    openModal()
}

const handleSave = async () => {
    const errors = validateCronForm(form.value, deliveryValidation.value.valid, executionTargetValid.value)
    if (errors.length > 0) {
        modalError.value = errors[0]
        return
    }

    modalError.value = null
    try {
        if (editingId.value) {
            await updateCronJob(editingId.value, { ...form.value })
        } else {
            await addCronJob({ ...form.value })
        }
        closeModal()
    } catch (err: any) {
        modalError.value = err?.message || String(err)
    }
}

const handleToggle = async (job: TaskJob, e: Event) => {
    e.stopPropagation()
    await toggleCronJob(job, !job.enabled)
}

const handleRemove = async (job: TaskJob, e: Event) => {
    e.stopPropagation()
    if (!await confirm(t('cron.confirmDelete'))) return
    await removeCronJob(job)
}

const handleRun = async (job: TaskJob, e: Event) => {
    e.stopPropagation()
    if (!await confirm(t('cron.confirmRun'))) return
    runningJobId.value = job.id
    try {
        await runCronJob(job)
        if (logsJob.value?.id === job.id) {
            cronRunLogs.value = await loadCronRuns(job.id)
        }
    } catch (err: any) {
        toastStore.error(err?.message || String(err))
    } finally {
        runningJobId.value = null
    }
}

const handleViewLogs = async (job: TaskJob) => {
    logsJob.value = job
    logsLoading.value = true
    const modal = document.getElementById('logs_modal') as HTMLDialogElement | null
    modal?.showModal()
    try {
        cronRunLogs.value = await loadCronRuns(job.id)
    } finally {
        logsLoading.value = false
    }
}

onMounted(() => {
    void loadCron()
    void sessionsState.loadSessions()
    void sessionsState.loadTaskSessions()
})
</script>

<template>
    <div class="flex flex-col h-full">
        <ViewHeader :title="$t('cron.title')" wc-pad :is-main-page="true">
            <template #actions>
                <div class="flex items-center gap-5">
                    <button @click="handleOpenAdd" class="btn btn-ghost btn-circle btn-xs" :title="$t('cron.newJob')">
                        <PlusIcon class="w-5 h-5" />
                    </button>
                </div>
            </template>
        </ViewHeader>

        <div class="flex-1 overflow-y-auto p-4 md:p-6">
            <div class="mx-auto space-y-6 w-full">
                <div>
                    <p v-if="cronState.cronLoading && cronState.cronJobs.length === 0"
                        class="text-center py-8 opacity-50">
                        {{ $t('common.loading') }}
                    </p>
                    <div v-if="!cronState.cronLoading && cronState.cronJobs.length === 0"
                        class="text-center py-12 opacity-50">
                        <div class="text-6xl mb-4">💤</div>
                        <p>{{ $t('cron.noJobs') }}</p>
                        <button @click="handleOpenAdd" class="btn btn-link">{{ $t('cron.createOne') }}</button>
                    </div>

                    <div v-else class="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                        <div v-for="job in cronState.cronJobs" :key="job.id"
                            class="card bg-base-200 shadow-sm border border-base-300 cursor-pointer hover:border-primary transition-colors hover:shadow-md group h-full"
                            @click="handleViewLogs(job)">
                            <div class="card-body p-3 sm:p-4">
                                <div class="flex items-center justify-between gap-2">
                                    <div class="flex items-center gap-2 min-w-0">
                                        <button @click="handleToggle(job, $event)"
                                            class="btn btn-xs btn-ghost tooltip tooltip-top"
                                            :class="job.enabled ? 'text-success' : 'text-base-content opacity-50'"
                                            :data-tip="job.enabled ? $t('cron.clickToDisable') : $t('cron.clickToEnable')">
                                            <div class="w-2 h-2 rounded-full"
                                                :class="job.enabled ? 'bg-success' : 'bg-base-content/30'"></div>
                                        </button>
                                        <h4 class="font-bold text-base truncate">{{ job.name }}</h4>
                                    </div>
                                    <div class="flex items-center gap-1 shrink-0">
                                        <div class="badge badge-sm font-mono" :class="{
                                            'badge-neutral': job.scheduleKind === 'cron',
                                            'badge-primary': job.scheduleKind === 'every',
                                            'badge-secondary': job.scheduleKind === 'at',
                                        }">
                                            {{ job.scheduleKind }}
                                        </div>
                                    </div>
                                </div>

                                <div class="text-xs opacity-60 truncate pl-6 -mt-1">{{ getScheduleDisplay(job) }}</div>

                                <div class="flex flex-col gap-2 mt-3 text-xs opacity-70">
                                    <p class="line-clamp-2">{{ job.description || 'No description' }}</p>
                                    <p class="truncate">{{ getExecutionTargetSummary(job) }}</p>
                                    <p class="truncate">{{ $t('delivery.targets') }}: {{
                                        getDeliverySummary(job.deliveryTargets)
                                    }}</p>

                                    <div class="flex items-center justify-between pt-2 border-t border-base-300">
                                        <span class="opacity-50">{{ job.createdAt ? formatDate(job.createdAt) : ''
                                        }}</span>
                                        <div class="flex items-center gap-1">
                                            <button @click="handleRun(job, $event)"
                                                class="btn btn-xs btn-ghost border-base-content/20"
                                                :disabled="runningJobId === job.id" title="Run Now">
                                                <span v-if="runningJobId === job.id"
                                                    class="loading loading-spinner loading-xs"></span>
                                                <BoltIcon v-else class="w-3.5 h-3.5" />
                                            </button>
                                            <button @click.stop="handleOpenEdit(job)" class="btn btn-xs btn-ghost"
                                                title="Edit">
                                                <PencilSquareIcon class="w-3.5 h-3.5" />
                                            </button>
                                            <button @click="handleRemove(job, $event)"
                                                class="btn btn-xs btn-ghost text-error/50 hover:text-error"
                                                title="Delete">
                                                <XMarkIcon class="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <dialog id="job_modal" class="modal">
            <div class="modal-box w-full max-w-2xl">
                <form method="dialog">
                    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
                </form>
                <h3 class="font-bold text-lg mb-6 text-center">{{ modalTitle }}</h3>

                <div class="space-y-4 max-h-[70vh] overflow-y-auto px-1">
                    <div class="form-control w-full">
                        <label class="label">
                            <span class="label-text">{{ $t('cron.form.name') }} <span class="text-error">*</span></span>
                        </label>
                        <input v-model="form.name" type="text" class="input input-bordered w-full"
                            :placeholder="$t('cron.form.namePlaceholder')" />
                    </div>

                    <div class="form-control w-full">
                        <label class="label"><span class="label-text">{{ $t('cron.form.description') }}</span></label>
                        <input v-model="form.description" type="text" class="input input-bordered w-full"
                            :placeholder="$t('cron.form.descPlaceholder')" />
                    </div>

                    <ExecutionTargetEditor v-model="form.executionTarget" :agents="agents"
                        :cached-candidates="cachedSessionCandidates" :remote-search="searchSessions"
                        @validity-change="handleExecutionTargetValidityChange" />

                    <div class="form-control">
                        <label class="label"><span class="label-text">{{ $t('cron.form.scheduleKind') }}</span></label>
                        <div class="join w-full">
                            <input class="join-item btn flex-1" type="radio" name="schedule-kind"
                                :aria-label="$t('cron.form.every')" :checked="form.scheduleKind === 'every'"
                                @click="form.scheduleKind = 'every'" />
                            <input class="join-item btn flex-1" type="radio" name="schedule-kind"
                                :aria-label="$t('cron.form.cron')" :checked="form.scheduleKind === 'cron'"
                                @click="form.scheduleKind = 'cron'" />
                            <input class="join-item btn flex-1" type="radio" name="schedule-kind"
                                :aria-label="$t('cron.form.at')" :checked="form.scheduleKind === 'at'"
                                @click="form.scheduleKind = 'at'" />
                        </div>
                    </div>

                    <div v-if="form.scheduleKind === 'every'" class="flex gap-2">
                        <div class="form-control flex-1">
                            <label class="label">
                                <span class="label-text">{{ $t('cron.form.everyAmount') }} <span
                                        class="text-error">*</span></span>
                            </label>
                            <input v-model="form.everyAmount" type="number" class="input input-bordered w-full" />
                        </div>
                        <div class="form-control flex-1">
                            <label class="label">
                                <span class="label-text">{{ $t('cron.form.everyUnit') }} <span
                                        class="text-error">*</span></span>
                            </label>
                            <select v-model="form.everyUnit" class="select select-bordered w-full">
                                <option value="minutes">{{ $t('cron.units.minutes') }}</option>
                                <option value="hours">{{ $t('cron.units.hours') }}</option>
                                <option value="days">{{ $t('cron.units.days') }}</option>
                            </select>
                        </div>
                    </div>

                    <div v-if="form.scheduleKind === 'cron'" class="form-control w-full">
                        <label class="label">
                            <span class="label-text">{{ $t('cron.form.cron') }} <span class="text-error">*</span></span>
                        </label>
                        <input v-model="form.cronExpr" type="text" class="input input-bordered w-full font-mono"
                            placeholder="* * * * *" />
                        <label class="label"><span class="label-text-alt opacity-50">{{ $t('cron.form.cronHint')
                        }}</span></label>
                    </div>

                    <div v-if="form.scheduleKind === 'at'" class="form-control w-full">
                        <label class="label">
                            <span class="label-text">{{ $t('cron.form.scheduleAt') }} <span
                                    class="text-error">*</span></span>
                        </label>
                        <input v-model="form.scheduleAt" type="datetime-local" class="input input-bordered w-full" />
                    </div>

                    <div class="form-control w-full">
                        <label class="label"><span class="label-text">{{ $t('cron.form.payloadLabel') }}</span></label>
                        <textarea v-model="form.payloadText" class="textarea textarea-bordered h-24 w-full"
                            :placeholder="$t('cron.form.payloadAgentLabel')"></textarea>
                    </div>

                    <div v-if="form.executionTarget.type === 'existingSession'" class="form-control">
                        <label class="label cursor-pointer justify-start gap-3">
                            <span class="label-text">{{ $t('cron.form.newBranchEachRun') }}</span>
                            <input v-model="form.newBranchEachRun" type="checkbox" class="toggle toggle-primary" />
                        </label>
                        <label class="label">
                            <span class="label-text-alt opacity-50">{{ $t('cron.form.newBranchEachRunHint') }}</span>
                        </label>
                    </div>

                    <DeliveryTargetsEditor :key="deliveryEditorKey" v-model="form.deliveryTargets"
                        @validation-change="handleDeliveryValidationChange" />

                    <div class="form-control">
                        <label class="label cursor-pointer justify-start gap-3">
                            <span class="label-text">{{ $t('cron.form.enableJob') }}</span>
                            <input v-model="form.enabled" type="checkbox" class="toggle toggle-primary" />
                        </label>
                    </div>
                </div>

                <div v-if="modalError" class="alert alert-error mt-4"><span class="text-sm">{{ modalError }}</span>
                </div>

                <div class="modal-action">
                    <button class="btn" @click="closeModal">{{ $t('common.cancel') }}</button>
                    <button class="btn btn-primary" @click="handleSave" :disabled="cronState.cronSaving">
                        <span v-if="cronState.cronSaving" class="loading loading-spinner"></span>
                        {{ editingId ? $t('common.save') : $t('cron.createJob') }}
                    </button>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop"><button>{{ $t('common.close') }}</button></form>
        </dialog>

        <dialog id="logs_modal" class="modal">
            <div class="modal-box w-full max-w-2xl">
                <form method="dialog">
                    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
                </form>
                <h3 class="font-bold text-lg mb-4 flex items-center gap-2">
                    <ListBulletIcon class="w-5 h-5" /> {{ $t('cron.logs.title') }}
                </h3>
                <div v-if="logsLoading" class="flex justify-center py-8">
                    <span class="loading loading-spinner loading-lg"></span>
                </div>
                <div v-else-if="cronState.cronError" class="alert alert-error my-4"><span>{{ cronState.cronError
                }}</span></div>
                <div v-else-if="cronRunLogs.length === 0" class="text-center py-8 opacity-50">{{ $t('cron.logs.noLogs')
                }}</div>
                <div v-else class="overflow-x-auto max-h-[60vh]">
                    <table class="table table-zebra table-xs sm:table-sm w-full font-mono">
                        <thead>
                            <tr>
                                <th>{{ $t('common.time') }}</th>
                                <th>{{ $t('common.status') }}</th>
                                <th>{{ $t('common.duration') }}</th>
                                <th>{{ $t('common.info') }}</th>
                                <th>Session</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="(log, idx) in cronRunLogs" :key="idx">
                                <td class="whitespace-nowrap">{{ formatDate(log.logTimestamp) }}</td>
                                <td>
                                    <span class="badge badge-xs" :class="{
                                        'badge-success': log.status === 'OK' || log.status === 'ok',
                                        'badge-error': log.status === 'error' || log.status === 'FAIL',
                                        'badge-warning': log.status === 'skipped' || log.status === 'SKIPPED',
                                    }">
                                        {{ log.status }}
                                    </span>
                                </td>
                                <td>{{ log.durationMs ? `${log.durationMs}ms` : '-' }}</td>
                                <td class="max-w-[200px] truncate" :title="log.result">{{ log.result || '-' }}</td>
                                <td class="text-xs opacity-50">{{ log.sessionId }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop"><button>Close</button></form>
        </dialog>
    </div>
</template>
