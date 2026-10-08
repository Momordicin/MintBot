import type { FastifyInstance } from 'fastify'
import { recordSystemEvent } from '../system/lockState.js'
import { getCurrentState } from '../session/index.js'
import { recordAttention } from '../session/attention.js'

const VALID_TYPES = new Set(['lock-screen', 'unlock-screen'])

const VALID_INTERACTION_TYPES = new Set(['portrait-click', 'drag-end'])

export async function internalRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { type: string }
  }>('/internal/system-event', async (request, reply) => {
    const { type } = request.body
    if (!VALID_TYPES.has(type)) {
      return reply.status(400).send({ error: 'Invalid system event type' })
    }

    recordSystemEvent(type as 'lock-screen' | 'unlock-screen')

    return reply.status(200).send({ ok: true })
  })

  fastify.post<{
    Body: { type: string }
  }>('/internal/overlay-interaction', async (request, reply) => {
    const { type } = request.body
    if (!VALID_INTERACTION_TYPES.has(type)) {
      return reply.status(400).send({ error: 'Invalid overlay interaction type' })
    }

    const state = getCurrentState()
    if (state) {
      recordAttention(state.session.sessionId)
    }

    return reply.status(200).send({ ok: true })
  })
}
