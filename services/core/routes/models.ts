// services/core/routes/models.ts — 按提供商类型返回可选模型名列表
// 用法：core/index.ts 里 fastify.register(modelsRoutes)；GET /models?type=ollama|anthropic|openai|deepseek[&presetId=...]、POST /models
// 对应文件：src/settings/ModelConfigPanel.tsx / src/settings/useCharacterPanel.ts / services/core/providers/ModelProvider.ts / services/core/providers/ollama.ts / services/core/config/index.ts / services/core/session/queries.ts / services/core/routes/models.test.ts
import type { FastifyInstance } from 'fastify'
import { ensureOllama, listOllamaModels, getOllamaBaseUrl } from '../providers/ollama.js'
import { createAnthropicClient, createOpenAIClient } from '../providers/ModelProvider.js'
import { getModelProviderConfig } from '../config/index.js'
import { getPresetById, getPresetApiKeys } from '../session/queries.js'
import type { ModelConfig } from '../../../shared/types/index.js'

type KeyType = 'anthropic' | 'openai' | 'deepseek'

const API_KEY_INVALID_MESSAGE = 'API key 无效或未配置'
const KEY_FIELD = {
  anthropic: { key: 'anthropicApiKey', fromEnv: 'anthropicApiKeyFromEnv' },
  openai: { key: 'openaiApiKey', fromEnv: 'openaiApiKeyFromEnv' },
  deepseek: { key: 'deepseekApiKey', fromEnv: 'deepseekApiKeyFromEnv' },
} as const

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

function isKeyType(type: string | undefined): type is KeyType {
  return type === 'anthropic' || type === 'openai' || type === 'deepseek'
}

function getBaseConfig(type: KeyType): ModelConfig {
  try {
    return getModelProviderConfig()
  } catch {
    return { type }
  }
}

async function listOllama() {
  const baseUrl = getOllamaBaseUrl(getModelProviderConfig().ollamaBaseUrl)
  if (!(await ensureOllama(baseUrl))) {
    return { models: [], error: 'Ollama 启动失败' }
  }
  return { models: await listOllamaModels(baseUrl) }
}

async function listProviderModels(type: KeyType, config: ModelConfig) {
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
    return { models: [], error: API_KEY_INVALID_MESSAGE }
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

export async function modelsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { type?: string; presetId?: string; fromEnv?: string } }>('/models', async (request, reply) => {
    const { type, presetId, fromEnv: fromEnvFlag } = request.query

    if (type === 'ollama') {
      return listOllama()
    }

    if (isKeyType(type)) {
      if (presetId !== undefined && !getPresetById(presetId)) {
        return reply.status(404).send({ error: 'Preset not found' })
      }
      if (fromEnvFlag === '1') {
        return listProviderModels(type, { ...getBaseConfig(type), [KEY_FIELD[type].fromEnv]: true })
      }
      const { key, fromEnv } = KEY_FIELD[type]
      if (presetId === undefined) {
        if (fromEnvFlag === '0') {
          return listProviderModels(type, { ...getBaseConfig(type), [fromEnv]: false })
        }
        return listProviderModels(type, getModelProviderConfig())
      }
      const row = getPresetApiKeys(presetId)[type]
      return listProviderModels(type, { ...getBaseConfig(type), [key]: row.apiKey, [fromEnv]: fromEnvFlag === '0' ? false : row.fromEnv })
    }

    return reply.status(400).send({ error: 'type must be one of ollama|anthropic|openai|deepseek' })
  })

  fastify.post<{ Body: { type?: string; apiKey?: string } }>('/models', async (request, reply) => {
    const { type, apiKey } = request.body ?? {}

    if (type === 'ollama') {
      return listOllama()
    }

    if (isKeyType(type)) {
      const { key, fromEnv } = KEY_FIELD[type]
      const given = typeof apiKey === 'string' ? apiKey.trim() : ''
      return listProviderModels(type, { ...getBaseConfig(type), [key]: given, [fromEnv]: false })
    }

    return reply.status(400).send({ error: 'type must be one of ollama|anthropic|openai|deepseek' })
  })
}
