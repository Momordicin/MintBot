// services/core/routes/internal.ts — Electron 向 core 上报系统事件与悬浮窗互动的内部路由
// 用法：core/index.ts 里 fastify.register(internalRoutes)；POST /internal/system-event { type: lock-screen | unlock-screen } 记录锁屏状态；POST /internal/overlay-interaction { type: portrait-click | drag-end } 为当前会话 recordAttention
// 对应文件：electron/main/index.ts（notifySystemEvent，来自 powerMonitor）/ src/overlay/OverlayApp.tsx（overlay-interaction）/ services/core/system/lockState.ts / services/core/session/attention.ts / services/core/routes/internal.test.ts
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
