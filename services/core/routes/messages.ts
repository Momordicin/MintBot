import type { FastifyInstance } from 'fastify'
import { getMessagesPage } from '../session/queries.js'

const DEFAULT_LIMIT = 20
const MIN_LIMIT = 1
const MAX_LIMIT = 100

export async function messageRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Querystring: { sessionId?: string; limit?: string; beforeId?: string }
  }>('/messages', async (request, reply) => {
    const { sessionId, limit: limitRaw, beforeId: beforeIdRaw } = request.query

    if (!sessionId?.trim()) {
      return reply.status(400).send({ error: 'sessionId is required' })
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

    return getMessagesPage(sessionId, limit, beforeId)
  })
}
