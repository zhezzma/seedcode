<script setup lang="ts">
/**
 * 单个群的管理面（原 WorkspaceTabGroup 的唯一实现，从 AgentTeamGroups 拆出）：
 * 两处消费——AgentTeamGroups 列表形态的弹窗、群聊右栏的「群管理」tab 直渲染。
 *
 * 内容：
 * - 群头部：头像+群名+编辑钮（群信息弹窗：头像上传/名称/公告/无 @ 默认应答）
 * - 成员清单：查看各 bot 配置徽章（类型/模型/思考/记忆），管理动作：
 *   添加/编辑成员（弹窗内嵌 TeamMemberFields——与建群向导同一 view 同一
 *   字段面：名字/类型（编辑也开放互转）/引用或人格/记忆/高级五件套；
 *   编辑 key 原样回传保记忆连续）、设为群主（置首+responder 指向）、
 *   移除（服务端同步清 memory 登记）、记忆开关
 *
 * 契约：PATCH /groups/:sessionId 的 members 是全量替换数组；本组件每次动作
 * 都从最新 doc 投影 members 全量回传，key 一并回传（沿用原 key——编辑改名
 * 后记忆登记连续，服务端 normalizeMembers 优先用传入 key）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { TrashIcon, PlusIcon, StarIcon, ArrowPathIcon, PencilIcon, XMarkIcon, ChatBubbleLeftRightIcon, UsersIcon, ClipboardDocumentListIcon, PhotoIcon } from '@heroicons/vue/24/outline'

import { apiGet, apiPatch } from '../../composables/api-client'
import { useSessionsState, type TeamGroupMemberInput } from '../../composables/useSessionsState'
import { useChatState } from '../../composables/useChatState'
import { useToast } from '../../composables/useToast'
import TeamMemberFields, {
    newTeamMemberRow, teamMemberValid, memberDocToRow,
    type TeamMemberRow,
} from '../chat/TeamMemberFields.vue'
import AgentGroupTasks from './AgentGroupTasks.vue'

export interface MemberDoc {
    key: string
    name: string
    memory: boolean
    source: {
        type: 'agent' | 'inline'
        agentId?: string
        systemPrompt?: string
        provider?: string
        model?: string
        thinkingLevel?: string
        disabledTools?: string[]
        skills?: { type: string, disabledSkills?: string[] }
        extensions?: string[]
    }
}

interface GroupDoc {
    shellSessionId: string
    name: string
    /** 群头像（dataURL；undefined/null=无头像——服务端存群 doc，详情透传） */
    icon?: string | null
    bulletin: string
    members: MemberDoc[]
    defaultResponder: { kind: string, memberKey?: string }
}

const props = defineProps<{
    /** 群壳 sessionId */
    sessionId: string
}>()

const { t } = useI18n()
const toast = useToast()
const sessionsState = useSessionsState()
const chatState = useChatState()

const loading = ref(false)
const saving = ref(false)
const doc = ref<GroupDoc | null>(null)
const bulletinDraft = ref('')
const nameDraft = ref('')
// 群信息弹窗（原成员 tab 群信息分区迁入）：三草稿同款模式（弹窗内编辑、保存落库；
// iconDraft null=清除头像）
const showInfo = ref(false)
const iconDraft = ref<string | null>(null)
const iconFileInput = ref<HTMLInputElement | null>(null)
const showAdd = ref(false)
// 成员表单（弹窗）：添加与编辑共用一套，内嵌 TeamMemberFields（与建群向导
// 同一 view 同一字段面；编辑全字段可改，key 原样回传保记忆连续）
const memberForm = ref<TeamMemberRow>(newTeamMemberRow())
const memberFormKey = ref('')
const memberFormMode = ref<'add' | 'edit'>('add')
/** TeamMemberFields 实例（提交投影 projectSource 用） */
const memberFieldsRef = ref<InstanceType<typeof TeamMemberFields> | null>(null)

const ownerKey = computed(() => doc.value?.members[0]?.key)

// ── Tab 结构（AgentDetail 同构胶囊 tab：任务第一 tab + 成员第二 tab；
// 容器查询自适应图标/文字，样式照抄不另设）──
const activeTab = ref('tasks')
const tabs = computed(() => [
    { id: 'tasks', label: t('sidebar.groupTasksTab'), icon: ClipboardDocumentListIcon },
    { id: 'members', label: t('sidebar.groupMembersSection'), icon: UsersIcon },
])

