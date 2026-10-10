// services/core/routes/status.ts — 向量化（embedding）服务是否就绪的探测路由
// 用法：core/index.ts 里 fastify.register(statusRoutes)；GET /embedding-ready，返回 { embeddingReady: boolean }
// 对应文件：src/chat/ChatWindow.tsx（调用方）/ services/core/providers/EmbeddingProvider.ts / services/core/routes/status.test.ts
import type { FastifyInstance } from 'fastify'
import { getAiBaseUrl, isEmbeddingReady } from '../providers/EmbeddingProvider.js'

export async function statusRoutes(fastify: FastifyInstance) {
  fastify.get('/embedding-ready', async () => {
    return { embeddingReady: await isEmbeddingReady(getAiBaseUrl()) }
  })
}
