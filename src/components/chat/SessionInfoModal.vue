<script setup lang="ts">
import { computed } from 'vue'
import { InformationCircleIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import type { SessionRow } from '../../composables/useSessionsState'

const props = defineProps<{
    open: boolean
    session: SessionRow | null
    loading?: boolean
}>()

const emit = defineEmits<{
    (e: 'close'): void
}>()

type InfoRow = { label: string; value: string }

const formatDate = (value?: string): string => {
    if (!value) return '-'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString()
}

const rows = computed<InfoRow[]>(() => {
    const s = props.session
    if (!s) return []
    return [
        { label: 'sidebar.sessionInfo.name', value: s.name || '-' },
        { label: 'sidebar.sessionInfo.id', value: s.id },
        { label: 'sidebar.sessionInfo.agent', value: s.agentName || s.agentId || '-' },
        { label: 'sidebar.sessionInfo.model', value: s.model || '-' },
        { label: 'sidebar.sessionInfo.provider', value: s.modelProvider || '-' },
        { label: 'sidebar.sessionInfo.thinkingLevel', value: s.thinkingLevel || '-' },
        { label: 'sidebar.sessionInfo.cwd', value: s.cwd || '-' },
        { label: 'sidebar.sessionInfo.path', value: s.path || '-' },
        { label: 'sidebar.sessionInfo.created', value: formatDate(s.created) },
        { label: 'sidebar.sessionInfo.modified', value: formatDate(s.modified) },
    ]
})
</script>

<template>
    <Teleport to="body">
        <Transition name="session-info-fade">
            <dialog v-if="open" class="modal modal-open z-[210]">
                <button class="modal-backdrop" type="button"
                    :aria-label="$t('common.close')" @click="emit('close')"></button>

                <section
                    class="row-start-1 col-start-1 m-3 sm:m-6 relative flex w-full max-w-lg max-h-[86vh] flex-col overflow-hidden rounded-2xl border border-base-content/10 bg-base-100 shadow-2xl">
                    <header
                        class="flex items-center justify-between gap-3 border-b border-base-content/10 bg-base-200/55 px-4 py-3">
                        <div class="flex items-center gap-2 min-w-0">
                            <InformationCircleIcon class="h-4 w-4 text-base-content/45 shrink-0" />
                            <h2 class="truncate text-sm font-semibold text-base-content">
                                {{ $t('sidebar.sessionInfo.title') }}
                            </h2>
                        </div>
                        <button type="button" class="btn btn-ghost btn-sm btn-circle" :title="$t('common.close')"
                            @click="emit('close')">
                            <XMarkIcon class="h-5 w-5" />
                        </button>
                    </header>

                    <div class="flex-1 overflow-auto bg-base-100 px-4 py-3">
                        <div v-if="loading" class="flex items-center justify-center py-10">
                            <span class="loading loading-spinner loading-md"></span>
                        </div>
                        <div v-else-if="!session" class="py-10 text-center text-sm text-base-content/50">
                            {{ $t('sidebar.sessionInfo.empty') }}
                        </div>
                        <dl v-else class="grid grid-cols-1 gap-2">
                            <div v-for="row in rows" :key="row.label"
                                class="flex flex-col gap-0.5 rounded-lg bg-base-200/40 px-3 py-2">
                                <dt class="text-[11px] font-medium uppercase tracking-wider text-base-content/45">
                                    {{ $t(row.label) }}
                                </dt>
                                <dd class="break-all text-sm text-base-content/85">{{ row.value }}</dd>
                            </div>
                        </dl>
                    </div>
                </section>
            </dialog>
        </Transition>
    </Teleport>
</template>

<style scoped>
.session-info-fade-enter-active,
.session-info-fade-leave-active {
    transition: opacity 160ms ease;
}

.session-info-fade-enter-from,
.session-info-fade-leave-to {
    opacity: 0;
}
</style>
