import type { FastifyInstance } from 'fastify'
import { getMessagesPage } from '../session/queries.js'

const DEFAULT_LIMIT = 20
const MIN_LIMIT = 1
const MAX_LIMIT = 100

export async function messageRoutes(fastify: FastifyInstance) {
  // sessionId 必须由调用方显式传入，不读全局"当前 session"单例——理由同
  // session/index.ts 里 addMessage 头部注释：请求处理期间可能发生 preset 切换，
  // 读全局状态会读到错误的 session
  fastify.get<{
    Querystring: { sessionId?: string; limit?: string; beforeId?: string }
  }>('/messages', async (request, reply) => {
    const { sessionId, limit: limitRaw, beforeId: beforeIdRaw } = request.query

    if (!sessionId?.trim()) {
      return reply.status(400).send({ error: 'sessionId is required' })
    }

    // 空字符串（如 ?limit=）当作"未传"处理，而不是走 Number('') === 0 落入 MIN_LIMIT/
    // 变成合法游标 0——这两种情况都会让调用方在没打算传参数时得到意外结果
    let limit = DEFAULT_LIMIT
    if (limitRaw !== undefined && limitRaw !== '') {
      const parsed = Number(limitRaw)
      if (!Number.isFinite(parsed)) {
        return reply.status(400).send({ error: 'limit must be a number' })
      }
      // 裁剪到合理范围，防止恶意大值一次性把过多消息拉出来
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
