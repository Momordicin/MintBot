// services/core/routes/models.ts — 按提供商类型返回可选模型名列表
// 用法：core/index.ts 里 fastify.register(modelsRoutes)；GET /models?type=ollama|anthropic|openai|deepseek|custom[&presetId=...][&fromEnv=1|0][&purpose=summary]、POST /models
// 对应文件：src/settings/ModelConfigPanel.tsx / src/settings/useCharacterPanel.ts / services/core/providers/ModelProvider.ts / services/core/providers/ollama.ts / services/core/config/index.ts / services/core/session/queries.ts / services/core/routes/models.test.ts / services/core/routes/config.ts / shared/errorCodes.ts
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { FastifyInstance } from 'fastify'
import { ensureOllama, listOllamaModels, getOllamaBaseUrl, isLocalOllamaUrl } from '../providers/ollama.js'
import { createAnthropicClient, createOpenAIClient } from '../providers/ModelProvider.js'
import { getModelProviderConfig } from '../config/index.js'
import { getPresetById, getPresetApiKeys } from '../session/queries.js'
import type { ModelConfig } from '../../../shared/types/index.js'
import { ERROR_CODES, errorBody, invalidRequest, type ErrorBody } from '../../../shared/errorCodes.js'
import { customUrlRoot } from '../../../shared/customUrl.js'

type KeyType = 'anthropic' | 'openai' | 'deepseek'

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

export function getBaseConfig(type: KeyType | 'custom'): ModelConfig {
  try {
    return getModelProviderConfig()
  } catch {
    return { type }
  }
}

async function listOllama() {
  const baseUrl = getOllamaBaseUrl(getModelProviderConfig().ollamaBaseUrl)
  if (!(await ensureOllama(baseUrl))) {
    const code = isLocalOllamaUrl(baseUrl) ? ERROR_CODES.OLLAMA_START_FAILED : ERROR_CODES.PROVIDER_UNREACHABLE
    return { models: [], ...errorBody(code) }
  }
  return { models: await listOllamaModels(baseUrl) }
}

type ModelListResult = { models: string[] } | ({ models: string[] } & ErrorBody)

async function listCustomModels(config: ModelConfig): Promise<ModelListResult> {
  const format = config.customFormat ?? 'openai'
  const root = config.customUrl ? customUrlRoot(config.customUrl, format) : null
  if (!root) return { models: [], ...errorBody(ERROR_CODES.CUSTOM_URL_MISSING) }
  const headers: Record<string, string> = format === 'anthropic'
    ? { 'anthropic-version': '2023-06-01', ...(config.customApiKey ? { 'x-api-key': config.customApiKey } : {}) }
    : (config.customApiKey ? { Authorization: `Bearer ${config.customApiKey}` } : {})
  let response: Response
  try {
    response = await fetch(`${root}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(LIST_REQUEST_OPTIONS.timeout),
    })
  } catch (err) {
    console.error('[models] failed to list custom models:', err)
    return { models: [], ...errorBody(ERROR_CODES.PROVIDER_UNREACHABLE) }
  }
  if (response.status === 401 || response.status === 403) return { models: [], ...errorBody(ERROR_CODES.API_KEY_INVALID) }
  try {
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const json = await response.json() as { data?: unknown }
    if (!Array.isArray(json?.data)) throw new Error('response has no data array')
    const ids = json.data
      .map((model: unknown) => (model && typeof model === 'object' && typeof (model as { id?: unknown }).id === 'string' ? (model as { id: string }).id : null))
      .filter((id: string | null): id is string => id !== null)
    return { models: ids.sort() }
  } catch (err) {
    console.error('[models] failed to list custom models:', err)
    return { models: [], ...errorBody(ERROR_CODES.MODEL_LIST_FAILED) }
  }
}

export async function listProviderModels(type: KeyType | 'custom', config: ModelConfig): Promise<ModelListResult> {
  if (type === 'custom') return listCustomModels(config)
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
    return { models: [], ...errorBody(ERROR_CODES.API_KEY_INVALID) }
  }
  try {
    const ids = await collectIds(list())
    const models = (type === 'openai' ? ids.filter(isOpenAIChatModel) : ids).sort()
    return { models }
  } catch (err) {
    console.error(`[models] failed to list ${type} models:`, err)
    const status = (err as { status?: unknown }).status
    if (status === 401 || status === 403) return { models: [], ...errorBody(ERROR_CODES.API_KEY_INVALID) }
    if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
      return { models: [], ...errorBody(ERROR_CODES.PROVIDER_UNREACHABLE) }
    }
    return { models: [], ...errorBody(ERROR_CODES.MODEL_LIST_FAILED) }
  }
}

export async function modelsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { type?: string; presetId?: string; fromEnv?: string; purpose?: string } }>('/models', async (request, reply) => {
    const { type, presetId, fromEnv: fromEnvFlag, purpose } = request.query

    if (type === 'ollama') {
      return listOllama()
    }

    if (type === 'custom') {
      if (presetId === undefined) return listProviderModels('custom', getBaseConfig('custom'))
      if (!getPresetById(presetId)) {
        return reply.status(404).send(errorBody(ERROR_CODES.PRESET_NOT_FOUND))
      }
      const row = getPresetApiKeys(presetId).custom
      const savedKey = purpose === 'summary' ? row.summaryApiKey : row.apiKey
      return listProviderModels('custom', { ...getBaseConfig('custom'), customApiKey: savedKey })
    }

    if (isKeyType(type)) {
      if (presetId !== undefined && !getPresetById(presetId)) {
        return reply.status(404).send(errorBody(ERROR_CODES.PRESET_NOT_FOUND))
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
      const useSummary = purpose === 'summary'
      const savedKey = useSummary ? row.summaryApiKey : row.apiKey
      const savedFromEnv = useSummary ? row.summaryFromEnv : row.fromEnv
      return listProviderModels(type, { ...getBaseConfig(type), [key]: savedKey, [fromEnv]: fromEnvFlag === '0' ? false : savedFromEnv })
    }

    return reply.status(400).send(invalidRequest('type must be one of ollama|anthropic|openai|deepseek|custom'))
  })

  fastify.post<{ Body: { type?: string; apiKey?: string } }>('/models', async (request, reply) => {
    const { type, apiKey } = request.body ?? {}

    if (type === 'ollama') {
      return listOllama()
    }

    if (type === 'custom') {
      const given = typeof apiKey === 'string' ? apiKey.trim() : ''
      return listProviderModels('custom', { ...getBaseConfig('custom'), customApiKey: given || undefined })
    }

    if (isKeyType(type)) {
      const { key, fromEnv } = KEY_FIELD[type]
      const given = typeof apiKey === 'string' ? apiKey.trim() : ''
      return listProviderModels(type, { ...getBaseConfig(type), [key]: given, [fromEnv]: false })
    }

    return reply.status(400).send(invalidRequest('type must be one of ollama|anthropic|openai|deepseek|custom'))
  })
}