const responderValue = computed({
    get() {
        // member 模式（含群主）统一映射到下拉枚举；other member 选中=member 模式
        const responder = doc.value?.defaultResponder
        if (!responder) return 'member'
        if (responder.kind === 'member') return ownerKey.value === responder.memberKey ? 'owner' : 'member'
        return responder.kind
    },
    set(value: string) {
        // keepDrafts：切默认应答不动群信息弹窗里未保存的草稿（name/bulletin/icon
        // 与本字段无关；回读重置会把用户正编到一半的内容抹回库值）
        patchGroup({ defaultResponder: value === 'owner'
            ? { kind: 'member', memberKey: ownerKey.value ?? '' }
            : { kind: value } }, { keepDrafts: true })
    },
})

const load = async (opts?: { keepDrafts?: boolean }) => {
    if (!props.sessionId) return
    // 代际防护：切群触发的 B 载与 A 在途载并发时，A 晚到响应不得回填
    //（sessionId 已换，doc/名册会错群，评审 C-I3）
    const sid = props.sessionId
    loading.value = true
    try {
        const result = await apiGet<GroupDoc>(`/api/extensions/team-chat/groups/${encodeURIComponent(sid)}`)
        if (props.sessionId !== sid) return
        doc.value = result
        // keepDrafts=true：仅回读兑正服务端真相，不覆写未保存的草稿（切应答/
        // 改成员等不碰草稿字段的 patch 后回读）；首载/切群/保存基本信息后仍全量重置
        if (!opts?.keepDrafts) {
            bulletinDraft.value = result.bulletin ?? ''
            nameDraft.value = result.name ?? ''
            iconDraft.value = result.icon ?? null
        }
    } catch (error) {
        toast.error((error as Error)?.message || t('sidebar.groupLoadError'))
    } finally {
        loading.value = false
    }
}

onMounted(load)

// 切群（列表弹窗连续换群/右栏群会话切换）：重载 + tab 回任务页
watch(() => props.sessionId, () => {
    doc.value = null
    activeTab.value = 'tasks'
    load()
})

/** 全量 members 回传（MemberDoc → GroupMemberInput；key 一并回传——编辑
 *  场景沿用原 key 保记忆连续（改名不换记忆登记），服务端 normalizeMembers
 *  优先用传入 key）；未编辑成员原样保留 key */
const membersInput = (list: MemberDoc[]): TeamGroupMemberInput[] =>
    list.map(m => ({ key: m.key, name: m.name, source: m.source as TeamGroupMemberInput['source'], memory: m.memory }))

const patchGroup = async (body: Record<string, unknown>, opts?: { keepDrafts?: boolean }): Promise<boolean> => {
    if (!doc.value) return false
    if (saving.value) {
        // 守卫不再静默（此前静默 return 会让 saveBasics 无反馈关弹窗像已保存）
        toast.error(t('sidebar.groupSaveBusy'))
        return false
    }
    saving.value = true
    try {
        await apiPatch(`/api/extensions/team-chat/groups/${encodeURIComponent(props.sessionId)}`, body)
        // 详情回读与侧栏/群列表同步无依赖，并行（toggleMemory 连点体感）
        await Promise.all([load(opts), sessionsState.loadSessions()])
        // 群管理面 PATCH 成员/应答后，已打开的本群聊天视图名册与 queue 投影同步
        // 刷新（名册到达线=开群/回合边界，管理面变更不在其中——不刷则 @ 补全
        // 名单陈旧至下回合边界）
        chatState.refreshGroupTurnState(props.sessionId)
        return true
    } catch (error) {
        toast.error((error as Error)?.message || String(error))
        return false
    } finally {
        saving.value = false
    }
}

const saveBasics = async () => {
    if (!doc.value) return
    // icon 草稿随保存落库（null=清除；string=canvas 压缩后的 dataURL）；仅在
    // 保存成功（含 saving 守卫未命中）时关弹窗——守卫静默跳过时关弹窗会让
    // 用户误以为已保存
    const ok = await patchGroup({ name: nameDraft.value.trim() || doc.value.name, bulletin: bulletinDraft.value, icon: iconDraft.value })
    if (ok) showInfo.value = false
}

