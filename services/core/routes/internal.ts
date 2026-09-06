import type { FastifyInstance } from 'fastify'
import { recordSystemEvent } from '../system/lockState.js'
import { getCurrentState } from '../session/index.js'
import { recordAttention } from '../session/attention.js'

// 核心服务内部管理接口（TDD §3.2）：Electron 主进程检测到系统事件后通过本地 HTTP 转发。
// 锁屏/解锁不再驱动悬浮窗立绘（TDD §3.3「悬浮窗立绘状态相关接口」：POST /internal/system-event
// 仅保留锁屏时长计时的职责），这里只喂给 recordSystemEvent 供 getLockScreenMinutes 计时，
// 继而驱动 §3.8 摘要触发。「停止输入监听」按 TDD §2.3 拆成两项分别推进：Win32 前台窗口轮询
// 已在锁屏期间暂停（由主进程 powerMonitor 的 lock-screen/unlock-screen 处理器直接停止/
// 重启 activeWindowMonitor，见 electron/main/index.ts，不经过这条路由）；语音输入监听待
// Phase 4 语音链路就位后再处理，当前无输入可停止
const VALID_TYPES = new Set(['lock-screen', 'unlock-screen'])

// 悬浮窗侧「搭理 bot」的两种交互（TDD §3.3「悬浮窗立绘状态相关接口」/ §3.7 附「「搭理 bot」的
// 三种交互」）：点击小人与拖拽结束。两者都只是刷新「上次搭理时刻」+ 清除显式睡着标记
// （recordAttention 已经实现两件事，这里不重复），本轮不做按 type 区分的行为——两个取值只是
// 让上报载荷自描述、可校验，不是扩展点。
// 调用方是**悬浮窗渲染层**，两种交互都由它自己 POST（TDD §3.3「悬浮窗侧的两种交互……通过它
// 刷新」）。拖拽起止时刻虽然由主进程的 hookWindowMessage 侦测（TDD §3.7 附「拖拽的实现
// 方式」），但主进程只把原始 WM 消息经 IPC 转发给渲染层、不碰这个端点（§3.2「主进程只转发
// 原始系统信号，不承载业务逻辑」）——这一点与 system-event 那条**不同**，别照着那条在主进程
// 侧再补一次 HTTP 调用，会把同一次搭理重复计数
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
