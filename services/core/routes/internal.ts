import type { FastifyInstance } from 'fastify'
import { recordSystemEvent } from '../system/lockState.js'
import { getCurrentState } from '../session/index.js'
import { recordAttention } from '../session/attention.js'

// 核心服务内部管理接口（TDD §3.2）：Electron 主进程检测到系统事件后通过本地 HTTP 转发。
// 锁屏/解锁不再驱动悬浮窗立绘（TDD §3.3「悬浮窗立绘状态相关接口」：POST /internal/system-event
// 仅保留锁屏时长计时的职责），这里只喂给 recordSystemEvent 供 getLockScreenMinutes 计时，
// 继而驱动 §3.8 摘要触发；不做语音资源释放等 Phase 4 范围的操作（Phase 3 checklist"锁屏/
// 息屏静息模式"：语音资源释放/停止输入监听 TDD 原文自己写"待定"，且 Phase 4 语音功能还没做，
// 无资源可释放、无输入可停止）
const VALID_TYPES = new Set(['lock-screen', 'unlock-screen'])

// 悬浮窗侧「搭理 bot」的两种交互（TDD §3.3「悬浮窗立绘状态相关接口」/ §3.7 附「「搭理 bot」的
// 三种交互」）：点击小人与拖拽结束。两者都只是刷新「上次搭理时刻」+ 清除显式睡着标记
// （recordAttention 已经实现两件事，这里不重复），本轮不做按 type 区分的行为——两个取值只是
// 让上报载荷自描述、可校验，不是扩展点。拖拽起止时刻由主进程 hookWindowMessage 侦测
// （TDD §3.7 附「拖拽的实现方式」），因此主进程也是这个 /internal/ 端点的真实调用方，
// 与既有的 system-event 同理
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

    // 没有激活 session 时无处刷新，什么都不做——这不是错误，悬浮窗/主进程侧不需要感知
    // 是否存在活跃 session
    const state = getCurrentState()
    if (state) {
      recordAttention(state.session.sessionId)
    }

    return reply.status(200).send({ ok: true })
  })
}
