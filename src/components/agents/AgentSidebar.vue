<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { PlusIcon } from '@heroicons/vue/24/outline'
import ViewHeader from '@/components/ViewHeader.vue'
import AgentAvatar from './AgentAvatar.vue'
import { AgentInfo } from '~/src/composables/useAgentsState'


const props = defineProps<{
    agents: AgentInfo[]
    selectedId: string | null
}>()

const emit = defineEmits<{
    (e: 'select', id: string): void
    (e: 'add'): void
}>()

const { t } = useI18n()
</script>

<template>
    <div class="h-full flex flex-col">
        <!-- Header -->
        <ViewHeader :title="$t('agent.title')" :is-main-page="true">
            <template #actions>
                <button @click="emit('add')" class="btn btn-ghost btn-sm btn-circle">
                    <PlusIcon class="w-5 h-5" />
                </button>
            </template>
        </ViewHeader>

        <!-- Agent List -->
        <div class="flex-1 overflow-y-auto">
            <div v-if="!agents.length"
                class="flex flex-col items-center justify-center h-full p-8 text-base-content/50">
                <div class="text-4xl mb-4">🤖</div>
                <p class="text-center italic text-sm">{{ $t('agent.noAgents') }}</p>
            </div>

            <ul v-else>
                <li v-for="agent in agents" :key="agent.id" @click="emit('select', agent.id)"
                    class="group flex items-stretch pl-4 cursor-pointer hover:bg-base-300 transition-colors"
                    :class="selectedId === agent.id ? 'hover:bg-primary/20 bg-primary/20' : ''">

                    <!-- Avatar -->
                    <div class="self-center shrink-0 my-3 mr-3">
                        <AgentAvatar :avatar="agent.avatar" :name="agent.name"
                            size="md" />
                    </div>

                    <!-- Content -->
                    <div class="flex-1 flex items-center py-3 pr-4 border-b min-w-0 group-last:border-none"
                        :class="selectedId === agent.id ? 'border-none' : 'border-base-300 '">
                        <div class="flex-1 min-w-0">
                            <div class="font-bold text-[15px] text-base-content truncate">
                                {{ agent.name || agent.id }}
                            </div>
                            <div class="text-xs text-base-content/50 truncate">
                                {{ agent.description }}
                            </div>
                        </div>
                    </div>
                </li>
            </ul>
        </div>
    </div>
</template>
