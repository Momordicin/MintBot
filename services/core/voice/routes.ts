// services/core/voice/routes.ts — 语音识别文字的取走路由
// 用法：core/index.ts 里 fastify.register(voiceRoutes)；POST /voice/take → { texts }，由 src/chat/ChatWindow.tsx 调用
// 对应文件：services/core/voice/agent.ts / src/chat/ChatWindow.tsx / services/core/voice/agent.test.ts
import type { FastifyInstance } from 'fastify'
import { takePending } from './agent.js'

export async function voiceRoutes(fastify: FastifyInstance) {
  fastify.post('/voice/take', async (_request, reply) => {
    return reply.status(200).send({ texts: takePending() })
  })
}
