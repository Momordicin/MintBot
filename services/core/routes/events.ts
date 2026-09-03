import type { FastifyInstance } from 'fastify'
import { registerEventsClient } from '../events/broadcast.js'

// 共享 SSE 广播流（TDD §3.3「SSE 事件类型规范」）：跟具体请求无关、需要多窗口同步感知的
// 状态事件（emotion、system 的广播半边、未来的 proactive）统一走这条连接。客户端的初始状态
// 由既有的 GET /state 负责，这条流只管"之后发生的变化"，因此连接建立后不发送任何初始事件。
export async function eventsRoutes(fastify: FastifyInstance) {
  fastify.get('/events', async (_request, reply) => {
    reply.raw.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    registerEventsClient(reply)
    // 不调用 reply.send()/reply.raw.end()：这条连接需要一直保持打开，直到客户端主动断开
    // （由 broadcast.ts 自己的 close 监听器负责清理），不像 /chat 那样有天然的请求处理终点
  })
}
