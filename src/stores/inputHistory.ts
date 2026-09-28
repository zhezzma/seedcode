import { defineStore } from 'pinia'

export const INPUT_HISTORY_STORAGE_KEY = 'seedcode_input_history'
export const INPUT_DRAFTS_STORAGE_KEY = 'seedcode_input_drafts'
export const INPUT_DRAFT_ATTACHMENTS_STORAGE_KEY = 'seedcode_input_draft_attachments'
export const INPUT_HISTORY_MAX = 100
export const INPUT_DRAFT_MAX_LENGTH = 20000
/** 单会话附件草稿序列化长度上限：图片是 base64 dataUrl，超限跳过落盘（内存保留，切会话可恢复，仅刷新后丢） */
export const INPUT_DRAFT_ATTACHMENTS_MAX_LENGTH = 2 * 1024 * 1024
/** 附件草稿落盘总预算：防止多会话累计撑爆 localStorage 配额（超预算从最早写入的会话开始整会话淘汰，仅影响落盘） */
export const INPUT_DRAFT_ATTACHMENTS_TOTAL_MAX_LENGTH = 4 * 1024 * 1024

/** 序列化超限的 session key：内存保留但跳过落盘（persist 时排除），刷新后丢。模块级：随 store 生命周期，勿在加载路径写入 */
const unpersistableDraftAttachmentKeys = new Set<string>()
/** 旧版 /new 草稿哨兵：不分网关，本地/远程切换会窜台，已废弃（load 时剥离，不迁移——草稿是临时态） */
const LEGACY_NEW_SESSION_DRAFT_KEY = '__new_session__'
/** /new 新会话页没有 sessionKey，其输入草稿按激活网关条目落到哨兵 key：
 *  各条目是不同服务器的输入框，且切换账号时 switchGateway 会把路由改写到 /new
 *  再 reload，共用单值哨兵会让一台服务器上打的草稿在另一台上恢复出来。
 *  旧版的两个模式哨兵（__new_session_local__ / __new_session_remote__）同样废弃：
 *  local 条目 id 固定为 'local' 恰好兼容旧 local 哨兵，remote 条目 id 是随机 uuid。 */
const LEGACY_REMOTE_NEW_SESSION_DRAFT_KEY = '__new_session_remote__'

/** 按网关条目 id 取 /new 草稿哨兵 key（id 由调用方从激活条目取：store 不感知网关，避免循环依赖）。 */
export const newSessionDraftKeyFor = (gatewayId: string): string => `__new_session_${gatewayId}__`

export interface InputHistoryState {
    histories: Record<string, string[]>
    drafts: Record<string, string>
    draftAttachments: Record<string, PersistedDraftAttachment[]>
}

/** 持久化的附件草稿条目：id 是运行时标识，恢复时重新生成，不落盘 */
export interface PersistedDraftAttachment {
    name: string
    mimeType: string
    dataUrl: string
    content?: string
}

const getStorage = (): Storage | null => {
    if (typeof localStorage === 'undefined') return null
    return localStorage
}

const normalizeHistoryRecord = (value: unknown): Record<string, string[]> => {
    if (!value || typeof value !== 'object') return {}

    const normalized: Record<string, string[]> = {}
    for (const [sessionKey, entries] of Object.entries(value)) {
        if (!sessionKey || !Array.isArray(entries)) continue

        const cleaned = entries
            .filter((entry): entry is string => typeof entry === 'string')
            .map(entry => entry.trim())
            .filter(Boolean)
            .slice(-INPUT_HISTORY_MAX)

        if (cleaned.length > 0) {
            normalized[sessionKey] = cleaned
        }
    }

    return normalized
}

const normalizeDraftRecord = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== 'object') return {}

    const normalized: Record<string, string> = {}
    for (const [sessionKey, draft] of Object.entries(value)) {
        if (!sessionKey || typeof draft !== 'string') continue

        const truncated = draft.slice(0, INPUT_DRAFT_MAX_LENGTH)
        if (truncated) {
            normalized[sessionKey] = truncated
        }
    }

    return normalized
}

