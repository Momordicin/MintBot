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