const triggerIconPick = () => {
    iconFileInput.value?.click()
}

/** 头像选择：FileReader → canvas 压缩（最长边 256px、jpeg 0.85）→ dataURL 入
 *  草稿（交互先例=AgentFormModal 的 FileReader+预览；压缩保证 dataURL 稳落
 *  服务端 700k 上限内）。选同一文件重选也能再触发：读后置空 input */
const handleIconFileChange = (event: Event) => {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    // 无论成败都复位 input（失败重选同一文件也得触发 change）
    input.value = ''
    const fail = () => toast.error(t('sidebar.groupIconReadFailed'))
    const reader = new FileReader()
    reader.onerror = () => fail()
    reader.onload = (e) => {
        const img = new Image()
        img.onerror = () => fail()
        img.onload = () => {
            const scale = Math.min(1, 256 / Math.max(img.width, img.height))
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.round(img.width * scale))
            canvas.height = Math.max(1, Math.round(img.height * scale))
            const ctx = canvas.getContext('2d')
            if (!ctx) return fail()
            // 铺白底：PNG 透明区域直接压 JPEG 会变黑（无 alpha 通道填 0）
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
            iconDraft.value = canvas.toDataURL('image/jpeg', 0.85)
        }
        img.src = e.target?.result as string
    }
    reader.readAsDataURL(file)
}

/** 设为群主：置首 + 默认应答指向（普通对话里无 @ 群主应答） */
const makeOwner = (member: MemberDoc) => {
    if (!doc.value || member.key === ownerKey.value) return
    const rest = doc.value.members.filter(m => m.key !== member.key)
    const next = [member, ...rest]
    patchGroup({ members: membersInput(next), defaultResponder: { kind: 'member', memberKey: member.key } }, { keepDrafts: true })
}

const removeMember = (member: MemberDoc) => {
    if (!doc.value || doc.value.members.length <= 1) return
    const next = doc.value.members.filter(m => m.key !== member.key)
    // 移除的是群主（服务端会把 members[0] 升为新群主）：默认应答同步指向新群主
    // ——否则 responder.memberKey 悬空，下拉渲染空白选项（v7.4.3 评审 C-I4）
    const responder = doc.value.defaultResponder
    const responderRemoved = member.key === ownerKey.value
        || (responder?.kind === 'member' && responder.memberKey === member.key)
    patchGroup(responderRemoved
        ? {
            members: membersInput(next),
            defaultResponder: { kind: 'member', memberKey: next[0].key },
        }
        : { members: membersInput(next) }, { keepDrafts: true })
}

const toggleMemory = (member: MemberDoc) => {
    if (!doc.value) return
    patchGroup({ members: membersInput(doc.value.members.map(m => m.key === member.key ? { ...m, memory: !m.memory } : m)) }, { keepDrafts: true })
}

// ── 成员表单弹窗（添加/编辑共用一套：内嵌 TeamMemberFields，编辑全字段可改）──
const formOpen = computed(() => memberFormMode.value === 'edit' ? memberFormKey.value !== '' : showAdd.value)
const formTitle = computed(() => memberFormMode.value === 'edit' ? t('sidebar.groupEditMember') : t('sidebar.groupAddMember'))
const formValid = computed(() => teamMemberValid(memberForm.value))

const openAdd = () => {
    memberForm.value = newTeamMemberRow()
    memberFormKey.value = ''
    memberFormMode.value = 'add'
    showAdd.value = true
}

const openEdit = (member: MemberDoc) => {
    memberForm.value = memberDocToRow(member)
    memberFormKey.value = member.key
    memberFormMode.value = 'edit'
}

const closeForm = () => {
    showAdd.value = false
    memberFormKey.value = ''
    memberFormMode.value = 'add'
}

