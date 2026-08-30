import type { FastifyInstance } from 'fastify'
import { getCurrentEntitiesPage, getSummaries } from '../session/queries.js'
import { computeEmbeddingQueueStatus } from '../memory/orchestrator.js'
import { VALID_TYPES } from '../memory/entityExtractor.js'
import type { MessageEntity } from '../../../shared/types/index.js'

const DEFAULT_LIMIT = 20
const MIN_LIMIT = 1
const MAX_LIMIT = 100

export async function memoryRoutes(fastify: FastifyInstance) {
  // sessionId 必须由调用方显式传入，理由同 routes/messages.ts 头部注释
  fastify.get<{
    Querystring: { sessionId?: string; type?: string; limit?: string; beforeId?: string }
  }>('/entities', async (request, reply) => {
    const { sessionId, type, limit: limitRaw, beforeId: beforeIdRaw } = request.query

    if (!sessionId?.trim()) {
      return reply.status(400).send({ error: 'sessionId is required' })
    }

    if (type !== undefined && type !== '' && !VALID_TYPES.has(type as MessageEntity['type'])) {
      return reply.status(400).send({ error: 'invalid type' })
    }

    // 空字符串（如 ?limit=）当作"未传"处理，理由同 routes/messages.ts
    let limit = DEFAULT_LIMIT
    if (limitRaw !== undefined && limitRaw !== '') {
      const parsed = Number(limitRaw)
      if (!Number.isFinite(parsed)) {
        return reply.status(400).send({ error: 'limit must be a number' })
      }
      limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(parsed)))
    }

    let beforeId: number | undefined
    if (beforeIdRaw !== undefined && beforeIdRaw !== '') {
      const parsed = Number(beforeIdRaw)
      if (!Number.isInteger(parsed)) {
        return reply.status(400).send({ error: 'beforeId must be an integer' })
      }
      beforeId = parsed
    }

    return getCurrentEntitiesPage(sessionId, limit, beforeId, type ? (type as MessageEntity['type']) : undefined)
  })

  fastify.get<{
    Querystring: { sessionId?: string }
  }>('/summaries', async (request, reply) => {
    const { sessionId } = request.query

    if (!sessionId?.trim()) {
      return reply.status(400).send({ error: 'sessionId is required' })
    }

    return getSummaries(sessionId)
  })

  // 全局统计，不接受 sessionId——computeEmbeddingQueueStatus 本身就是不分 session 的
  // 全局查询（见 orchestrator.ts）
  fastify.get('/embedding-queue-status', async () => {
    return computeEmbeddingQueueStatus()
  })
}
