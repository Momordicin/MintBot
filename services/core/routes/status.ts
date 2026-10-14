// services/core/routes/status.ts — AI 服务是否可用的探测路由
// 用法：core/index.ts 里 fastify.register(statusRoutes)；GET /ai-available
// 对应文件：src/chat/ChatWindow.tsx（调用方）/ services/core/providers/EmbeddingProvider.ts / services/core/routes/status.test.ts
import type { FastifyInstance } from 'fastify'
import { getAiBaseUrl, isAiServiceAvailable } from '../providers/EmbeddingProvider.js'

export async function statusRoutes(fastify: FastifyInstance) {
  fastify.get('/ai-available', async () => {
    return { aiAvailable: await isAiServiceAvailable(getAiBaseUrl()) }
  })
}
