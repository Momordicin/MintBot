// services/core/routes/forget.ts — "忘记某时间段记忆"的预检与执行路由
// 用法：core/index.ts 里 fastify.register(forgetRoutes)；POST /forget/check（只算影响范围）、POST /forget（执行删除，可带 alsoDeleteAffectedSummaries；受影响摘要冲突时返回 409 + impact）
// 形状：请求体 { sessionId, fromTime, toTime（毫秒时间戳）, alsoDeleteAffectedSummaries? }
// 对应文件：src/settings/memory/ForgetRangePanel.tsx（调用方）/ services/core/memory/forget.ts / services/core/routes/forget.test.ts
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
