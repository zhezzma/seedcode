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

const getLiveMessageSiblings = (parentId: string | null | undefined, role: 'user' | 'assistant', indexes: BranchIndexes): string[] => {
    return (indexes.childrenMap.get(parentId || ROOT_PARENT_KEY) ?? []).filter(id => {
        const entry = indexes.entryMap.get(id)
        if (!entry || entry.type !== 'message' || isDeletedEntry(entry)) {
            return false
        }

        const entryRole = entry.message?.role
        return !entryRole || entryRole === role
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

export const findLeafId = (startId: string, indexes: BranchIndexes): string => {
    let leafId = startId

    while (true) {
        const nextId = pickNextChild(leafId, indexes)
        if (!nextId) return leafId
        leafId = nextId
    }
}

export const getBranchInfo = (msg: BranchMessageLike, indexes: BranchIndexes): BranchInfo | null => {
    if (!msg.entryId) return null

    const parentKey = msg.parentEntryId || ROOT_PARENT_KEY
    const liveSiblings = getLiveMessageSiblings(parentKey, msg.role, indexes)
    // user 角色的兄弟列表即分支列表（user 尾锚的导航目标，见 MessageBubble user footer）。
    // 与下方 assistant 回退路径的 parentSiblings 保持同口径：只数「自己 + 有活跃消息
    // 后代的兄弟」——无活跃后代的分支（回复被删光）不占计数、不从活分支跳入，但
    // 自身恒保留（死分支的逃逸锚点：从死分支仍可切回活分支），经 /tree 亦可达。
    // assistant 直系兄弟（role==='assistant' 的 ownSiblings）不走此过滤：那批 sibling
    // 本身就是回复级分支，契约见 chat-branch-navigation.test.ts 的既有钉子。
    const ownSiblings = msg.role === 'user'
        ? liveSiblings.filter(id => id === msg.entryId || findFirstDescendantMessageId(id, indexes) !== null)
        : liveSiblings
    if (ownSiblings.length > 1) {
        const currentIndex = ownSiblings.indexOf(msg.entryId)
        if (currentIndex >= 0) {
            return { siblings: ownSiblings, currentIndex }
        }
    }

    if (msg.role !== 'assistant') return null

    const parentMessage = findNearestMessageAncestor(msg.parentEntryId, indexes)
    if (!parentMessage?.parentId || isDeletedEntry(parentMessage)) {
        return null
    }

    const parentSiblings = getLiveMessageSiblings(parentMessage.parentId || ROOT_PARENT_KEY, 'user', indexes)
        .filter(id => id === parentMessage.id || findFirstDescendantMessageId(id, indexes) !== null)

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
