/** 树根哨兵键：root 级消息（parentId 为 null/undefined，root 重试/编辑产生）在
 * childrenMap/allChildrenMap 中归入空串组；查询侧 null/undefined/'' 归一到此键。
 * 既有「合成 root entry」形状（消息 parentId 指向 type:'root' 条目）不受影响——
 * 那种消息的 parentId 是真实 id，仍按原键分组。 */
const ROOT_PARENT_KEY = ''

export interface BranchInfo {
    siblings: string[]
    currentIndex: number
}

export interface BranchMessageLike {
    role: 'user' | 'assistant'
    entryId?: string
    parentEntryId?: string | null
}

export interface SessionTreeEntry {
    id: string
    parentId: string | null
    type: string
    message?: {
        role?: string
        deleted?: boolean
        isDeleted?: boolean
        hidden?: boolean
        visible?: boolean
        deletedAt?: string | number | null
        removedAt?: string | number | null
        [key: string]: any
    } | null
    deleted?: boolean
    isDeleted?: boolean
    hidden?: boolean
    visible?: boolean
    [key: string]: any
}

export interface BranchIndexes {
    childrenMap: Map<string, string[]>
    allChildrenMap: Map<string, string[]>
    entryMap: Map<string, SessionTreeEntry>
}

const isDeletedEntry = (entry: SessionTreeEntry | null | undefined): boolean => {
    if (!entry) return true
    if (entry.deleted || entry.isDeleted || entry.hidden === true || entry.visible === false) {
        return true
    }

    const message = entry.message
    if (!message) return false

    return Boolean(
        message.deleted ||
        message.isDeleted ||
        message.hidden === true ||
        message.visible === false ||
        message.deletedAt ||
        message.removedAt,
    )
}

const getOrderedChildren = (parentId: string, indexes: BranchIndexes): string[] => {
    const childIds = indexes.allChildrenMap.get(parentId) ?? []
    if (childIds.length <= 1) return childIds

    const liveChildren: string[] = []
    const deletedChildren: string[] = []

    for (const childId of childIds) {
        if (isDeletedEntry(indexes.entryMap.get(childId))) {
            deletedChildren.push(childId)
        } else {
            liveChildren.push(childId)
        }
    }

    return liveChildren.length > 0 ? [...liveChildren, ...deletedChildren] : childIds
}

const findFirstDescendantMessageId = (startId: string, indexes: BranchIndexes): string | null => {
    for (const childId of getOrderedChildren(startId, indexes)) {
        const entry = indexes.entryMap.get(childId)
        if (!entry || isDeletedEntry(entry)) {
            continue
        }

        if (entry.type === 'message') {
            return childId
        }

        const descendant = findFirstDescendantMessageId(childId, indexes)
        if (descendant) {
            return descendant
        }
    }

    return null
}

const pickNextChild = (parentId: string, indexes: BranchIndexes): string | null => {
    const childIds = getOrderedChildren(parentId, indexes)
    if (childIds.length === 0) return null

    let fallback: string | null = null

    for (const childId of childIds) {
        const entry = indexes.entryMap.get(childId)
        if (!entry) continue

        if (!fallback && !isDeletedEntry(entry)) {
            fallback = childId
        }

        if (isDeletedEntry(entry)) {
            continue
        }

        if (entry.type === 'message') {
            return childId
        }

        if (findFirstDescendantMessageId(childId, indexes)) {
            return childId
        }
    }

    return fallback ?? childIds[0] ?? null
}

const findNearestMessageAncestor = (entryId: string | null | undefined, indexes: BranchIndexes): SessionTreeEntry | null => {
    let current = entryId ? indexes.entryMap.get(entryId) ?? null : null

    while (current && current.type !== 'message' && current.parentId) {
        current = indexes.entryMap.get(current.parentId) ?? null
    }

    return current?.type === 'message' ? current : null
}

/** 同一父键下的活跃消息兄弟。
 *
 * 跨 role 归一是设计行为（产品确认）：user 分叉点下「原回复 assistant」与
 * 「重新发问 user」互为分支（切到裸 user 分支重新发问 = 严格停点 fork 的正常形态），
 * user/assistant 两侧导航都能互切。历史代码此处曾按 entry.message?.role 过滤——
 * 但 durable /entries 的条目 role 是顶层字段（无 message 包装），过滤从未生效，
 * 恰好保住了 fork-at-user 形态的导航；显式移除过滤以免「修好」它反而全灭导航
 *（复现验证见 chat-branch-navigation.test.ts 的 fork-at-user 用例）。 */
const getLiveMessageSiblings = (parentId: string | null | undefined, indexes: BranchIndexes): string[] => {
    return (indexes.childrenMap.get(parentId || ROOT_PARENT_KEY) ?? []).filter(id => {
        const entry = indexes.entryMap.get(id)
        return !!entry && entry.type === 'message' && !isDeletedEntry(entry)
    })
}