const normalizeDraftAttachmentsRecord = (value: unknown): Record<string, PersistedDraftAttachment[]> => {
    if (!value || typeof value !== 'object') return {}

    const normalized: Record<string, PersistedDraftAttachment[]> = {}
    for (const [sessionKey, list] of Object.entries(value)) {
        if (!sessionKey || !Array.isArray(list)) continue

        const cleaned = (list as unknown[])
            .filter((entry): entry is PersistedDraftAttachment =>
                !!entry && typeof entry === 'object'
                && typeof (entry as Record<string, unknown>).name === 'string'
                && typeof (entry as Record<string, unknown>).mimeType === 'string'
                && typeof (entry as Record<string, unknown>).dataUrl === 'string'
                && ((entry as Record<string, unknown>).content === undefined
                    || typeof (entry as Record<string, unknown>).content === 'string'))
            // 图片走 dataUrl，非图片文件走 content，两者必居其一
            .filter(entry => entry.dataUrl || entry.content)

        if (cleaned.length > 0) {
            normalized[sessionKey] = cleaned
        }
    }

    return normalized
}

const loadHistoryState = (): InputHistoryState['histories'] => {
    try {
        const storage = getStorage()
        const raw = storage?.getItem(INPUT_HISTORY_STORAGE_KEY)
        if (!raw) return {}
        return normalizeHistoryRecord(JSON.parse(raw))
    } catch (error) {
        console.error('Failed to load input history:', error)
        return {}
    }
}

/** loadDrafts 的可测形态：storage 显式注入（node:test 无法驱动 pinia store 初始化时序）。 */
export const loadDraftsForTest = (storage: Storage | null | undefined): Record<string, string> => {
    try {
        const raw = storage?.getItem(INPUT_DRAFTS_STORAGE_KEY)
        if (!raw) return {}
        const normalized = normalizeDraftRecord(JSON.parse(raw))
        // 废弃哨兵剥离：否则旧键残留在 record 里永远清不掉
        delete normalized[LEGACY_NEW_SESSION_DRAFT_KEY]
        delete normalized[LEGACY_REMOTE_NEW_SESSION_DRAFT_KEY]
        return normalized
    } catch (error) {
        console.error('Failed to load input drafts:', error)
        return {}
    }
}

const loadDrafts = (): Record<string, string> => loadDraftsForTest(getStorage())

/** loadDraftAttachments 的可测形态：storage 显式注入 */
export const loadDraftAttachmentsForTest = (storage: Storage | null | undefined): Record<string, PersistedDraftAttachment[]> => {
    try {
        const raw = storage?.getItem(INPUT_DRAFT_ATTACHMENTS_STORAGE_KEY)
        if (!raw) return {}
        return normalizeDraftAttachmentsRecord(JSON.parse(raw))
    } catch (error) {
        console.error('Failed to load input draft attachments:', error)
        return {}
    }
}

const loadDraftAttachments = (): Record<string, PersistedDraftAttachment[]> => loadDraftAttachmentsForTest(getStorage())

