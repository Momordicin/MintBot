import { schedule, type ScheduledTask } from 'node-cron'
import type { FastifyInstance } from 'fastify'
import { extractEntities, type EntityModelProvider } from './entityExtractor.js'
import { processEmbedQueue } from './embedQueue.js'
import { shouldTriggerSummary, generateSummary } from './summarizer.js'
import {
  getPendingEmbeddingCount,
  getPendingEmbeddingMessages,
  getMostRecentMessageTime,
  getOldestUnsummarizedMessageTime,
  getSessionsWithPendingSummaries,
  getPendingSummaryCount,
  getPendingEmbeddingCountForSession,
  getOldestPendingEmbeddingTimeForSession,
  getPendingEmbeddingCountBefore,
} from '../session/queries.js'
import { getLockScreenMinutes } from '../system/lockState.js'
import { getCurrentState } from '../session/index.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'
import type { NERProvider } from '../providers/NERProvider.js'
import { getLastActivityAt } from '../providers/aiActivity.js'
import type { EmbeddingQueueStatus } from '../../../shared/types/index.js'
import { getMemoryConfig } from '../config/index.js'

const ACTIVE_CONVERSATION_WINDOW_MS = 5 * 60 * 1000
const IDLE_UNLOAD_THRESHOLD_MS = 20 * 60 * 1000

let lastEmbeddingRun = 0

export function isInDefaultOrganizeWindow(timestamp: number): boolean {
  const { organizeWindowStartHour, organizeWindowEndHour } = getMemoryConfig()
  const hour = new Date(timestamp).getHours()
  return hour >= organizeWindowStartHour || hour < organizeWindowEndHour
}

function computeActiveConversation(now: number): boolean {
  const mostRecent = getMostRecentMessageTime()
  return mostRecent !== null && now - mostRecent < ACTIVE_CONVERSATION_WINDOW_MS
}

export function computeEmbeddingQueueStatus(now: number = Date.now(), activeSessionId: string | null = null): EmbeddingQueueStatus {
  const pendingCount = getPendingEmbeddingCount()
  const [oldestPending] = getPendingEmbeddingMessages(1)
  const oldestPendingAge = oldestPending ? (now - oldestPending.createdAt) / 60_000 : 0

  const oldestUnsummarized = getOldestUnsummarizedMessageTime()
  const oldestUnsummarizedAge = oldestUnsummarized !== null ? (now - oldestUnsummarized) / (24 * 60 * 60 * 1000) : 0

  let activePresetPendingCount: number | null = null
  let activePresetOldestPendingAge: number | null = null
  let pendingAheadOfActivePreset: number | null = null

  if (activeSessionId) {
    activePresetPendingCount = getPendingEmbeddingCountForSession(activeSessionId)
    const oldestPendingForSession = getOldestPendingEmbeddingTimeForSession(activeSessionId)
    activePresetOldestPendingAge = oldestPendingForSession !== null ? (now - oldestPendingForSession) / 60_000 : 0
    pendingAheadOfActivePreset = oldestPendingForSession !== null ? getPendingEmbeddingCountBefore(oldestPendingForSession) : 0
  }

  return {
    pendingCount,
    oldestPendingAge,
    oldestUnsummarizedAge,
    activeConversation: computeActiveConversation(now),
    lastEmbeddingRun,
    activePresetPendingCount,
    activePresetOldestPendingAge,
    pendingAheadOfActivePreset,
  }
}

function shouldTriggerOrganizeMode(now: number): boolean {
  const status = computeEmbeddingQueueStatus(now)
  const { pendingCountThreshold, oldestPendingAgeMinutes } = getMemoryConfig().summaryTrigger
  const pendingConditionMet =
    status.pendingCount > pendingCountThreshold || status.oldestPendingAge > oldestPendingAgeMinutes
  return pendingConditionMet && !status.activeConversation && isInDefaultOrganizeWindow(now)
}

export interface OrganizeModeTickResult {
  triggered: boolean
  batches: number
  totalProcessed: number
  totalEntitiesInserted: number
  totalEntitiesClosed: number
  summariesGenerated: number
}

export async function runOrganizeModeTick(
  deps: { embedding: EmbeddingProvider; ner: NERProvider; model: EntityModelProvider },
  batchSize = 200,
  getNow: () => number = Date.now
): Promise<OrganizeModeTickResult> {
  let batches = 0
  let totalProcessed = 0
  let totalEntitiesInserted = 0
  let totalEntitiesClosed = 0
  let summariesGenerated = 0

  while (shouldTriggerOrganizeMode(getNow())) {
    const batch = getPendingEmbeddingMessages(batchSize)
    if (batch.length === 0) break

    const { inserted, closed } = await extractEntities(batch, { ner: deps.ner, model: deps.model })
    const { processed } = await processEmbedQueue(deps.embedding, batchSize, batch)

    batches++
    totalProcessed += processed
    totalEntitiesInserted += inserted
    totalEntitiesClosed += closed
    lastEmbeddingRun = Date.now()

    const activeSessionId = getCurrentState()?.session.sessionId ?? null
    if (activeSessionId && !computeActiveConversation(getNow())) {
      const shouldSummarizeActive = shouldTriggerSummary({
        messageCountSinceLastSummary: getPendingSummaryCount(activeSessionId),
        lockScreenMinutes: getLockScreenMinutes(getNow()),
        isLowActivityWindow: isInDefaultOrganizeWindow(getNow()),
      })
      if (shouldSummarizeActive) {
        const result = await generateSummary(activeSessionId, { model: deps.model })
        if (result !== null) summariesGenerated++
      }
    }

    if (processed === 0) break
  }

  if (!computeActiveConversation(getNow())) {
    for (const sessionId of getSessionsWithPendingSummaries()) {
      while (!computeActiveConversation(getNow())) {
        const shouldSummarize = shouldTriggerSummary({
          messageCountSinceLastSummary: getPendingSummaryCount(sessionId),
          lockScreenMinutes: getLockScreenMinutes(getNow()),
          isLowActivityWindow: isInDefaultOrganizeWindow(getNow()),
        })
        if (!shouldSummarize) break

        const result = await generateSummary(sessionId, { model: deps.model })
        if (result === null) break
        summariesGenerated++
      }
    }
  }

  if (getNow() - getLastActivityAt() >= IDLE_UNLOAD_THRESHOLD_MS) {
    const idleResults = await Promise.allSettled([deps.embedding.unload(), deps.ner.unload()])
    for (const result of idleResults) {
      if (result.status === 'rejected') {
        console.error('[OrganizeMode] idle-unload failed:', result.reason)
      }
    }
  }

  return {
    triggered: batches > 0,
    batches,
    totalProcessed,
    totalEntitiesInserted,
    totalEntitiesClosed,
    summariesGenerated,
  }
}

export function startOrganizeModeScheduler(fastify: FastifyInstance): ScheduledTask {
  return schedule('*/5 * * * *', () => {
    runOrganizeModeTick({
      embedding: fastify.embeddingProvider,
      ner: fastify.nerProvider,
      model: fastify.backgroundModelProvider,
    }).catch(err => {
      console.error('[OrganizeMode] tick failed:', err)
    })
  })
}
