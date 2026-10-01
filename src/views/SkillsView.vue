<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useSkillsState } from '../composables/useSkillsState'
import { useToast } from '../composables/useToast'
import { useI18n } from 'vue-i18n'
import ViewHeader from '../components/ViewHeader.vue'
import AgentAvatar from '../components/agents/AgentAvatar.vue'
import {
    CpuChipIcon,
    TrashIcon,
    ArrowPathIcon,
    PencilSquareIcon,
    CheckIcon,
    XMarkIcon,
    UserIcon,
    GlobeAltIcon,
    DocumentTextIcon
} from '@heroicons/vue/24/outline'

import MarkdownRenderer from '../components/chat/MarkdownRenderer.vue'

import { useAgentsState } from '../composables/useAgentsState'
import { ConvexSkill } from '../composables/clawhub-client'



const skillsState = useSkillsState()
const agentsState = useAgentsState()
const toast = useToast()
const { t } = useI18n()

const loading = computed(() => skillsState.publicSkillsLoading)
const skills = computed(() => skillsState.publicSkills || [])

// Defines sort options mapping to API values
const sortOptions = computed(() => [
    { label: t('skills.sort.downloads'), value: 'downloads' },
    { label: t('skills.sort.installs'), value: 'installs' },
    { label: t('skills.sort.stars'), value: 'stars' },
    { label: t('skills.sort.newest'), value: 'newest' },
    { label: t('skills.sort.updated'), value: 'updated' },
])
const currentSort = ref('downloads')
const searchQuery = ref('')
const searchTimeout = ref<any>(null)

onMounted(async () => {
    // Initial fetch
    await fetchSkills()
    // Ensure agents are loaded
    await agentsState.loadAgents()
})

const fetchSkills = async () => {
    if (searchQuery.value.trim()) {
        await skillsState.searchSkills(searchQuery.value.trim())
    } else {
        await skillsState.fetchPublicSkills({ sort: currentSort.value })
    }
}

const handleSortChange = async () => {
    // Clear search if sorting (or keep both? Convex query usually supports sort with filters, but search is a separate action)
    // The requirement says "search query" is a separate action "search:searchSkills".
    // If we sort, we are likely browsing the list.
    if (searchQuery.value) searchQuery.value = ''
    await fetchSkills()
}

const handleSearchInput = () => {
    if (searchTimeout.value) clearTimeout(searchTimeout.value)
    searchTimeout.value = setTimeout(async () => {
        await fetchSkills()
    }, 500)
}

const clearSearch = async () => {
    searchQuery.value = ''
    await fetchSkills()
}

// Install Modal
const showInstallModal = ref(false)
const selectedSkill = ref<any>(null)
const installTarget = ref<'global' | string>('global')
const agents = computed(() => agentsState.agentsList)

const readmeContent = computed(() => {
    return skillsState.skillMessages[selectedSkill.value?.skill?.latestVersionId] || ''
})
const loadingReadme = computed(() => {
    return skillsState.skillsBusyKey === selectedSkill.value?.skill?.latestVersionId
})

const parsedReadme = computed(() => {
    const raw = readmeContent.value
    if (!raw) return { frontmatter: null, content: '' }

    // Simple frontmatter parser
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
    if (match) {
        const frontmatterRaw = match[1]
        const content = match[2]

        const frontmatter: Record<string, string> = {}
        frontmatterRaw.split('\n').forEach(line => {
            const colonIndex = line.indexOf(':')
            if (colonIndex !== -1) {
                const key = line.slice(0, colonIndex).trim()
                const value = line.slice(colonIndex + 1).trim()
                if (key && value) {
                    frontmatter[key] = value
                }
            }
        })

        return { frontmatter, content }
    }
    return { frontmatter: null, content: raw }
})

const openInstallModal = async (skill: ConvexSkill) => {
    selectedSkill.value = skill
    installTarget.value = 'global'
    showInstallModal.value = true

    // Fetch installed status
    fetchAgentSkillsStatus()

    // Fetch Readme
    skillsState.getSkillReadme(skill.skill.latestVersionId)
}

const closeInstallModal = () => {
    showInstallModal.value = false
    selectedSkill.value = null
}

const confirmInstall = () => {
    if (!selectedSkill.value) return
    const targetAgentId = installTarget.value === 'global' ? undefined : installTarget.value
    handleInstall(selectedSkill.value, targetAgentId)
}

