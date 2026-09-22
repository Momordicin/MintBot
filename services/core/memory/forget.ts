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

export class ForgetConflictError extends Error {
  constructor(public impact: ForgetImpact) {
    super(`Cannot forget messages: ${impact.affectedSummaries.length} summary(ies) overlap this range. Pass alsoDeleteAffectedSummaries: true to also delete them.`)
    this.name = 'ForgetConflictError'
  }
}

export function checkForgetImpact(sessionId: string, fromTime: number, toTime: number): ForgetImpact {
  const messageIds = getMessageIdsInTimeRange(sessionId, fromTime, toTime)
  if (messageIds.length === 0) {
    return { messageIds: [], affectedSummaries: [] }
  }

  const minMessageId = messageIds[0]
  const maxMessageId = messageIds[messageIds.length - 1]
  const affectedSummaries = getSummariesOverlappingRange(sessionId, minMessageId, maxMessageId)

  return { messageIds, affectedSummaries }
}

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
