/**
 * A2UI v1.0 协议类型定义
 * 基于 https://github.com/a2ui-project/a2ui 规范（specification/v1_0）
 */

// ==================== 协议常量 ====================

/** envelope 版本（v1.0 schema const，硬切：非此版本消息一律丢弃） */
export const A2UI_VERSION = 'v1.0' as const

/** 本渲染端组件 registry 对应的私有 catalog；服务端 createSurface 的默认 catalogId */
export const SEEDCODE_BASIC_CATALOG_ID = 'dev.seedcode/basic'

// ==================== v1.0 纯谓词（零依赖，可测） ====================

/** 硬切：非 v1.0 envelope 一律拒绝 */
export function isSupportedA2uiMessage(msg: any): boolean {
    return msg != null && typeof msg === 'object' && msg.version === A2UI_VERSION
}

/** v1.0 catalogId 解析：surface 默认 catalog 缺省视为本渲染端 catalog；显式声明其它值 → 拒绝 */
export function isSurfaceCatalogAllowed(catalogId: unknown): boolean {
    return catalogId === undefined || catalogId === SEEDCODE_BASIC_CATALOG_ID
}

/** 组件级 catalogId：非对象（null/undefined/标量）或非本渲染端 catalog → 不渲染 */
export function isComponentCatalogAllowed(component: unknown): boolean {
    if (component == null || typeof component !== 'object') return false
    const catalogId = (component as { catalogId?: unknown }).catalogId
    return catalogId === undefined || catalogId === SEEDCODE_BASIC_CATALOG_ID
}

// ==================== 动态值类型 ====================

/** 数据绑定 - JSON Pointer 路径 */
export interface DataBinding {
  path: string
}

/** 函数调用 */
export interface FunctionCall {
  call: string
  args: Record<string, any>
  returnType?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any' | 'void'
  /** v1.0：函数源 catalog（组件/函数级声明优先于 surface 默认） */
  catalogId?: string
}

/** 动态字符串：字面值 | 数据绑定 | 函数调用 */
export type DynamicString = string | DataBinding | FunctionCall

/** 动态数字 */
export type DynamicNumber = number | DataBinding | FunctionCall

/** 动态布尔 */
export type DynamicBoolean = boolean | DataBinding | LogicExpression

/** 动态字符串列表 */
export type DynamicStringList = string[] | DataBinding | FunctionCall

/** 动态值 */
export type DynamicValue = string | number | boolean | any[] | DataBinding | FunctionCall

// ==================== 逻辑表达式 ====================

export type LogicExpression =
  | { and: LogicExpression[] }
  | { or: LogicExpression[] }
  | { not: LogicExpression }
  | FunctionCall
  | { true: true }
  | { false: false }

// ==================== 子组件与动作 ====================

/** 子组件列表：静态 ID 数组 或 动态模板 */
export type ChildList = string[] | { componentId: string; path: string }

/** 动作 */
export type Action =
  | { event: { name: string; context?: Record<string, DynamicValue>; userMessage?: DynamicString } }
  | { functionCall: FunctionCall }

/** v1.0 校验结果：CheckRule.condition 求值可为 ValidationResult（布尔返回值仍兼容） */
export interface ValidationResult {
  valid: boolean
  code?: string
  message?: string
  severity?: string
}

/** 验证规则（v1.0：message 降级为 fallback，优先取 ValidationResult.message） */
export interface CheckRule {
  condition: DynamicBoolean
  message?: string
}

/** 无障碍属性（v1.0：live 对应 aria-live；hidden 为动态隐藏） */
export interface AccessibilityAttributes {
  label?: DynamicString
  description?: DynamicString
  live?: 'off' | 'polite' | 'assertive'
  hidden?: DynamicBoolean
}

// ==================== 组件类型定义 ====================

interface ComponentBase {
  component: string
  id?: string
  weight?: number
  accessibility?: AccessibilityAttributes
}

