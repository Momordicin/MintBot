import type { FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { HEARTBEAT_INTERVAL_MS } from '../../../shared/eventsLiveness.js'

// GET /events 的共享广播连接注册表：只负责"广播"这个机制本身（谁连着、往谁写），
// 不掺任何"广播什么事件"的业务逻辑——那由各路由（如 chat.ts）在自己的业务逻辑里决定
const clients = new Set<FastifyReply>()

// 服务器代次：进程每次启动时生成一次的随机 id，不持久化、也不是递增计数器——它唯一的职责
// 是让客户端区分"同一个核心服务进程，我只是刚重连上"与"核心服务换过一次进程（重启/崩溃
// 恢复），我手上缓存的状态可能已经过期到任意程度"。客户端（electron/main/index.ts、
// src/chat/ChatWindow.tsx、src/overlay/OverlayApp.tsx）各自记录上一次看到的值，仅用于诊断
// 日志——是否触发一次全量收敛现在由"这条连接是否刚刚建立/重连"决定，不再由 generation 是否
// 变化决定（generation 网关曾经被实现过，review 中发现它无法感知"连接断线期间错过一次广播"
// 这种过期成因，已改回"每次连接建立都无条件收敛"）。见 docs/MintBot_TDD.md §3.3
// 「hello / heartbeat」与「服务器代次与状态收敛」
export const SERVER_GENERATION = randomUUID()

// 心跳间隔：数值取自 WHATWG HTML 标准 Server-Sent Events 一节 Authoring notes 的建议
// ("every 15 seconds or so")——那条建议的本意是防止年代久远的中间代理把"看起来空闲"的连接
// 悄悄断掉。本项目 GET /events 是同机 loopback（Electron 主进程/各渲染进程窗口 ↔ 本机核心
// 服务），中间不存在任何代理，这个数字在这里的真正消费方是三个客户端各自的存活判断：都拿
// 它的 3 倍作为判定连接已死的超时阈值（EVENTS_CLIENT_TIMEOUT_MS，定义处见下方 import）。
//
// 没有走 Discord 那种"服务端在 Hello 里声明 heartbeat_interval，客户端读到后再据此设置自己
// 的超时"的做法：客户端必须在能够读到 hello 帧之前就先设好自己的 body 超时（不然 hello 帧
// 本身迟迟不来时，客户端没有任何依据判断该等多久），把间隔放在 hello 帧的数据里并不能省掉
// "客户端本地也要有一份这个常数"这件事。
//
// 数值本身定义在 shared/eventsLiveness.ts，这里重新导出：services/core（本文件）、
// electron/main（eventsGeneration.ts）、两个渲染进程窗口（src/eventsWatchdog.ts）三层现在
// 都从那一份定义 import，不再各自维护一份独立字面量——此前三层各写一遍 15000、靠注释
// 互相提醒"改一处记得改另一处"的做法已经被这次改动关掉，见 shared/eventsLiveness.ts 顶部
// 注释「反转记录」
export { HEARTBEAT_INTERVAL_MS }

// 单个共享定时器，不是每个客户端各起一个——不论多少个客户端连着，心跳广播只有一份。
// 懒启动：第一个客户端注册时才开始；清零：最后一个客户端断开时立刻停，不留着一个零客户端
// 还在空转的定时器
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

function startHeartbeatIfNeeded(): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    broadcastEvent('heartbeat', { generation: SERVER_GENERATION })
  }, HEARTBEAT_INTERVAL_MS)
  // unref：这个定时器本身不构成"进程还有工作要做"的理由。核心服务是否应该继续运行由真正
  // 的业务（Fastify 监听的 socket 等）决定，不能因为心跳定时器还挂在事件循环里而拖住进程
  // 退出——尤其是 tsx watch 保存触发重启、或测试进程结束这类场景，不 unref 会让它们多等
  // 一个心跳周期才能真正退出
  heartbeatTimer.unref()
}

function stopHeartbeatIfIdle(): void {
  if (clients.size > 0) return
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

export function registerEventsClient(reply: FastifyReply): void {
  clients.add(reply)
  reply.raw.on('close', () => {
    clients.delete(reply)
    stopHeartbeatIfIdle()
  })
  startHeartbeatIfNeeded()
}

function formatFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// 连接建立后立即发送的一次性 hello 帧（TDD §3.3，routes/events.ts 在 registerEventsClient
// 之后紧接着调用）：只写给刚注册的这一个客户端，不广播给其它已连接的客户端——跟
// broadcastEvent 是两件不同的事，只是共享同一套帧格式（formatFrame），传输目标不同。
// 写入前后与 broadcastEvent 循环体内单个客户端的写入用同一套防御（writableEnded/destroyed
// 判活 + try/catch）：这个函数被调用时距离 routes/events.ts 里的 flushHeaders() 只有一次
// registerEventsClient() 调用、中间没有任何 await，理论上此刻这个连接不可能已经死了，但
// 显式加同一套防御成本极低，能防住日后有人在这两步之间插入一次 await 而不小心破坏这个
// 隐含前提
export function sendHello(reply: FastifyReply): void {
  if (reply.raw.writableEnded || reply.raw.destroyed) return
  try {
    reply.raw.write(formatFrame('hello', { generation: SERVER_GENERATION }))
  } catch (err) {
    console.error('[Events] Failed to write hello frame to a new client:', err)
  }
}

// 不加 id: 字段、不实现 Last-Event-ID 重放、不做服务端事件缓冲：这条流上的三种载荷
// （emotion/window-behavior-changed/preset-switched，以及本次新增的 hello/heartbeat）全部
// 是"当前状态"而不是"离散日志事件"——丢失中间值无害，只要客户端最终能收敛到最新值。缺连接
// 期间发生的变化，正确的补救是"重新做一次权威读"（GET /state、GET /config/window-behavior
// 等），而不是把丢失的那几帧回放出来；一份服务端事件缓冲只会带来"缓冲多大合适""缓冲过期后
// 怎么降级"这些额外的复杂度，换不来任何这里真正需要的收益。这是本次改动评估过并明确放弃的
// 方向，见 docs/MintBot_TDD.md §3.3
export function broadcastEvent(event: string, data: unknown): void {
  const payload = formatFrame(event, data)
  for (const reply of clients) {
    // 连接已死但 close 事件还没触发（如客户端异常中断），顺手清理，避免继续对已关闭的连接写入。
    // 顺带调用 stopHeartbeatIfIdle()：这次顺手清理有可能恰好清掉最后一个客户端，若不在这里
    // 也检查一次，心跳定时器会在"注册表已空但没有任何客户端触发过 close"这段时间里空转，
    // 直到真正的 close 事件（不论多晚）才会被停掉——调用本身是幂等的廉价检查，不额外增加复杂度
    if (reply.raw.writableEnded || reply.raw.destroyed) {
      clients.delete(reply)
      stopHeartbeatIfIdle()
      continue
    }
    // 每个客户端的写入单独 try/catch：这些客户端互不相关，某一个写入失败（如底层 socket
    // 突然出错）不该抛出并中断整个循环——否则排在它之后的客户端会平白无故收不到这次广播，
    // 而调用方（如 chat.ts）目前是在处理某次具体 /chat 请求时顺带触发广播，未捕获的异常
    // 冒泡回去会被误判成"这次模型调用失败"，往请求方自己的私有流发一条不相关的错误
    try {
      reply.raw.write(payload)
    } catch (err) {
      console.error('[Events] Failed to write to a broadcast client, dropping it:', err)
      clients.delete(reply)
      stopHeartbeatIfIdle()
    }
  }
}
