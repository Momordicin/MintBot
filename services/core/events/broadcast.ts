import type { FastifyReply } from 'fastify'

// GET /events 的共享广播连接注册表：只负责"广播"这个机制本身（谁连着、往谁写），
// 不掺任何"广播什么事件"的业务逻辑——那由各路由（如 chat.ts）在自己的业务逻辑里决定
const clients = new Set<FastifyReply>()

export function registerEventsClient(reply: FastifyReply): void {
  clients.add(reply)
  reply.raw.on('close', () => clients.delete(reply))
}

export function broadcastEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const reply of clients) {
    // 连接已死但 close 事件还没触发（如客户端异常中断），顺手清理，避免继续对已关闭的连接写入
    if (reply.raw.writableEnded || reply.raw.destroyed) {
      clients.delete(reply)
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
    }
  }
}
