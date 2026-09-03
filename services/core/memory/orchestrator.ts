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

// 整理模式编排器（TDD §3.8）。本模块只负责"何时 + 循环多少批"，不重新实现
// embedding（embedQueue.ts）、实体抽取（entityExtractor.ts）或摘要生成（summarizer.ts）
// 本身的处理逻辑。

// ACTIVE_CONVERSATION_WINDOW_MS 是固定的活跃对话窗口，不对应任何 config.json 字段，
// 不属于本次 config 模块迁移范围
const ACTIVE_CONVERSATION_WINDOW_MS = 5 * 60 * 1000
const IDLE_UNLOAD_THRESHOLD_MS = 20 * 60 * 1000

// 进程内存状态：最近一次整理模式实际跑过 embedding 批次的时间戳，供 EmbeddingQueueStatus.lastEmbeddingRun
// 使用。不持久化到 DB（TDD §3.8 只要求维护监控状态，未要求跨进程重启保留），进程重启后重置为 0。
let lastEmbeddingRun = 0

// 默认低活跃时间窗口（夜间 22:00-08:00，本机系统时区），窗口起止小时来自独立 config 模块
// （memory.organizeWindowStartHour / organizeWindowEndHour）。真正的用户自定义可整理时间窗口
// （如"我今天 10 点之后不用电脑"）需要对话式意图识别接入后才能支持，这里仍是固定时间窗口。
export function isInDefaultOrganizeWindow(timestamp: number): boolean {
  const { organizeWindowStartHour, organizeWindowEndHour } = getMemoryConfig()
  const hour = new Date(timestamp).getHours()
  return hour >= organizeWindowStartHour || hour < organizeWindowEndHour
}

function computeActiveConversation(now: number): boolean {
  const mostRecent = getMostRecentMessageTime()
  return mostRecent !== null && now - mostRecent < ACTIVE_CONVERSATION_WINDOW_MS
}

// 供整理模式触发判断和 GET /state 共用，避免两处重复计算 EmbeddingQueueStatus。
// activeSessionId 为 null（无激活 session）时，三个 activePreset* 字段整体为 null——
// 这与"有激活 session 但它自己没有待处理消息"（用 0 表示，与全局 oldestPendingAge 在
// 无 pending 时同样回退 0 的既有约定一致）是两种不同的语义，不能都用 0 表达
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

// TDD §3.8 触发整理公式：(pendingCount>100 OR oldestPendingAge>120min) AND !activeConversation
// AND 当前时间 IN 可整理时间窗口
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

// 单次整理 tick：满足触发条件时按批处理（实体抽取 + embedding 共用同一批 pending 消息——
// getPendingEmbeddingMessages 只查询一次，同一个 batch 变量同时传给 extractEntities 和
// processEmbedQueue，避免两次独立查询之间（extractEntities 内部有真实的 NER/主模型网络 I/O
// 耗时）新插入的消息被第二次查询的 LIMIT 窗口纳入，进而被误标记为 embedded 却从未经过实体抽取，
// TDD §3.8"每次最多处理 200 条 pending 记录，分批执行...处理完检查条件是否仍满足，满足则继续下一批"），
// 每批处理完重新评估触发条件，不满足则停止。
//
// getNow 每次循环迭代重新调用（而非在函数入口冻结一次 now），保证 activeConversation 等实时状态
// 在多批次执行期间（Layer 3 主模型调用可能耗时较长）如果用户中途开始聊天，下一次评估能立即感知到
// 并停止，符合 TDD"不占用对话时的计算资源"的设计初衷；测试可传入受控推进的假时钟。
//
// 若某批 embedding 全部失败（processEmbedQueue 返回 processed=0），按 embedQueue.ts 自身的失败补偿
// 语义（"留待下次整理模式运行时重试"，即下次 tick 而非同一 tick 内立即重试）立即停止本次 tick，
// 避免在同一 tick 内对持续失败的 provider 无限重试。
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

    // 当前激活角色的摘要插队检查：这一批 embedding 处理完之后立刻判断当前正在跑的角色是否
    // 满足摘要条件，满足则不等 embedding 队列或其它角色排完，立刻给它生成摘要。不需要额外的
    // "是否已经处理过"标记——如果待摘要消息超过单批上限，下一次循环迭代会再次检测到条件
    // 仍满足并继续插队，直到降到阈值以下，与摘要阶段本身"连续生成多次摘要直到不满足条件"
    // 是同一个自然行为
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

  // 摘要阶段（TDD §3.8 摘要触发逻辑）：与上面的 embedding+实体阶段各自独立触发（不要求
  // pendingCount>100 OR oldestPendingAge>120min 这条 embedding 专用规则），但同样遵守
  // "不与活跃对话抢资源"这条整理模式通用原则——有活跃对话时跳过整个摘要阶段。当前激活角色
  // 已经在上面的 embedding 循环里插队处理过，这里再遍历到它时 shouldTriggerSummary 会因为
  // 待摘要数已经降下去而自然跳过，不会重复生成，不需要专门排除逻辑

  if (!computeActiveConversation(getNow())) {
    for (const sessionId of getSessionsWithPendingSummaries()) {
      // 每次循环重新检查活跃对话状态和触发规则（含消息数），一个 session 的待摘要消息
      // 远超阈值时会连续生成多次摘要，直到降到阈值以下或者活跃对话状态变化为止
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

  // 空闲释放（本次改动新增）：embedding 与 NER 共用同一个"最近 AI 活动"信号（aiActivity.ts），
  // 空闲达到 20 分钟即释放两个模型的显存/内存占用。放在本函数最末尾、embedding+实体批次循环
  // 和摘要循环都已跑完之后再判断，两次 unload 各自独立失败（Promise.allSettled）不影响另一个，
  // 也不让本 tick 抛出
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

// 后台每 5 分钟轮询（TDD §3.8），返回 ScheduledTask 供调用方在进程退出时 .stop()
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
