import type { FastifyInstance } from 'fastify'
import { recordSystemEvent } from '../system/lockState.js'
import { getCurrentState } from '../session/index.js'
import { getEmotionState } from '../session/queries.js'
import { broadcastEvent } from '../events/broadcast.js'

// 核心服务内部管理接口（TDD §3.2）：Electron 主进程检测到系统事件后通过本地 HTTP 转发，
// 本次接入锁屏/解锁 + 悬浮窗静息模式（切换至 sleep 立绘），不做语音资源释放等 Phase 4
// 范围的操作（Phase 3 checklist"锁屏/息屏静息模式"：语音资源释放/停止输入监听 TDD 原文
// 自己写"待定"，且 Phase 4 语音功能还没做，无资源可释放、无输入可停止）
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

    const state = getCurrentState()
    if (state) {
      if (type === 'lock-screen') {
        // 故意不落库（不调 upsertEmotionState）：sleep 不是角色真实感受到的情绪，只是
        // 锁屏期间的系统展示状态，写进 DB 会污染真实情绪历史，也会让 buildContext 下次
        // 拼 prompt 时把"sleep"当成角色自己的真实情绪喂给模型——只广播，不持久化，
        // 解锁后才能干净地恢复成锁屏前的真实状态
        broadcastEvent('emotion', { self: { label: 'sleep', intensity: 1 }, perceived_user: null })
      } else {
        // 解锁：锁屏期间从未写过库，这里读到的就是锁屏前最后一次真实持久化的情绪
        // （没有记录过则为 null，广播出去后 OverlayApp.tsx 的 fallback 逻辑会兜底）
        const emotion = getEmotionState(state.session.sessionId)
        broadcastEvent('emotion', emotion ?? { self: null, perceived_user: null })
      }
    }

    return reply.status(200).send({ ok: true })
  })
}
