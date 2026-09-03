import type { FastifyInstance } from 'fastify'
import { listOllamaModels, getOllamaBaseUrl } from '../providers/ollama.js'
import { getModelProviderConfig } from '../config/index.js'

// Anthropic/OpenAI 没有面向普通用户的"列出可用模型"公开接口（不像 Ollama 的 GET /api/tags
// 能查询本机真实已拉取的模型），因此这里维护一份已知模型名的静态列表，供
// CharacterPanel.tsx §2 的模型名下拉框使用。这份列表需要人工定期更新，不会随上游 API
// 新增/下线模型自动同步——写这份列表时的已知模型名，仅供占位参考
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

    return reply.status(400).send({ error: 'type must be one of ollama|anthropic|openai' })
  })
}
