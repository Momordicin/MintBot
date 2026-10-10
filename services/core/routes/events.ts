// services/core/routes/events.ts — 事件流入口：把连接挂成 SSE 长连接并登记为广播订阅者
// 用法：core/index.ts 里 fastify.register(eventsRoutes)；GET /events；连接建立后 registerEventsClient + sendHello，之后事件由 events/broadcast.ts 的 broadcastEvent 推送
// 对应文件：electron/main/index.ts（subscribeToCoreEvents）/ src/chat/ChatWindow.tsx / src/overlay/OverlayApp.tsx / src/settings/WindowBehaviorPanel.tsx / services/core/events/broadcast.ts / services/core/routes/events.test.ts
import type { FastifyInstance } from 'fastify'
import type { OutgoingHttpHeaders } from 'node:http'
import { registerEventsClient, sendHello } from '../events/broadcast.js'

export async function eventsRoutes(fastify: FastifyInstance) {
  fastify.get('/events', async (_request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    reply.raw.flushHeaders()

    registerEventsClient(reply)
    sendHello(reply)
  })
}
