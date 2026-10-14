// services/core/routes/models.ts — 按提供商类型返回可选模型名列表
// 用法：core/index.ts 里 fastify.register(modelsRoutes)；GET /models?type=ollama|anthropic|openai|deepseek；ollama 实时向 Ollama 查询，其余用全局配置的 API Key 通过 SDK 查询提供方
// 对应文件：src/settings/ModelConfigPanel.tsx / src/settings/useCharacterPanel.ts / services/core/providers/ModelProvider.ts / services/core/providers/ollama.ts / services/core/config/index.ts / services/core/routes/models.test.ts
import type { FastifyInstance } from 'fastify'
import { ensureOllama, listOllamaModels, getOllamaBaseUrl } from '../providers/ollama.js'
import { createAnthropicClient, createOpenAIClient } from '../providers/ModelProvider.js'
import { getModelProviderConfig } from '../config/index.js'

const LIST_REQUEST_OPTIONS = { timeout: 15000, maxRetries: 0 }
const OPENAI_CHAT_PREFIXES = ['gpt-', 'chatgpt-']
const OPENAI_EXCLUDED_KEYWORDS = ['audio', 'realtime', 'transcribe', 'tts', 'image', 'embedding', 'search', 'moderation']

function isOpenAIChatModel(id: string): boolean {
  const isChatId = OPENAI_CHAT_PREFIXES.some(prefix => id.startsWith(prefix)) || /^o\d/.test(id)
  return isChatId && !OPENAI_EXCLUDED_KEYWORDS.some(keyword => id.includes(keyword))
}

async function collectIds(pages: AsyncIterable<{ id: string }>): Promise<string[]> {
  const ids: string[] = []
  for await (const model of pages) ids.push(model.id)
  return ids
}

export async function modelsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { type?: string } }>('/models', async (request, reply) => {
    const { type } = request.query

    if (type === 'ollama') {
      const baseUrl = getOllamaBaseUrl(getModelProviderConfig().ollamaBaseUrl)
      if (!(await ensureOllama(baseUrl))) {
        return { models: [], error: 'Ollama 启动失败' }
      }
      return { models: await listOllamaModels(baseUrl) }
    }

    if (type === 'anthropic' || type === 'openai' || type === 'deepseek') {
      const config = getModelProviderConfig()
      let list: () => AsyncIterable<{ id: string }>
      try {
        if (type === 'anthropic') {
          const client = createAnthropicClient(config)
          list = () => client.models.list(undefined, LIST_REQUEST_OPTIONS)
        } else {
          const client = createOpenAIClient(config, type)
          list = () => client.models.list(LIST_REQUEST_OPTIONS)
        }
      } catch {
        return { models: [], error: 'API key 无效或未配置' }
      }
      try {
        const ids = await collectIds(list())
        const models = (type === 'openai' ? ids.filter(isOpenAIChatModel) : ids).sort()
        return { models }
      } catch (err) {
        console.error(`[models] failed to list ${type} models:`, err)
        return { models: [], error: '获取模型列表失败' }
      }
    }

    return reply.status(400).send({ error: 'type must be one of ollama|anthropic|openai|deepseek' })
  })
}
