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

// 校验通过返回 null，失败返回错误信息（供 400 响应使用）
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

    // 有摘要重叠但调用方没有明确确认时，forgetTimeRange 会抛 ForgetConflictError，
    // 直接带着 ForgetImpact——不在这里再单独调一次 checkForgetImpact 重复查一遍
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
