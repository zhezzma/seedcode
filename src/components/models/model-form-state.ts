import type {
    AvailableModel,
    ThinkingLevelMap,
    ModelCost,
} from '../../composables/useModelsState'

export type ModelTypeOption = 'chat' | 'image' | 'classifier'

export interface ModelFormState {
    id: string
    name: string
    /** 模型类型：chat 对话 / image 生图 / classifier 决策裁判。 */
    type: ModelTypeOption
    contextWindow: number
    maxTokens: number
    cost: ModelCost
    reasoning: boolean
    input: string[]
    thinkingLevelMap: ThinkingLevelMap
}

export function createDefaultModelFormData(): ModelFormState {
    return {
        id: '',
        name: '',
        type: 'chat',
        contextWindow: 128000,
        maxTokens: 4096,
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        reasoning: false,
        input: ['text', 'image'],
        thinkingLevelMap: {},
    }
}

/** 提交用 cost：浅拷贝基础费率 + 深拷 tiers，避免把表单 reactive 引用直接写回 state。 */
export function buildModelCostForSave(cost: ModelCost): ModelCost {
    return {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
        // 表单不编辑 tiers，但 PATCH 会整对象替换 cost，必须原样带回。
        ...(cost.tiers?.length ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
    }
}

export function applyModelFormData(target: ModelFormState, initialData?: AvailableModel): ModelFormState {
    const defaults = createDefaultModelFormData()

    // 先回到完整默认值，再覆写已有字段，避免上一次编辑残留在当前表单中。
    target.id = initialData?.id ?? defaults.id
    target.name = initialData?.name ?? defaults.name
    target.type = initialData?.type ?? defaults.type
    target.contextWindow = initialData?.contextWindow ?? defaults.contextWindow
    target.maxTokens = initialData?.maxTokens ?? defaults.maxTokens
    target.cost = buildModelCostForSave({
        input: initialData?.cost?.input ?? defaults.cost.input,
        output: initialData?.cost?.output ?? defaults.cost.output,
        cacheRead: initialData?.cost?.cacheRead ?? defaults.cost.cacheRead,
        cacheWrite: initialData?.cost?.cacheWrite ?? defaults.cost.cacheWrite,
        ...(initialData?.cost?.tiers ? { tiers: initialData.cost.tiers } : {}),
    })
    target.reasoning = initialData?.reasoning ?? defaults.reasoning
    target.input = initialData
        ? [...(initialData.input?.length ? initialData.input : ['text'])]
        : [...defaults.input]
    // 深拷避免表单编辑直接窜改到 state.providers 里的原始对象。
    target.thinkingLevelMap = { ...(initialData?.thinkingLevelMap ?? {}) }

    return target
}
