// services/core/routes/models.ts — 按提供商类型返回可选模型名列表
// 用法：core/index.ts 里 fastify.register(modelsRoutes)；GET /models?type=ollama|anthropic|openai|deepseek；ollama 实时向 Ollama 查询，其余返回内置列表
// 形状：{ models: string[] }；type 不合法返回 400
// 对应文件：src/settings/CharacterPanel.tsx（调用方）/ services/core/providers/ollama.ts / services/core/config/index.ts / services/core/routes/models.test.ts
import type { FastifyInstance } from 'fastify'
import { listOllamaModels, getOllamaBaseUrl } from '../providers/ollama.js'
import { getModelProviderConfig } from '../config/index.js'

const KNOWN_ANTHROPIC_MODELS = [
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
]

const KNOWN_OPENAI_MODELS = [
  'gpt-5',
  'gpt-5-mini',
  'gpt-4o',
  'gpt-4o-mini',
]

const KNOWN_DEEPSEEK_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-vision-exp',
]

export async function modelsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { type?: string } }>('/models', async (request, reply) => {
    const { type } = request.query

    if (type === 'ollama') {
      const baseUrl = getOllamaBaseUrl(getModelProviderConfig().ollamaBaseUrl)
      return { models: await listOllamaModels(baseUrl) }
    }
    if (type === 'anthropic') {
      return { models: KNOWN_ANTHROPIC_MODELS }
    }
    if (type === 'openai') {
      return { models: KNOWN_OPENAI_MODELS }
    }
    if (type === 'deepseek') {
      return { models: KNOWN_DEEPSEEK_MODELS }
    }

    return reply.status(400).send({ error: 'type must be one of ollama|anthropic|openai|deepseek' })
  })
}