export interface TextComponent extends ComponentBase {
  component: 'Text'
  text: DynamicString
  variant?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body'
}

export interface ImageComponent extends ComponentBase {
  component: 'Image'
  url: DynamicString
  fit?: 'contain' | 'cover' | 'fill' | 'none' | 'scaleDown'
  variant?: 'icon' | 'avatar' | 'smallFeature' | 'mediumFeature' | 'largeFeature' | 'header'
}

export const ICON_NAMES = [
  'accountCircle', 'add', 'arrowBack', 'arrowForward', 'attachFile',
  'calendarToday', 'call', 'camera', 'check', 'close', 'delete',
  'download', 'edit', 'event', 'error', 'fastForward', 'favorite',
  'favoriteOff', 'folder', 'help', 'home', 'info', 'locationOn',
  'lock', 'lockOpen', 'mail', 'menu', 'moreVert', 'moreHoriz',
  'notificationsOff', 'notifications', 'pause', 'payment', 'person',
  'phone', 'photo', 'play', 'print', 'refresh', 'rewind', 'search',
  'send', 'settings', 'share', 'shoppingCart', 'skipNext',
  'skipPrevious', 'star', 'starHalf', 'starOff', 'stop', 'upload',
  'visibility', 'visibilityOff', 'volumeDown', 'volumeMute',
  'volumeOff', 'volumeUp', 'warning'
] as const

export type IconName = (typeof ICON_NAMES)[number]

export interface IconComponent extends ComponentBase {
  component: 'Icon'
  name: IconName | { path: string }
}

export interface VideoComponent extends ComponentBase {
  component: 'Video'
  url: DynamicString
}

export interface AudioPlayerComponent extends ComponentBase {
  component: 'AudioPlayer'
  url: DynamicString
  description?: DynamicString
}

export interface RowComponent extends ComponentBase {
  component: 'Row'
  children: ChildList
  justify?: 'center' | 'end' | 'spaceAround' | 'spaceBetween' | 'spaceEvenly' | 'start' | 'stretch'
  align?: 'start' | 'center' | 'end' | 'stretch'
}

export interface ColumnComponent extends ComponentBase {
  component: 'Column'
  children: ChildList
  justify?: 'start' | 'center' | 'end' | 'spaceBetween' | 'spaceAround' | 'spaceEvenly' | 'stretch'
  align?: 'center' | 'end' | 'start' | 'stretch'
}

export interface ListComponent extends ComponentBase {
  component: 'List'
  children: ChildList
  direction?: 'vertical' | 'horizontal'
  align?: 'start' | 'center' | 'end' | 'stretch'
}

export interface CardComponent extends ComponentBase {
  component: 'Card'
  child: string
}

export interface TabsComponent extends ComponentBase {
  component: 'Tabs'
  tabs: Array<{ title: DynamicString; child: string }>
}

export interface ModalComponent extends ComponentBase {
  component: 'Modal'
  trigger: string
  content: string
}

export interface DividerComponent extends ComponentBase {
  component: 'Divider'
  axis?: 'horizontal' | 'vertical'
}

export interface ButtonComponent extends ComponentBase {
  component: 'Button'
  child: string
  variant?: 'default' | 'primary' | 'borderless'
  action: Action
  checks?: CheckRule[]
}

export interface TextFieldComponent extends ComponentBase {
  component: 'TextField'
  label: DynamicString
  value?: DynamicString
  variant?: 'longText' | 'number' | 'shortText' | 'obscured'
  validationRegexp?: string
  checks?: CheckRule[]
}

export interface CheckBoxComponent extends ComponentBase {
  component: 'CheckBox'
  label: DynamicString
  value: DynamicBoolean
  checks?: CheckRule[]
}

