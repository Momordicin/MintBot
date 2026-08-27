import {
  getMessageIdsInTimeRange,
  getSummariesOverlappingRange,
  forgetMessages,
} from '../session/queries.js'
import type { Summary } from '../../../shared/types/index.js'

export interface ForgetImpact {
  messageIds: number[]
  affectedSummaries: Summary[]
}

export interface ForgetResult {
  deletedMessages: number
  deletedEntities: number
  deletedSummaries: number
  deletedEmbeddings: number
  deletedFts: number
}

// 携带 ForgetImpact，供调用方（/forget 路由）直接从这个错误里拿到受影响摘要信息构造 409 响应，
// 不需要在 forgetTimeRange 之外再单独调一次 checkForgetImpact——避免同一次请求里查两遍，
// 也避免两次结果理论上不一致（万一将来任一函数改成异步、中间被别的写操作插入）
export class ForgetConflictError extends Error {
  constructor(public impact: ForgetImpact) {
    super(`Cannot forget messages: ${impact.affectedSummaries.length} summary(ies) overlap this range. Pass alsoDeleteAffectedSummaries: true to also delete them.`)
    this.name = 'ForgetConflictError'
  }
}

// 只读检查：给定时间段，会影响到哪些消息、哪些摘要，不做任何删除。整理模式的摘要/embedding
// 生成是异步的（orchestrator.ts 按 cron tick + 阈值触发），不能假设"最近的对话肯定还没被处理"，
// 所以删除前必须先查一遍受影响范围，供调用方（forgetTimeRange / /forget/check 路由）决策
export function checkForgetImpact(sessionId: string, fromTime: number, toTime: number): ForgetImpact {
  const messageIds = getMessageIdsInTimeRange(sessionId, fromTime, toTime)
  if (messageIds.length === 0) {
    return { messageIds: [], affectedSummaries: [] }
  }

  // messageIds 已经是 getMessageIdsInTimeRange 按 id 升序返回的，直接取首尾即可，不用
  // Math.min(...messageIds)/Math.max(...messageIds)——大范围删除时数组可能有几千个元素，
  // 展开成函数参数会撞上 JS 引擎的调用参数数量上限而抛错，正好是这个功能最需要支持的场景
  const minMessageId = messageIds[0]
  const maxMessageId = messageIds[messageIds.length - 1]
  const affectedSummaries = getSummariesOverlappingRange(sessionId, minMessageId, maxMessageId)

  return { messageIds, affectedSummaries }
}

// 实际执行删除。alsoDeleteAffectedSummaries 为 false 且确实有摘要重叠时，直接抛错（不静默只删
// 消息、放摘要不管——那样等于给了一个"以为删干净了"的假安全感，是这个功能最不能接受的失败模式）。
// 抛错发生在 checkForgetImpact（只读）之后、forgetMessages（唯一的写操作）之前，因此报错前
// 不产生任何数据库副作用
export function forgetTimeRange(
  sessionId: string,
  fromTime: number,
  toTime: number,
  options: { alsoDeleteAffectedSummaries: boolean }
): ForgetResult {
  const { messageIds, affectedSummaries } = checkForgetImpact(sessionId, fromTime, toTime)

  if (messageIds.length === 0) {
    return { deletedMessages: 0, deletedEntities: 0, deletedSummaries: 0, deletedEmbeddings: 0, deletedFts: 0 }
  }

  if (affectedSummaries.length > 0 && !options.alsoDeleteAffectedSummaries) {
    throw new ForgetConflictError({ messageIds, affectedSummaries })
  }

  return forgetMessages({
    sessionId,
    messageIds,
    summaryIdsToDelete: options.alsoDeleteAffectedSummaries ? affectedSummaries.map(s => s.id) : [],
  })
}