export const useInputHistoryStore = defineStore('input-history', {
    state: (): InputHistoryState => ({ histories: loadHistoryState(), drafts: loadDrafts(), draftAttachments: loadDraftAttachments() }),

    getters: {
        getHistory: (state) => (sessionKey: string): string[] => {
            if (!sessionKey) return []
            return state.histories[sessionKey] ?? []
        },

        getDraft: (state) => (sessionKey: string): string => {
            return state.drafts[sessionKey] ?? ''
        },

        getDraftAttachments: (state) => (sessionKey: string): PersistedDraftAttachment[] => {
            return state.draftAttachments[sessionKey] ?? []
        },
    },

    actions: {
        persist() {
            try {
                const storage = getStorage()
                if (!storage) return

                if (Object.keys(this.histories).length === 0) {
                    storage.removeItem(INPUT_HISTORY_STORAGE_KEY)
                } else {
                    storage.setItem(INPUT_HISTORY_STORAGE_KEY, JSON.stringify(this.histories))
                }

                if (Object.keys(this.drafts).length === 0) {
                    storage.removeItem(INPUT_DRAFTS_STORAGE_KEY)
                } else {
                    storage.setItem(INPUT_DRAFTS_STORAGE_KEY, JSON.stringify(this.drafts))
                }

                this.persistDraftAttachments(storage)
            } catch (error) {
                console.error('Failed to persist input history:', error)
            }
        },

        /** 附件草稿落盘：超限会话跳过；剩余条目超总预算时从最早写入的会话开始整会话淘汰（内存保留） */
        persistDraftAttachments(storage: Storage) {
            const persistable: Record<string, PersistedDraftAttachment[]> = {}
            for (const [k, v] of Object.entries(this.draftAttachments)) {
                if (!unpersistableDraftAttachmentKeys.has(k)) persistable[k] = v
            }
            let keys = Object.keys(persistable)
            while (keys.length > 0 && JSON.stringify(persistable).length > INPUT_DRAFT_ATTACHMENTS_TOTAL_MAX_LENGTH) {
                delete persistable[keys.shift() as string]
                keys = Object.keys(persistable)
            }

            if (keys.length === 0) {
                storage.removeItem(INPUT_DRAFT_ATTACHMENTS_STORAGE_KEY)
            } else {
                storage.setItem(INPUT_DRAFT_ATTACHMENTS_STORAGE_KEY, JSON.stringify(persistable))
            }
        },

        pushHistory(sessionKey: string, text: string) {
            const key = sessionKey.trim()
            const trimmed = text.trim()
            if (!key || !trimmed) return

            const history = [...(this.histories[key] ?? [])]
            // 去重：连续相同输入不重复写入
            if (history.length > 0 && history[history.length - 1] === trimmed) return

            history.push(trimmed)
            if (history.length > INPUT_HISTORY_MAX) {
                history.splice(0, history.length - INPUT_HISTORY_MAX)
            }

            this.histories[key] = history
            this.persist()
        },

        /** 记录 session 当前输入框内容（草稿）；空文本表示清除 */
        setDraft(sessionKey: string, text: string) {
            const key = sessionKey.trim()
            if (!key) return

            const value = text.slice(0, INPUT_DRAFT_MAX_LENGTH)
            if (!value) {
                if (key in this.drafts) {
                    delete this.drafts[key]
                    this.persist()
                }
                return
            }

            if (this.drafts[key] === value) return
            this.drafts[key] = value
            this.persist()
        },

        /** 记录 session 当前输入框附件（草稿）；空列表表示清除。
         *  id 是运行时标识不落盘；单会话序列化超限则跳过落盘，内存仍保留（切会话可恢复，仅刷新后丢）。 */
        setDraftAttachments(sessionKey: string, list: (PersistedDraftAttachment & { id?: string })[]) {
            const key = sessionKey.trim()
            if (!key) return

            const value = list
                .filter(a => !!a && typeof a.name === 'string' && typeof a.mimeType === 'string' && typeof a.dataUrl === 'string')
                .map(({ id: _id, name, mimeType, dataUrl, content }) =>
                    content === undefined ? { name, mimeType, dataUrl } : { name, mimeType, dataUrl, content })
                // 与加载侧 normalize 对齐：图片走 dataUrl、文件走 content，两者必居其一
                .filter(a => a.dataUrl || a.content)

            const serialized = JSON.stringify(value)

            if (value.length === 0) {
                unpersistableDraftAttachmentKeys.delete(key)
                if (key in this.draftAttachments) {
                    delete this.draftAttachments[key]
                    this.persist()
                }
                return
            }

            // 去重早退（含超限内存副本的重复写入）：不得触碰 unpersistable 标记
            if (JSON.stringify(this.draftAttachments[key] ?? []) === serialized) return

            if (serialized.length > INPUT_DRAFT_ATTACHMENTS_MAX_LENGTH) {
                // 超限：内存保留（切会话可从 store 恢复），仅跳过落盘（刷新后丢）；
                // 立即 persist 一次以排除残留的旧存储条目
                unpersistableDraftAttachmentKeys.add(key)
                this.draftAttachments[key] = value
                this.persist()
                return
            }

            unpersistableDraftAttachmentKeys.delete(key)
            this.draftAttachments[key] = value
            this.persist()
        },

        removeSessionHistory(sessionKey: string) {
            const key = sessionKey.trim()
            if (!key || (!(key in this.histories) && !(key in this.drafts) && !(key in this.draftAttachments))) return

            delete this.histories[key]
            // 会话已删除，其输入草稿与附件草稿一并清理
            delete this.drafts[key]
            delete this.draftAttachments[key]
            unpersistableDraftAttachmentKeys.delete(key)
            this.persist()
        },

        clearAll() {
            this.histories = {}
            this.drafts = {}
            this.draftAttachments = {}
            unpersistableDraftAttachmentKeys.clear()
            this.persist()
        },
    },
})
