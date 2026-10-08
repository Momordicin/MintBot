import type { FastifyInstance } from 'fastify'
import { checkForgetImpact, forgetTimeRange, ForgetConflictError } from '../memory/forget.js'

interface ForgetCheckBody {
  sessionId?: string
  fromTime?: number
  toTime?: number
}

interface ForgetBody extends ForgetCheckBody {
  alsoDeleteAffectedSummaries?: boolean
}

function validateTimeRange(body: ForgetCheckBody): string | null {
  if (!body.sessionId?.trim()) {
    return 'sessionId is required'
  }
  if (typeof body.fromTime !== 'number' || !Number.isFinite(body.fromTime)) {
    return 'fromTime must be a number'
  }
  if (typeof body.toTime !== 'number' || !Number.isFinite(body.toTime)) {
    return 'toTime must be a number'
  }
  if (body.fromTime > body.toTime) {
    return 'fromTime must not be greater than toTime'
  }
  return null
}

export async function forgetRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: ForgetCheckBody }>('/forget/check', async (request, reply) => {
    const error = validateTimeRange(request.body)
    if (error) {
      return reply.status(400).send({ error })
    }

    const { sessionId, fromTime, toTime } = request.body as Required<ForgetCheckBody>
    return checkForgetImpact(sessionId, fromTime, toTime)
  })

  fastify.post<{ Body: ForgetBody }>('/forget', async (request, reply) => {
    const error = validateTimeRange(request.body)
    if (error) {
      return reply.status(400).send({ error })
    }

    const { sessionId, fromTime, toTime, alsoDeleteAffectedSummaries } = request.body as Required<ForgetCheckBody> & ForgetBody

    try {
      return forgetTimeRange(sessionId, fromTime, toTime, {
        alsoDeleteAffectedSummaries: alsoDeleteAffectedSummaries === true,
      })
    } catch (err) {
      if (err instanceof ForgetConflictError) {
        return reply.status(409).send(err.impact)
      }
      throw err
    }
  })
}