export const buildBranchIndexes = (tree: SessionTreeEntry[] | null | undefined): BranchIndexes => {
    const childrenMap = new Map<string, string[]>()
    const allChildrenMap = new Map<string, string[]>()
    const entryMap = new Map<string, SessionTreeEntry>()

    for (const entry of tree ?? []) {
        entryMap.set(entry.id, entry)
        const parentKey = entry.parentId || ROOT_PARENT_KEY

        const allChildren = allChildrenMap.get(parentKey)
        if (allChildren) allChildren.push(entry.id)
        else allChildrenMap.set(parentKey, [entry.id])

        if (entry.type === 'message') {
            const children = childrenMap.get(parentKey)
            if (children) children.push(entry.id)
            else childrenMap.set(parentKey, [entry.id])
        }
    }

    return {
        childrenMap,
        allChildrenMap,
        entryMap,
    }
}

/**
 * startId 子树的「停靠叶子」：子树内 id 最大（最新写入）的条目。
 *
 * 曾按 pickNextChild 首-子路径下钻——子树存在多个子分支时落到「第一条路
 * 径的底」（通常是旧主链尾巴），切回分支看到的不是该分支最新状态。id 在
 * durable 全局单调递增，最大 id = 该分支最近活跃的位置；且其祖先链必经
 * startId，导航到它后 startId 仍可见。
 */
export const findLeafId = (startId: string, indexes: BranchIndexes): string => {
    // 数字 id（durable 投影）：子树内 id 最大（最新写入）的条目——子树存在多个
    // 子分支时，首-子路径下钻会落到旧主链尾巴而非该分支最新状态。
    if (Number.isFinite(Number(startId))) {
        const queue = [startId]
        let leafId = startId
        let leafNum = Number(startId)

        while (queue.length > 0) {
            const current = queue.shift()!
            for (const childId of indexes.allChildrenMap.get(current) ?? []) {
                queue.push(childId)
                const childNum = Number(childId)
                if (Number.isFinite(childNum) && childNum > leafNum) {
                    leafNum = childNum
                    leafId = childId
                }
            }
        }
        return leafId
    }

    // 非数字 id（旧 v4 形状 / 测试 fixture）：按首-子路径下钻
    let leafId = startId
    while (true) {
        const nextId = pickNextChild(leafId, indexes)
        if (!nextId) return leafId
        leafId = nextId
    }
}

/** 可切换兄弟分支：自己恒可停靠（死分支的逃逸锚点：从死分支仍可切回活分支）；
 * 其它兄弟「有活跃消息后代」或「完全无后代」时可切换——无后代的裸 user 是合法
 * 停靠点（严格停点 fork / 分支导航停在 user 消息的正常态，切过去即可重新发问）；
 * 仅「有后代但全部被删/死（回复删光）」不占计数、不从活分支跳入。 */
const isSwitchableSibling = (selfId: string, id: string, indexes: BranchIndexes): boolean => {
    if (id === selfId) return true
    if (findFirstDescendantMessageId(id, indexes) !== null) return true
    return (indexes.allChildrenMap.get(id) ?? []).length === 0
}

export const getBranchInfo = (msg: BranchMessageLike, indexes: BranchIndexes): BranchInfo | null => {
    if (!msg.entryId) return null

    // user 直接路径的父键优先用树链父（/entries parentId）：消息链父（/messages
    // parentEntryId）在 compaction/reset 等形态下与树链父分叉（compaction 占树链
    // 不占消息链），用消息链父查 childrenMap（键 = 树链父）会查空组——分支导航静默
    // 丢失；两链一致时两者相同。仅在消息不在树里（get 未命中 = undefined）时回退
    // 消息链父——树内 parentId===null（root 段首条）是有效键，不能用 ?? 回退
    const treeParent = indexes.entryMap.get(msg.entryId)?.parentId
    const parentKey = (treeParent !== undefined ? treeParent : msg.parentEntryId) || ROOT_PARENT_KEY
    const liveSiblings = getLiveMessageSiblings(parentKey, indexes)
    // user 角色的兄弟列表即分支列表（user 尾锚的导航目标，见 MessageBubble user
    // footer），跨 role 归一（见 getLiveMessageSiblings 注释）后含同分叉点的回复
    // 分支。与下方 assistant 回退路径的 parentSiblings 保持同口径
    //（isSwitchableSibling）。assistant 直系兄弟不走此过滤：那批 sibling 本身就是
    // 回复级分支，契约见 chat-branch-navigation.test.ts 的既有钉子。
    const ownSiblings = msg.role === 'user'
        ? liveSiblings.filter(id => isSwitchableSibling(msg.entryId!, id, indexes))
        : liveSiblings
    if (ownSiblings.length > 1) {
        const currentIndex = ownSiblings.indexOf(msg.entryId)
        if (currentIndex >= 0) {
            return { siblings: ownSiblings, currentIndex }
        }
    }

    if (msg.role !== 'assistant') return null

    const parentMessage = findNearestMessageAncestor(msg.parentEntryId, indexes)
    if (!parentMessage || isDeletedEntry(parentMessage)) {
        return null
    }

    const parentSiblings = getLiveMessageSiblings(parentMessage.parentId || ROOT_PARENT_KEY, indexes)
        .filter(id => isSwitchableSibling(parentMessage.id, id, indexes))

    if (parentSiblings.length <= 1) {
        return null
    }

    const parentIndex = parentSiblings.indexOf(parentMessage.id)
    if (parentIndex < 0) {
        return null
    }

    return {
        siblings: parentSiblings,
        currentIndex: parentIndex,
    }
}