const submitForm = async () => {
    if (!doc.value || !formValid.value) return
    const f = memberForm.value
    // 兜底按类型分派（v7.4.3 评审 M4）：ref 缺席（理论不可达）时 agent 型降级
    // inline 会静默丢引用与全部高级配置——同型兜底只丢名字之外的默认值
    const source = memberFieldsRef.value?.projectSource()
        ?? (f.type === 'agent'
            ? { type: 'agent' as const, agentId: f.agentId }
            : { type: 'inline' as const, systemPrompt: f.systemPrompt })
    if (memberFormMode.value === 'add') {
        // 新成员 key 传空串（缺省语义）：服务端按身份重算（inline=name 哈希）
        const next = [...doc.value.members, { key: '', name: f.name.trim(), memory: f.memory, source }]
        // 失败保持表单打开（saveBasics 同款）：失败关表单=丢用户填的人格/五件套
        await patchGroup({ members: membersInput(next) }, { keepDrafts: true }) || closeForm()
    } else {
        // 编辑：key 原样回传——改名后 key 稳定 → memory 登记连续（服务端
        // normalizeMembers 沿用传入 key）；新配置经 turn-task 复用会话全量回刷
        // configure 生效（模型/思考/人格即时生效，无需移除重加）；换类型/换引用
        // 同样原 key 沿用（source 变了但身份链不变）
        const next = doc.value.members.map(m => m.key === memberFormKey.value
            ? { ...m, name: f.name.trim(), memory: f.memory, source }
            : m)
        await patchGroup({ members: membersInput(next) }, { keepDrafts: true }) || closeForm()
    }
}

</script>

