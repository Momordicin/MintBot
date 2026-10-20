// services/core/memory/orchestrator.ts — "整理模式"后台调度：在无活跃对话的整理时段抽取实体并嵌入积压消息；无活跃对话且 shouldTriggerSummary 通过时生成摘要；AI 空闲后卸载 embedding/NER 模型；另提供嵌入队列状态
// 用法：index.ts 的 start() 调 startOrganizeModeScheduler(fastify)（node-cron，用 fastify 上的 embedding/NER/backgroundModel provider，关闭时 stop()）；runOrganizeModeTick 为单次执行；routes/memory.ts（GET /embedding-queue-status）与 state.ts（GET /state）调 computeEmbeddingQueueStatus
// 形状：runOrganizeModeTick -> OrganizeModeTickResult；computeEmbeddingQueueStatus -> EmbeddingQueueStatus；startOrganizeModeScheduler -> ScheduledTask
// 对应文件：services/core/memory/embedQueue.ts / services/core/memory/entityExtractor.ts / services/core/memory/summarizer.ts / services/core/providers/aiActivity.ts / services/core/providers/ModelProvider.ts / services/core/system/lockState.ts / services/core/routes/memory.ts / services/core/state.ts / services/core/memory/orchestrator.test.ts
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
  getPresetById,
  getPresetApiKeys,
  getPresetIdBySession,
} from '../session/queries.js'
import { getLockScreenMinutes } from '../system/lockState.js'
import { getCurrentState } from '../session/index.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'
import type { NERProvider } from '../providers/NERProvider.js'
import { createSummaryModelProviderForPreset } from '../providers/ModelProvider.js'
import { getLastActivityAt } from '../providers/aiActivity.js'
import type { EmbeddingQueueStatus, Message } from '../../../shared/types/index.js'
import { getMemoryConfig, getModelProviderConfig } from '../config/index.js'

const ACTIVE_CONVERSATION_WINDOW_MS = 5 * 60 * 1000
const IDLE_UNLOAD_THRESHOLD_MS = 5 * 60 * 1000
const OLLAMA_BACKGROUND_BATCH = 50
const CLOUD_SUMMARY_MAX_MESSAGES = 200

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

function resolveModelForPreset(presetId: string | null, globalModel: EntityModelProvider): EntityModelProvider {
  if (presetId === null) return globalModel
  const active = getCurrentState()
  const isActive = active?.session.presetId === presetId
  const preset = isActive ? active.preset : getPresetById(presetId)
  if (!preset || preset.modelType === null || preset.modelName === null) return globalModel
  const credentials = isActive ? active.credentials : getPresetApiKeys(presetId)
  return createSummaryModelProviderForPreset(preset, getModelProviderConfig(), credentials)
}

function groupByPreset(messages: Message[]): Map<string | null, Message[]> {
  const presetBySession = new Map<string, string | null>()
  const groups = new Map<string | null, Message[]>()
  for (const message of messages) {
    if (!presetBySession.has(message.sessionId)) {
      presetBySession.set(message.sessionId, getPresetIdBySession(message.sessionId))
    }
    const presetId = presetBySession.get(message.sessionId) ?? null
    const group = groups.get(presetId)
    if (group) group.push(message)
    else groups.set(presetId, [message])
  }
  return groups
}

export interface OrganizeModeTickResult {
  triggered: boolean
  batches: number
  totalProcessed: number
  totalEntitiesInserted: number
  totalEntitiesClosed: number
  summariesGenerated: number
}

function isOllamaModel(model: EntityModelProvider): boolean {
  return model.providerType === 'ollama'
}

function summaryMaxMessages(model: EntityModelProvider): number {
  return isOllamaModel(model) ? OLLAMA_BACKGROUND_BATCH : CLOUD_SUMMARY_MAX_MESSAGES
}

let organizeRunning = false

export async function runOrganizeModeTick(
  deps: { embedding: EmbeddingProvider; ner: NERProvider; model: EntityModelProvider },
  batchSize = 200,
  getNow: () => number = Date.now
): Promise<OrganizeModeTickResult> {
  if (organizeRunning) {
    console.log('[OrganizeMode] previous run still in progress, skipping this tick')
    return { triggered: false, batches: 0, totalProcessed: 0, totalEntitiesInserted: 0, totalEntitiesClosed: 0, summariesGenerated: 0 }
  }
  organizeRunning = true
  try {
    return await runOrganizeModeTickBody(deps, batchSize, getNow)
  } finally {
    organizeRunning = false
  }
}

async function runOrganizeModeTickBody(
  deps: { embedding: EmbeddingProvider; ner: NERProvider; model: EntityModelProvider },
  batchSize: number,
  getNow: () => number
): Promise<OrganizeModeTickResult> {
  let batches = 0
  let totalProcessed = 0
  let totalEntitiesInserted = 0
  let totalEntitiesClosed = 0
  let summariesGenerated = 0

  while (shouldTriggerOrganizeMode(getNow())) {
    const batch = getPendingEmbeddingMessages(batchSize)
    if (batch.length === 0) break

    let inserted = 0
    let closed = 0
    for (const [presetId, messages] of groupByPreset(batch)) {
      let model: EntityModelProvider
      try {
        model = resolveModelForPreset(presetId, deps.model)
      } catch (err) {
        console.error(`[OrganizeMode] model unavailable for preset ${presetId ?? '(unknown)'}, entity model layer skipped:`, err)
        model = { completeSync: () => Promise.reject(err) }
      }
      try {
        const chunkSize = isOllamaModel(model) ? OLLAMA_BACKGROUND_BATCH : messages.length
        for (let i = 0; i < messages.length; i += chunkSize) {
          const result = await extractEntities(messages.slice(i, i + chunkSize), { ner: deps.ner, model })
          inserted += result.inserted
          closed += result.closed
        }
      } catch (err) {
        console.error(`[OrganizeMode] entity extraction failed for preset ${presetId ?? '(unknown)'}:`, err)
      }
    }
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
        try {
          const model = resolveModelForPreset(getPresetIdBySession(activeSessionId), deps.model)
          const result = await generateSummary(activeSessionId, { model }, summaryMaxMessages(model))
          if (result !== null) summariesGenerated++
        } catch (err) {
          console.error(`[OrganizeMode] summary failed for session ${activeSessionId}:`, err)
        }
      }
    }

    if (processed === 0) break
  }

  if (!computeActiveConversation(getNow())) {
    for (const sessionId of getSessionsWithPendingSummaries()) {
      try {
        let model: EntityModelProvider | undefined
        while (!computeActiveConversation(getNow())) {
          const shouldSummarize = shouldTriggerSummary({
            messageCountSinceLastSummary: getPendingSummaryCount(sessionId),
            lockScreenMinutes: getLockScreenMinutes(getNow()),
            isLowActivityWindow: isInDefaultOrganizeWindow(getNow()),
          })
          if (!shouldSummarize) break

          model ??= resolveModelForPreset(getPresetIdBySession(sessionId), deps.model)
          const result = await generateSummary(sessionId, { model }, summaryMaxMessages(model))
          if (result === null) break
          summariesGenerated++
        }
      } catch (err) {
        console.error(`[OrganizeMode] summary failed for session ${sessionId}:`, err)
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
