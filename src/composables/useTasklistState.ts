// src/composables/useTasklistState.ts
// TasklistBar 的数据源：从当前会话消息流 computed 出会话工作步骤快照。
// 流式 toolResult 到达 → 自动更新；刷新/重连 → 从历史自动恢复，无需任何额外请求。
import { computed, ref, watch } from 'vue'
import {
    applySnapshotToMemory,
    extractTasklistSnapshotFromSources,
    unionSeen,
    type TasklistPanelMemory,
    type TasklistTask,
} from '../utils/tasklist-snapshot'
import { useChatState } from './useChatState'

const PANEL_PREFIX = 'tasklist-panel:'

function loadPanelMemory(sessionKey: string): TasklistPanelMemory {
    try {
        const raw = localStorage.getItem(PANEL_PREFIX + sessionKey)
        if (raw) {
            const parsed = JSON.parse(raw) as TasklistPanelMemory
            if (Array.isArray(parsed?.seen)) return { seen: parsed.seen, dismissed: !!parsed.dismissed }
        }
    } catch {
        /* 隐私模式等不可用场景：记忆退化为会话内内存态 */
    }
    return { seen: [], dismissed: false }
}

function savePanelMemory(sessionKey: string, mem: TasklistPanelMemory): void {
    try {
        localStorage.setItem(PANEL_PREFIX + sessionKey, JSON.stringify(mem))
    } catch {
        /* 同上，写入失败静默（关闭记忆退化为仅本次驻留有效） */
    }
}

// 模块级单例（与 useChatInput/useCommandState 同模式）：HomeView 的 /tasklist 客户端命令
// 与 TasklistBar 必须共享同一份 panelMem——若按实例各持一份，restore() 翻转的内存态
// 落不到 TasklistBar 正在渲染的那份上（localStorage 持久化救不了同驻留的两个实例）。
// snapshot/counts 本就同源于 chatState，单例化后 watch 也只注册一次。
function buildTasklistState() {
    const chatState = useChatState()

    // 扫描拼接序列：chatToolMessages 是回合内按时间序追加的新条目，
    // 排在已固化的 chatMessages 之后，last-write-wins 语义才正确，
    // 使面板能在流式 toolResult 到达时实时更新（而非只在回合结束 done 全量刷新）。
    const snapshot = computed(() =>
        extractTasklistSnapshotFromSources(chatState.chatMessages, chatState.chatToolMessages)
    )

    // 活步骤三态白名单：手编/旧版数据的枚举外 status 若只按「非 deleted」过滤，
    // 会计入 total 却不落入任何分组（计数与明细不一致、面板永远无法进入可关闭态）
    const tasks = computed<TasklistTask[]>(() =>
        (snapshot.value?.tasks ?? []).filter(
            (t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed',
        )
    )

    const counts = computed(() => ({
        done: tasks.value.filter((t) => t.status === 'completed').length,
        total: tasks.value.length,
        inProgress: tasks.value.filter((t) => t.status === 'in_progress').length,
        pending: tasks.value.filter((t) => t.status === 'pending').length,
    }))

    const inProgress = computed(() => tasks.value.find((t) => t.status === 'in_progress'))

    // 面板可见性状态机（TasklistPanelMemory）：消失只由 ✕ 或无步骤引起；
    // 重现只由「新活步骤创建」触发——完成/删除/改名/快照回退都不再影响可见性。
    //
    // 跨会话一致性：快照与所属会话键【同源求值】（元组 watch 在同一 job 内读两个 source），
    // 回调内的 key 与 snap 保证属于同一会话——保存/写入永远命中正确会话的键，
    // 不再依赖「sessionKey watcher 先于 snapshot watcher 执行」的创建顺序假设
    // （否则切换 flush 中旧会话的记忆会撞上新会话的快照，把记忆覆盖污染）。
    // memOwner 归属兜底：sessionKey watch 因快照 null→null 不变而未触发元组 watch 的
    // 窗口里由它负责重载；两者任意顺序到达，写入前都能保证归属一致。
    // /tasklist 命令的展开请求通道：restore() 自增，TasklistBar watch 后展开分组清单
    const expandRequest = ref(0)
    const panelMem = ref<TasklistPanelMemory>(loadPanelMemory(chatState.sessionKey))
    const memOwner = ref(chatState.sessionKey)
    watch(() => chatState.sessionKey, (key) => {
        memOwner.value = key
        panelMem.value = loadPanelMemory(key)
    })
    watch([snapshot, () => chatState.sessionKey], ([snap, key]) => {
        if (memOwner.value !== key) {
            // 归属不符：本 flush 内 sessionKey watch 尚未运行，同步重载后再应用
            memOwner.value = key
            panelMem.value = loadPanelMemory(key)
        }
        const next = applySnapshotToMemory(panelMem.value, snap)
        if (next !== panelMem.value) {
            panelMem.value = next
            savePanelMemory(key, next)
        }
    })

    const allDone = computed(() => counts.value.total > 0 && counts.value.done === counts.value.total)
    const visibleBar = computed(() => counts.value.total > 0 && !panelMem.value.dismissed)

    function dismiss(): void {
        // 把当前活步骤 id 固化进 seen：非 immediate 的 snapshot watch 在「快照稳定期挂载」
        // （如路由往返后 HomeView 重挂、sessionsMap 仍存活）下从未触发，seen 可能为空；
        // 若只翻转 dismissed，切走再切回的首次快照触发会把已关步骤误判为新步骤而复活面板
        const seen = unionSeen(panelMem.value.seen, tasks.value.map((t) => t.id))
        panelMem.value = { ...panelMem.value, seen, dismissed: true }
        savePanelMemory(chatState.sessionKey, panelMem.value)
    }

    // /tasklist 客户端命令（HomeView 拦截，不经服务端）：重现已关闭的面板。
    // 返回 false = 当前会话无活步骤（面板无处可显），调用方据此提示而非静默。
    // 活步骤存在时，applySnapshotToMemory 对「无新 id」快照返回原引用，
    // 不会把 dismissed 改回 true —— 重现后面板稳定可见。
    function restore(): boolean {
        if (counts.value.total === 0) return false
        panelMem.value = { ...panelMem.value, dismissed: false }
        savePanelMemory(chatState.sessionKey, panelMem.value)
        // 广播展开请求：面板已在显示时也自增，保证 /tasklist 永远有可见反馈
        // （展开分组清单的语义，而非仅撤销关闭）
        expandRequest.value++
        return true
    }

    return { snapshot, tasks, counts, inProgress, dismiss, restore, visibleBar, allDone, expandRequest }
}

const _tasklistState = buildTasklistState()

export function useTasklistState() {
    return _tasklistState
}