// Installation Status Logic
const installedGlobalSkills = ref<any[]>([])

const isGlobalInstalled = computed(() => {
    if (!selectedSkill.value) return false
    return installedGlobalSkills.value.some((s: any) =>
        (s.slug && s.slug === selectedSkill.value.skill.slug) ||
        (s.id && s.id === selectedSkill.value.skill._id) ||
        (s.name && s.name === selectedSkill.value.skill.slug)
    )
})

const agentInstalledSkills = ref<Record<string, Set<string>>>({})
const loadingAgentSkills = ref(false)

const fetchAgentSkillsStatus = async () => {
    loadingAgentSkills.value = true
    try {
        const [globalSkills, ...agentResults] = await Promise.all([
            skillsState.fetchGlobalSkills(),
            ...agents.value.map(async (agent) => {
                const skills = await skillsState.loadAgentSkills(agent.id)
                return { agentId: agent.id, skills }
            })
        ])
        installedGlobalSkills.value = globalSkills
        for (const { agentId, skills } of agentResults) {
            agentInstalledSkills.value[agentId] = new Set(skills.map((s: any) => s.slug || s.name))
        }
    } catch (err) {
        console.error('Failed to fetch agent skills status:', err)
    } finally {
        loadingAgentSkills.value = false
    }
}

const isAgentInstalled = (agentId: string) => {
    if (!selectedSkill.value || !agentInstalledSkills.value[agentId]) return false
    return agentInstalledSkills.value[agentId].has(selectedSkill.value.skill.slug) ||
        agentInstalledSkills.value[agentId].has(selectedSkill.value.skill.displayName)
}

const installingSkills = ref<Record<string, boolean>>({})

const handleInstall = async (skill: any, agentId?: string) => {


    const skillId = skill.skill._id
    installingSkills.value[skillId] = true
    try {
        // Use slug as the package name, fallback to displayName if needed (though slug should be present)
        const skillName = skill.skill.slug || skill.skill.displayName
        await skillsState.installSkill(skillName, agentId)

        const successMsg = agentId
            ? t('skills.installSuccessAgent', { name: skill.skill?.displayName, agent: agents.value.find(a => a.id === agentId)?.name || t('agent.title') })
            : t('skills.installSuccess', { name: skill.skill?.displayName })

        toast.success(successMsg)
    } catch (e: any) {
        toast.error(t('skills.installFailed', { error: e.message }))
    } finally {
        installingSkills.value[skillId] = false
        closeInstallModal()
    }
}
</script>