<template>
    <div class="space-y-6">
        <p v-if="loading && !doc" class="text-center py-8 opacity-50">{{ t('common.loading') }}</p>

        <template v-else-if="doc">
            <!-- ── 群头部：圆形头像 + 群名 + 编辑钮（点开群信息弹窗）；无 icon 用
                 群聊气泡兑底，列表格子仍用默认图标（用户未要求列表显头像） ── -->
            <div class="flex flex-col items-center gap-1.5">
                <div class="relative">
                    <div class="w-16 h-16 rounded-full overflow-hidden bg-base-300 text-primary flex items-center justify-center shadow-sm">
                        <img v-if="doc.icon" :src="doc.icon" class="w-full h-full object-cover" :alt="doc.name" />
                        <ChatBubbleLeftRightIcon v-else class="w-8 h-8" />
                    </div>
                    <button class="btn btn-circle btn-xs absolute -bottom-1 -right-1 shadow-sm"
                        :title="t('sidebar.groupEditInfo')" @click="showInfo = true">
                        <PencilIcon class="w-3 h-3" />
                    </button>
                </div>
                <h3 class="font-bold text-lg text-center break-all max-w-full">{{ doc.name }}</h3>
            </div>

            <!-- Tab 条（AgentDetail 同构胶囊 tab：容器查询自适应，样式照抄） -->
            <div class="flex justify-center w-full @container">
                <div role="tablist"
                    class="bg-base-300 p-1 rounded-full flex relative shadow-inner w-[90%] @2xl:w-[60%] gap-1">
                    <a role="tab" v-for="tab in tabs" :key="tab.id" :aria-label="tab.label"
                        @click="activeTab = tab.id"
                        class="flex-1 min-w-0 flex items-center justify-center gap-1.5 py-2 rounded-full text-sm font-semibold transition-all duration-300 ease-out cursor-pointer select-none"
                        :class="activeTab === tab.id ? 'bg-base-100 text-base-content shadow-sm scale-100' : 'text-base-content/55 hover:text-base-content'">
                        <component :is="tab.icon" class="h-4 w-4 shrink-0" />
                        <span class="hidden @sm:block truncate">{{ tab.label }}</span>
                    </a>
                </div>
            </div>

            <!-- 任务 tab：在飞 + 历史全量代理任务，点击看执行过程（轨迹抽屉复用）。
                 :key=sessionId——切群时彻底重建（同 tab 不变也重载，防 A 群列表
                 配 B 群名册，评审 C-I3） -->
            <AgentGroupTasks v-if="activeTab === 'tasks'" :key="sessionId" :session-id="sessionId"
                :members="doc.members.map(m => ({ key: m.key, name: m.name }))" />

            <!-- 成员 tab：成员清单（原群信息分区已迁 header 编辑弹窗） -->
            <template v-if="activeTab === 'members'">
            <!-- ── 成员清单（同款分区；成员卡同 CronView 任务卡形态）── -->
            <section class="space-y-3">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <UsersIcon class="w-5 h-5 text-primary" />
                        <h3 class="text-sm font-bold">{{ t('sidebar.groupMembersSection') }}</h3>
                        <div class="badge badge-sm font-mono badge-primary">{{ doc.members.length }}</div>
                    </div>
                    <div class="flex items-center gap-1">
                        <button class="btn btn-ghost btn-xs btn-square" :disabled="loading" :title="t('common.refresh')"
                            @click="load({ keepDrafts: true })">
                            <ArrowPathIcon class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
                        </button>
                        <button class="btn btn-primary btn-xs gap-1" @click="openAdd">
                            <PlusIcon class="w-3.5 h-3.5" />
                            {{ t('sidebar.groupAddMember') }}
                        </button>
                    </div>
                </div>

                <!-- 成员表单弹窗：添加/编辑共用（内嵌 TeamMemberFields——与建群向导
                     同一 view 同一字段面；编辑全字段可改，含类型互转） -->
                <Teleport to="body">
                    <dialog v-if="formOpen" class="modal modal-open z-[210]">
                        <button class="modal-backdrop" type="button" :aria-label="t('sidebar.cancel')" @click="closeForm"></button>
                        <div class="modal-box max-w-lg bg-base-100 w-full p-4">
                            <div class="flex justify-between items-center mb-4">
                                <h3 class="font-bold text-lg">{{ formTitle }}</h3>
                                <button class="btn btn-sm btn-circle btn-ghost" :aria-label="t('sidebar.cancel')" @click="closeForm">
                                    <XMarkIcon class="w-5 h-5" />
                                </button>
                            </div>
                            <TeamMemberFields ref="memberFieldsRef" :member="memberForm" />
                            <div class="modal-action mt-4">
                                <button class="btn btn-ghost" @click="closeForm">{{ t('sidebar.cancel') }}</button>
                                <button class="btn btn-primary" :disabled="!formValid || saving" @click="submitForm">
                                    {{ memberFormMode === 'edit' ? t('common.save') : t('common.add') }}
                                </button>
                            </div>
                        </div>
                    </dialog>
                </Teleport>

                <div v-for="member in doc.members" :key="member.key"
                    class="card bg-base-200 border border-base-300 shadow-sm">
                    <div class="card-body p-3 sm:p-4">
                        <div class="flex items-center justify-between gap-2">
                            <div class="flex items-center gap-2 min-w-0">
                                <div class="w-2 h-2 rounded-full shrink-0"
                                    :class="member.key === ownerKey ? 'bg-primary' : 'bg-base-content/30'"></div>
                                <h4 class="font-bold text-sm truncate">{{ member.name }}</h4>
                            </div>
                            <div class="flex items-center gap-1 shrink-0">
                                <div v-if="member.key === ownerKey" class="badge badge-primary badge-xs">{{ t('sidebar.groupOwnerBadge') }}</div>
                                <div class="badge badge-ghost badge-xs font-mono">{{ member.source.type === 'agent' ? (member.source.agentId ?? 'agent') : t('sidebar.groupInlineBadge') }}</div>
                                <div v-if="member.source.provider && member.source.model" class="badge badge-outline badge-xs font-mono">
                                    {{ member.source.model }}
                                </div>
                                <div v-if="member.source.thinkingLevel" class="badge badge-outline badge-xs">
                                    {{ t(`chat.thinkingLevels.${member.source.thinkingLevel}`) }}
                                </div>
                            </div>
                        </div>
                        <p v-if="member.source.type === 'inline'" class="text-xs opacity-60 line-clamp-2">
                            {{ member.source.systemPrompt }}
                        </p>
                        <div class="flex items-center justify-between pt-2 border-t border-base-300">
                            <label class="label cursor-pointer gap-1.5 text-xs py-0">
                                <span class="label-text">{{ t('sidebar.memoryToggle') }}</span>
                                <input type="checkbox" class="toggle toggle-xs toggle-primary" :checked="member.memory"
                                    :disabled="saving" @change="toggleMemory(member)" />
                            </label>
                            <div class="flex items-center gap-1">
                                <button class="btn btn-ghost btn-xs gap-1" :disabled="saving" @click="openEdit(member)">
                                    <PencilIcon class="w-3.5 h-3.5" />
                                    {{ t('common.edit') }}
                                </button>
                                <button v-if="member.key !== ownerKey" class="btn btn-ghost btn-xs gap-1"
                                    :disabled="saving" @click="makeOwner(member)">
                                    <StarIcon class="w-3.5 h-3.5" />
                                    {{ t('sidebar.groupOwnerBadge') }}
                                </button>
                                <button class="btn btn-ghost btn-xs btn-square text-error/50 hover:text-error"
                                    :disabled="saving || doc.members.length <= 1" :title="t('sidebar.groupRemoveMember')"
                                    @click="removeMember(member)">
                                    <TrashIcon class="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
            </template>

            <!-- ── 群信息弹窗（header 编辑钮打开；原成员 tab 群信息分区迁入）：
                 头像上传（隐藏 file input + 预览圆图 + 移除钮，交互照 AgentFormModal
                 先例）+ 群名/公告草稿 + 默认应答（即时 patch 模式沿现状）+ 保存钮 ── -->
            <Teleport to="body">
                <dialog v-if="showInfo" class="modal modal-open z-[210]">
                    <button class="modal-backdrop" type="button" :aria-label="t('sidebar.cancel')" @click="showInfo = false"></button>
                    <div class="modal-box max-w-lg bg-base-100 w-full p-4">
                        <div class="flex justify-between items-center mb-4">
                            <h3 class="font-bold text-lg">{{ t('sidebar.groupEditInfo') }}</h3>
                            <button class="btn btn-sm btn-circle btn-ghost" :aria-label="t('sidebar.cancel')" @click="showInfo = false">
                                <XMarkIcon class="w-5 h-5" />
                            </button>
                        </div>

                        <!-- 头像上传：预览圆图 + 悬浮遮罩 + 移除钮 -->
                        <div class="flex flex-col items-center gap-2 mb-4">
                            <div class="relative group cursor-pointer shrink-0" @click="triggerIconPick">
                                <div class="w-20 h-20 rounded-full overflow-hidden bg-base-300 text-primary shadow-inner flex items-center justify-center">
                                    <img v-if="iconDraft" :src="iconDraft" class="w-full h-full object-cover" />
                                    <ChatBubbleLeftRightIcon v-else class="w-10 h-10" />
                                </div>
                                <div class="absolute inset-0 bg-black/40 rounded-full opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition-opacity duration-300 text-white gap-1">
                                    <PhotoIcon class="w-6 h-6" />
                                    <span class="text-[10px] font-bold uppercase tracking-wider">{{ t('sidebar.groupIconUpload') }}</span>
                                </div>
                                <input ref="iconFileInput" type="file" accept="image/*" class="hidden"
                                    @change="handleIconFileChange" />
                            </div>
                            <button v-if="iconDraft" class="btn btn-ghost btn-xs gap-1" @click="iconDraft = null">
                                <XMarkIcon class="w-3.5 h-3.5" />
                                {{ t('sidebar.groupIconRemove') }}
                            </button>
                        </div>

                        <div class="form-control w-full">
                            <label class="label py-1"><span class="label-text font-medium">{{ t('sidebar.groupName') }}</span></label>
                            <input v-model="nameDraft" class="input input-bordered input-sm w-full"
                                :placeholder="t('sidebar.groupName')" />
                        </div>
                        <div class="form-control w-full">
                            <label class="label py-1"><span class="label-text font-medium">{{ t('sidebar.groupBulletin') }}</span></label>
                            <textarea v-model="bulletinDraft" class="textarea textarea-bordered textarea-sm w-full" rows="2"
                                :placeholder="t('sidebar.groupBulletinHint')" />
                        </div>
                        <div class="form-control w-full">
                            <label class="label py-1"><span class="label-text font-medium">{{ t('sidebar.groupDefaultResponder') }}</span></label>
                            <select v-model="responderValue" class="select select-bordered select-sm w-full" :disabled="saving">
                                <option value="owner">{{ t('sidebar.responderMember') }}</option>
                                <option value="everyone">{{ t('sidebar.responderEveryone') }}</option>
                                <option value="mentions">{{ t('sidebar.responderMentions') }}</option>
                                <option value="auto">{{ t('sidebar.responderAuto') }}</option>
                            </select>
                        </div>
                        <div class="modal-action mt-4">
                            <button class="btn btn-ghost" @click="showInfo = false">{{ t('sidebar.cancel') }}</button>
                            <button class="btn btn-primary" :disabled="saving" @click="saveBasics">
                                {{ t('common.save') }}
                            </button>
                        </div>
                    </div>
                </dialog>
            </Teleport>
        </template>
    </div>
</template>
