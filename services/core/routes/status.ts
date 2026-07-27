import type { FastifyInstance } from 'fastify'
import { getAiBaseUrl, isEmbeddingReady } from '../providers/EmbeddingProvider.js'

// 渲染层高频轮询端点（预热期间每几秒一次 + 窗口聚焦 + 发消息时机），必须保持极轻量：
// 只做一次到 AI 服务 /health 的活体调用，不像 GET /state（buildStatePayload）那样
// 附带情绪状态、embedding 队列等多次 DB 查询
export async function statusRoutes(fastify: FastifyInstance) {
  fastify.get('/embedding-ready', async () => {
    return { embeddingReady: await isEmbeddingReady(getAiBaseUrl()) }
  })
}