<template>
    <div class="h-full flex flex-col overflow-hidden bg-base-100">
        <ViewHeader :title="$t('skills.title')" wc-pad :is-main-page="true">
            <template #actions>

                <div class="flex gap-2">
                    <!-- Search -->
                    <div class="relative">
                        <input type="text" v-model="searchQuery" @input="handleSearchInput"
                            :placeholder="$t('skills.searchPlaceholder')"
                            class="input input-bordered input-sm w-48 pr-8" />
                        <button v-if="searchQuery" @click="clearSearch"
                            class="absolute right-2 top-1/2 -translate-y-1/2 text-base-content/50 hover:text-base-content">
                            <XMarkIcon class="w-4 h-4" />
                        </button>
                    </div>

                    <!-- Sort -->
                    <select v-model="currentSort" @change="handleSortChange" class="select select-bordered select-sm">
                        <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">
                            {{ opt.label }}
                        </option>
                    </select>
                </div>


            </template>
        </ViewHeader>

        <div class="flex-1 overflow-y-auto ">
            <div v-if="loading && !skills.length" class="flex justify-center p-8">
                <span class="loading loading-spinner loading-lg text-primary"></span>
            </div>

            <div v-else-if="!skills.length" class="text-center p-8 text-base-content/50">
                {{ $t('skills.empty') }}
            </div>

            <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-4">
                <div v-for="skill in skills" :key="skill.skill._id"
                    class="card bg-base-200 border border-base-300 shadow-sm hover:shadow-md transition-shadow">
                    <div class="card-body p-4">
                        <div class="flex justify-between items-start mb-2">
                            <div class="flex items-center gap-3 min-w-0 overflow-hidden">
                                <div
                                    class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                                    <CpuChipIcon class="w-6 h-6" />
                                </div>
                                <div class="overflow-hidden flex-1 min-w-0">
                                    <h3 class="font-bold text-base truncate block" :title="skill.skill.displayName">{{
                                        skill.skill.displayName }}</h3>
                                    <p class="text-xs text-base-content/60 font-mono truncate"
                                        :title="skill.skill.slug">{{
                                            skill.skill.slug }}</p>
                                </div>
                            </div>
                            <!-- <div class="badge badge-sm badge-ghost shrink-0">{{ skill.skill?.latestVersionId }}</div> -->
                        </div>

                        <p class="text-sm text-base-content/70 line-clamp-2 min-h-[2.5em] mb-4"
                            :title="skill.skill.summary">
                            {{ skill.skill.summary || $t('agent.noDescriptionFallback') }}
                        </p>

                        <div class="flex items-center justify-between mt-auto pt-2 border-t border-base-300">
                            <div class="flex gap-2 text-xs text-base-content/60">
                                <span class="flex items-center gap-1" title="Downloads">
                                    ⬇️ {{ skill.skill.stats?.downloads || 0 }}
                                </span>
                                <span class="flex items-center gap-1" title="Stars">
                                    ⭐ {{ skill.skill.stats?.stars || 0 }}
                                </span>
                            </div>

                            <button class="btn btn-sm btn-primary" :disabled="installingSkills[skill.skill._id]"
                                @click="openInstallModal(skill)">
                                <span v-if="installingSkills[skill.skill._id]"
                                    class="loading loading-spinner loading-xs"></span>
                                {{ $t('skills.install') }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Install Modal (DaisyUI) -->
        <dialog id="install_modal" class="modal" :class="{ 'modal-open': showInstallModal }">
            <div class="modal-box w-11/12 max-w-5xl h-[90vh] md:h-[80vh] flex flex-col p-0 overflow-hidden">
                <!-- Header -->
                <div class="flex justify-between items-center p-3 md:p-4 border-b border-base-300 bg-base-100 shrink-0">
                    <h3 class="font-bold text-base md:text-lg flex items-center gap-2 pr-8 max-w-[80%] min-w-0">
                        <CpuChipIcon class="w-5 h-5 md:w-6 md:h-6 text-primary shrink-0" />
                        <span class="truncate">{{ $t('skills.installTitle', { name: selectedSkill?.skill?.displayName })
                            }}</span>
                    </h3>
                    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2 z-10"
                        @click="closeInstallModal">✕</button>
                </div>

                <!-- Content -->
                <div class="flex-1 flex flex-col md:flex-row overflow-hidden">
                    <!-- Left: Readme (Top on mobile) -->
                    <div
                        class="flex-1 overflow-y-auto custom-scrollbar bg-base-200/50 p-4 md:p-6 order-2 md:order-1 min-h-0">
                        <div v-if="loadingReadme" class="flex justify-center p-12">
                            <span class="loading loading-spinner loading-lg text-primary"></span>
                        </div>
                        <div v-else-if="readmeContent">
                            <!-- Frontmatter Display -->
                            <div v-if="parsedReadme.frontmatter"
                                class="mb-6 p-4 bg-base-200 rounded-lg border border-base-300 text-sm">
                                <div v-if="parsedReadme.frontmatter.name" class="font-bold text-lg mb-1">
                                    {{ parsedReadme.frontmatter.name }}
                                </div>
                                <div v-if="parsedReadme.frontmatter.description" class="text-base-content/80 mb-2">
                                    {{ parsedReadme.frontmatter.description }}
                                </div>
                                <div v-if="parsedReadme.frontmatter.homepage" class="text-xs">
                                    <a :href="parsedReadme.frontmatter.homepage" target="_blank"
                                        class="link link-primary flex items-center gap-1">
                                        {{ parsedReadme.frontmatter.homepage }}
                                        <span class="text-xs">↗</span>
                                    </a>
                                </div>
                            </div>
                            <MarkdownRenderer :content="parsedReadme.content" />
                        </div>
                        <div v-else
                            class="h-full flex flex-col items-center justify-center text-base-content/50 opacity-60">
                            <DocumentTextIcon class="w-16 h-16 mb-4" />
                            <span class="text-lg">{{ $t('skills.noReadme') }}</span>
                        </div>
                    </div>

                    <!-- Right: Install Options (Bottom on mobile) -->
                    <div
                        class="w-full md:w-80 border-t md:border-t-0 md:border-l border-base-300 bg-base-100 flex flex-col order-1 md:order-2 shrink-0 max-h-[40vh] md:max-h-full">
                        <div class="p-3 md:p-4 border-b border-base-300 bg-base-50 shrink-0">
                            <h4 class="font-bold text-xs md:text-sm uppercase tracking-wider text-base-content/60 mb-1">
                                {{ $t('skills.installTo') }}
                            </h4>
                        </div>

                        <div class="flex-1 overflow-y-auto p-2 space-y-2">
                            <!-- Global Option -->
                            <label
                                class="label cursor-pointer justify-start w-full gap-3 p-3 border rounded-lg hover:bg-base-200 transition-colors"
                                :class="{ 'border-primary bg-primary/5 ring-1 ring-primary': installTarget === 'global' }">
                                <input type="radio" name="install-target" class="radio radio-primary radio-sm mt-0.5"
                                    value="global" v-model="installTarget" />
                                <div class="flex-1">
                                    <div class="flex items-center gap-2">
                                        <GlobeAltIcon class="w-4 h-4 text-base-content/70" />
                                        <span class="font-bold text-sm">{{ $t('skills.installGlobal') }}</span>
                                    </div>
                                    <div class="mt-0.5 flex items-center  gap-2">
                                        <span class="text-xs text-base-content/60">{{ $t('skills.installGlobalDesc')
                                            }}</span>
                                        <span v-if="isGlobalInstalled" class="badge badge-xs badge-success">
                                            <CheckIcon class="w-3 h-3 mr-1" />
                                            {{ $t('skills.installed') }}
                                        </span>
                                    </div>
                                </div>
                            </label>

                            <div v-if="agents.length > 0" class="divider text-xs my-2 font-mono opacity-50">{{
                                $t('common.or')
                                }}</div>

                            <!-- Agent Options -->
                            <div class="grid grid-cols-1 gap-1">
                                <label v-for="agent in agents" :key="agent.id"
                                    class="label cursor-pointer justify-start gap-2 p-2 border border-transparent hover:border-base-300 rounded-lg hover:bg-base-200 transition-all"
                                    :class="{ '!border-primary bg-primary/5 ring-1 ring-primary': installTarget === agent.id }">
                                    <input type="radio" name="install-target"
                                        class="radio radio-primary radio-xs mt-0.5" :value="agent.id"
                                        v-model="installTarget" />
                                    <div class="flex-1 min-w-0 flex items-center justify-between">
                                        <div class="flex items-center gap-2 min-w-0">
                                            <AgentAvatar :avatar="agent.avatar"
                                                :name="agent.name" size="xs" />
                                            <span class="font-medium text-sm truncate">{{ agent.name }}</span>
                                        </div>
                                        <div class="ml-2 shrink-0">
                                            <span v-if="loadingAgentSkills"
                                                class="loading loading-spinner loading-xs text-base-content/30"></span>
                                            <span v-else-if="isAgentInstalled(agent.id)"
                                                class="badge badge-xs badge-success gap-1">
                                                <CheckIcon class="w-3 h-3" />
                                                <span class="hidden sm:inline">{{ $t('skills.installed') }}</span>
                                            </span>
                                        </div>
                                    </div>
                                </label>
                            </div>
                        </div>

                        <!-- Footer Actions -->
                        <div class="p-3 md:p-4 border-t border-base-300 bg-base-50 shrink-0">
                            <div class="flex flex-col gap-3">
                                <button class="btn btn-primary btn-md w-full shadow-lg" @click="confirmInstall"
                                    :disabled="installingSkills[selectedSkill?.skill._id]">
                                    <span v-if="installingSkills[selectedSkill?.skill._id]"
                                        class="loading loading-spinner"></span>
                                    {{ $t('skills.confirmInstall') }}
                                </button>
                                <button class="btn btn-ghost btn-md w-full text-base-content/60 hover:text-base-content"
                                    @click="closeInstallModal">
                                    {{ $t('common.cancel') }}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop">
                <button @click="closeInstallModal">close</button>
            </form>
        </dialog>
    </div>
</template>
