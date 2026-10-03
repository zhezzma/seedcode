/**
 * assistant message_end 固化：用服务端权威全文修补本地 delta 拼接流。
 *
 * 背景（pi-durable 流式语义，与 seedagent channel-wechat monitor 的 observe 修法同构）：
 * - 首批文本只随 message_start 的 partial 消息落位；
 * - thinking→text 等跨块切换的首批只随 message_update 的 text_start/block change
 *   落位（SSE 投影不下发该 change）；
 * - 末批（最后一次 ~100ms flush 之后的尾巴）只随 message_end 的 entry 落位。
 * 三者均不走 text_delta/thinking_delta → 本地拼接流可能缺头/缺段/缺尾，以
 * message_end 携带的落盘全文（endMsg.content）为准整块修补。
 *
 * 修补规则：
 * - 文本/思考块按 _ci（= pi content 数组下标）对位，整块替换为权威块（含
 *   thinkingSignature 等元数据）；本地块内容恒为权威内容的子串（播种 + delta 追加），
 *   整块替换恒安全；
 * - 产物按 _ci 归位排序：权威里有、本地没有的块（跨块首批整体未达或末批块）落到
 *   作者位置而非尾部——openai 网关的 reasoning 增量可能交错出现在正文中间，
 *   缺失块按尾部追加会打乱渲染顺序。本地工具卡没有 _ci，锚定到它前面最近的
 *   已知块位（流首的卡锚 -1，保持在文本之前），排序稳定（同键保持流内相对顺序）；
 * - 工具卡保留本地块：卡带 toolState/toolResult 运行态，权威 toolCall 块没有。
 *   防御层（原 useChatState 固化注释迁此）：与历史同 id 的 toolCall 卡不随流固化。
 *   正常 live 流中历史（本地固化副本）不含同 id 卡，此过滤断言为 no-op；但任何路径
 *   遗留的流内工具卡（如旧连接残留、快照对账前的窗口）若已被落盘数据覆盖，此处阻断
 *   它固化成第二条永久消息——否则要等到 done 全量刷新才收敛，期间同 id 双卡。
 *   文本块无 id 不参与去重（快照对账已从根上作废旧流，这里只兜工具卡）；
 * - 兼容门禁：流内无任何 _ci 标记 = 旧服务端（delta 无 contentIndex），权威全文与
 *   本地流无法对位 → 原样固化（保持旧行为，防权威全文与本地流重复叠加）。
 */

/** 固化依赖：与历史同 id 的 toolCall 卡不随流固化（防双卡，规则见文件头）。 */
export interface SolidifyDeps {
    isToolCallInHistory: (id: string) => boolean
}

const isTextLike = (block: any): boolean => block?.type === 'text' || block?.type === 'thinking'

/** assistant 消息是否携带非空 text/thinking 块（超短回复「整条只在 message_end 落位」的固化门禁）。 */
export function hasAssistantTextContent(message: { role?: string; content?: unknown } | undefined | null): boolean {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return false
    return message.content.some((block: any) => {
        if (block?.type !== 'text' && block?.type !== 'thinking') return false
        const text = block.type === 'text' ? block.text : block.thinking
        return typeof text === 'string' && text.length > 0
    })
}

/** 块序列的文本签名（类型前缀 + 分隔符拼接，防拼接歧义）：重复 message_end 防重放比对用 */
export function blocksTextSignature(blocks: unknown): string {
    if (!Array.isArray(blocks)) return ''
    return blocks
        .filter((block: any) => block?.type === 'text' || block?.type === 'thinking')
        .map((block: any) => `${block.type}:\u0000${(block.type === 'text' ? block.text : block.thinking) ?? ''}`)
        .join('\u0001')
}

/**
 * 由流内块（rawStream，未深拷贝，_ci 可读）+ 服务端权威全文（messageContent）算出固化内容。
 * 返回值为全新深拷贝数组（_ci 随 JSON 拷贝天然剥离，不进历史）。
 */
export function solidifyAssistantContent(
    rawStream: any[],
    messageContent: unknown,
    deps: SolidifyDeps,
): any[] {
    // 去重过滤只做一次：① toolCall 卡防双卡；② 空 text/thinking 占位块不进历史
    //（播种的位置占位块若始终未收到内容，原样固化会变成空气泡——播种引入前
    // 流为空不会固化，此处两分支共用过滤保持原语义）
    const dedupedStream = rawStream.filter((block: any) => {
        if (isTextLike(block)) {
            const text = block.type === 'text' ? block.text : block.thinking
            return typeof text === 'string' && text.length > 0
        }
        if (block?.type !== 'toolCall' || !block.id) return true
        return !deps.isToolCallInHistory(block.id)
    })

    const authByCi = new Map<number, any>()
    if (Array.isArray(messageContent)) {
        messageContent.forEach((block: any, index: number) => {
            if (!isTextLike(block)) return
            const text = block.type === 'text' ? block.text : block.thinking
            if (typeof text !== 'string' || !text) return
            authByCi.set(index, block) // 末尾统一深拷贝，此处存引用即可
        })
    }
    const localTextCount = dedupedStream.filter(isTextLike).length
    const routedTextCount = dedupedStream.filter((block: any) => isTextLike(block) && typeof block?._ci === 'number').length
    const hasUnroutedText = dedupedStream.some((block: any) => isTextLike(block) && typeof block?._ci !== 'number')
    // 兼容门禁：有本地文本块但混有无 _ci 的（旧服务端 delta 无 contentIndex；含播种块
    // 与旧 delta 块混流的边角）→ 无法对位，整体退回旧行为原样固化（替换/插入都会
    // 与本地流重复叠加）。纯工具卡流（无本地文本）可在任何服务端安全修补——不存在
    // 可重复的本地文本；空流（超短回复）同理走权威直采。
    if (authByCi.size === 0 || (localTextCount > 0 && (routedTextCount === 0 || hasUnroutedText))) {
        return JSON.parse(JSON.stringify(dedupedStream))
    }

    // 第一步：本地块就位——text/thinking 命中权威即整块替换；同 _ci 的重复本地块
    //（防御）只保留首个；空占位块已在去重过滤中丢弃；工具卡无 _ci，锚定到它前面
    // 最近已位块的 key（流首的卡锚 -1，保持在文本之前）
    const placed: { key: number; block: any }[] = []
    const patchedCi = new Set<number>()
    let anchor = -1
    for (const rawBlock of dedupedStream) {
        const ci = rawBlock?._ci
        if (isTextLike(rawBlock) && typeof ci === 'number') {
            if (patchedCi.has(ci)) continue
            if (authByCi.has(ci)) {
                patchedCi.add(ci)
                placed.push({ key: ci, block: authByCi.get(ci) })
                anchor = ci
                continue
            }
        }
        placed.push({ key: typeof ci === 'number' ? ci : anchor, block: rawBlock })
        if (typeof ci === 'number') anchor = ci
    }
    // 第二步：本地缺失的权威块（跨块首批整体未达 / 末批）落到作者位置
    //（到达此处的流必全路由：门禁已拦下混有无 _ci 文本块的旧协议流）
    for (const [ci, block] of authByCi) {
        if (!patchedCi.has(ci)) placed.push({ key: ci, block })
    }
    // 稳定排序：同 key 保持流内相对顺序（工具卡与其锚定块不互换）；末尾统一深拷贝
    return placed
        .map((entry, index) => ({ ...entry, index }))
        .sort((a, b) => (a.key - b.key) || (a.index - b.index))
        .map((entry) => JSON.parse(JSON.stringify(entry.block)))
}
