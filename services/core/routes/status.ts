import type { FastifyInstance } from 'fastify'
import { getAiBaseUrl, isEmbeddingReady } from '../providers/EmbeddingProvider.js'

export async function statusRoutes(fastify: FastifyInstance) {
  fastify.get('/embedding-ready', async () => {
    return { embeddingReady: await isEmbeddingReady(getAiBaseUrl()) }
  })
}
