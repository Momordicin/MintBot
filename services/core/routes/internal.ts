import type { FastifyInstance } from 'fastify'
import { recordSystemEvent } from '../system/lockState.js'

// 核心服务内部管理接口（TDD §3.2）：Electron 主进程检测到系统事件后通过本地 HTTP 转发。
// 锁屏/解锁不再驱动悬浮窗立绘（TDD §3.3「悬浮窗立绘状态相关接口」：POST /internal/system-event
// 仅保留锁屏时长计时的职责），这里只喂给 recordSystemEvent 供 getLockScreenMinutes 计时，
// 继而驱动 §3.8 摘要触发；不做语音资源释放等 Phase 4 范围的操作（Phase 3 checklist"锁屏/
// 息屏静息模式"：语音资源释放/停止输入监听 TDD 原文自己写"待定"，且 Phase 4 语音功能还没做，
// 无资源可释放、无输入可停止）
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
