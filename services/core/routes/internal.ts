import type { FastifyInstance } from 'fastify'
import { recordSystemEvent } from '../system/lockState.js'

// 核心服务内部管理接口（TDD §3.2）：Electron 主进程检测到系统事件后通过本地 HTTP 转发，
// 本次只接入锁屏/解锁一条链路，不做语音资源释放等 Phase 3 范围的操作
const VALID_TYPES = new Set(['lock-screen', 'unlock-screen'])

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
}
