import type { FastifyInstance } from 'fastify'
import { getCurrentEntitiesPage, getSummaries } from '../session/queries.js'
import { computeEmbeddingQueueStatus } from '../memory/orchestrator.js'
import { VALID_TYPES } from '../memory/entityExtractor.js'
import { getCurrentState } from '../session/index.js'
import type { MessageEntity } from '../../../shared/types/index.js'

const DEFAULT_LIMIT = 20
const MIN_LIMIT = 1
const MAX_LIMIT = 100

export async function memoryRoutes(fastify: FastifyInstance) {
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

  fastify.get('/embedding-queue-status', async () => {
    return computeEmbeddingQueueStatus(Date.now(), getCurrentState()?.session.sessionId ?? null)
  })
}