export interface ChoicePickerComponent extends ComponentBase {
  component: 'ChoicePicker'
  label?: DynamicString
  variant?: 'multipleSelection' | 'mutuallyExclusive'
  /** 静态选项，或绑定数据模型路径（私有 catalog 扩展：级联动态选项） */
  options: Array<{ label: DynamicString; value: string }> | { path: string }
  value: DynamicStringList
  displayStyle?: 'checkbox' | 'chips' | 'select'
  filterable?: boolean
  /** 私有 catalog 扩展：选中变更时触发的 action（级联 callAgentFunction 的入口） */
  action?: Action
  checks?: CheckRule[]
}

export interface SliderComponent extends ComponentBase {
  component: 'Slider'
  label?: DynamicString
  min?: number
  max: number
  value: DynamicNumber
  checks?: CheckRule[]
}

export interface DateTimeInputComponent extends ComponentBase {
  component: 'DateTimeInput'
  value: DynamicString
  enableDate?: boolean
  enableTime?: boolean
  min?: DynamicString
  max?: DynamicString
  label?: DynamicString
  checks?: CheckRule[]
}

/** 所有 A2UI 组件联合类型 */
export type A2UIComponentType =
  | TextComponent
  | ImageComponent
  | IconComponent
  | VideoComponent
  | AudioPlayerComponent
  | RowComponent
  | ColumnComponent
  | ListComponent
  | CardComponent
  | TabsComponent
  | ModalComponent
  | DividerComponent
  | ButtonComponent
  | TextFieldComponent
  | CheckBoxComponent
  | ChoicePickerComponent
  | SliderComponent
  | DateTimeInputComponent

/** 通用 A2UI 组件（松散类型，用于解析时） */
export interface A2UIComponent {
  component: string
  id?: string
  weight?: number
  [key: string]: any
}

// ==================== 消息类型（agent→renderer，v1.0） ====================

export interface CreateSurfaceMessage {
  version: typeof A2UI_VERSION
  createSurface: {
    surfaceId: string
    /** v1.0：surface 默认 catalog（本渲染端仅识别 SEEDCODE_BASIC_CATALOG_ID） */
    catalogId?: string
    /** v1.0：单消息内联整面 UI */
    components?: A2UIComponent[]
    dataModel?: Record<string, any>
    sendDataModel?: boolean
    metadata?: Record<string, any>
  }
}

export interface UpdateComponentsMessage {
  version: typeof A2UI_VERSION
  updateComponents: {
    surfaceId: string
    components: A2UIComponent[]
  }
}

export interface UpdateDataModelMessage {
  version: typeof A2UI_VERSION
  updateDataModel: {
    surfaceId: string
    path?: string
    value?: any
  }
}

export interface DeleteSurfaceMessage {
  version: typeof A2UI_VERSION
  deleteSurface: {
    surfaceId: string
  }
}

/** v1.0：agent 调渲染端本地函数（聊天流下行；响应经 a2uiClient 回 rendererFunctionResponse） */
export interface CallRendererFunctionMessage {
  version: typeof A2UI_VERSION
  callRendererFunction: {
    functionCallId: string
    callFunction: { function: string; args?: Record<string, any>; catalogId: string }
  }
}

/** v1.0：callAgentFunction 的响应（HTTP 响应 messages 内下发） */
export interface AgentFunctionResponseMessage {
  version: typeof A2UI_VERSION
  agentFunctionResponse: {
    functionCallId: string
    value?: any
    error?: { code: string; message: string }
  }
}

export type A2UIMessage =
  | CreateSurfaceMessage
  | UpdateComponentsMessage
  | UpdateDataModelMessage
  | DeleteSurfaceMessage
  | CallRendererFunctionMessage
  | AgentFunctionResponseMessage

// ==================== Surface 状态 ====================

export interface A2UISurface {
  surfaceId: string
  catalogId: string
  components: Map<string, A2UIComponent>
  /** 根组件 ID 列表（按顺序） */
  rootComponentIds: string[]
  dataModel: Record<string, any>
  sendDataModel?: boolean
}
