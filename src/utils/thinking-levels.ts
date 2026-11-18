/** 思考档位表（客户端权威副本；服务端 ALL_THINKING_LEVELS 同值——两仓契约）。
 *  ChatInput（会话思考下拉）与 TeamMemberFields（群成员思考覆盖）共用，
 *  不再各自内联抄写。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ThinkingLevel = typeof THINKING_LEVELS[number]
