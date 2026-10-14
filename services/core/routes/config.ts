// services/core/routes/config.ts — 模型配置的读取与修改路由
// 用法：core/index.ts 注册 configRoutes；GET /config/model、PATCH /config/model
// 对应文件：src/settings/ModelConfigPanel.tsx / services/core/config/index.ts / services/core/providers/envCredentials.ts / services/core/routes/config.test.ts
import type { FastifyInstance } from 'fastify'
import {
  getModelProviderConfig,
  getBackgroundModelProviderConfig,
  getRawBackgroundModelProviderConfig,
  updateModelProviderConfig,
  updateBackgroundModelProviderConfig,
  type BackgroundModelConfig,
} from '../config/index.js'
import { ConfigFileUnreadableError, CONFIG_FILE_UNREADABLE_MESSAGE } from '../config/configFileError.js'
import { createModelProvider } from '../providers/ModelProvider.js'
import { ENV_VAR_BY_PROVIDER, isEnvCredentialDetected, type KeyProvider } from '../providers/envCredentials.js'
import type { ModelConfig } from '../../../shared/types/index.js'

const VALID_MODEL_TYPES: readonly string[] = ['anthropic', 'openai', 'ollama', 'deepseek']
const MIN_MAX_TOKENS = 1
const MAX_MAX_TOKENS = 32000
const KEY_PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai', 'deepseek']
const API_KEY_INVALID_MESSAGE = 'API key 无效或未配置'
const MIN_LAST4_KEY_LENGTH = 8

const KEY_FIELD = {
  anthropic: { key: 'anthropicApiKey', fromEnv: 'anthropicApiKeyFromEnv' },
  openai: { key: 'openaiApiKey', fromEnv: 'openaiApiKeyFromEnv' },
  deepseek: { key: 'deepseekApiKey', fromEnv: 'deepseekApiKeyFromEnv' },
} as const

interface KeySummary {
  hasKey: boolean
  last4: string | null
  fromEnv: boolean
  envDetected: boolean
}

export interface ModelConfigSummary {
  type: 'anthropic' | 'openai' | 'ollama' | 'deepseek'
  modelName?: string
  ollamaModel?: string
  ollamaBaseUrl?: string
  openaiBaseUrl?: string
  deepseekBaseUrl?: string
  maxTokens?: number
  keys: Record<KeyProvider, KeySummary>
}

export interface BackgroundModelSummary {
  type: 'anthropic' | 'openai' | 'ollama' | 'deepseek'
  modelName?: string
  ollamaModel?: string
}

function summarizeKey(config: ModelConfig, provider: KeyProvider): KeySummary {
  const { key, fromEnv } = KEY_FIELD[provider]
  const saved = config[key]
  const hasKey = typeof saved === 'string' && saved.length > 0
  return {
    hasKey,
    last4: hasKey && saved.length >= MIN_LAST4_KEY_LENGTH ? saved.slice(-4) : null,
    fromEnv: config[fromEnv] === true,
    envDetected: isEnvCredentialDetected(provider),
  }
}

function toSummary(config: ModelConfig): ModelConfigSummary {
  return {
    type: config.type,
    modelName: config.modelName,
    ollamaModel: config.ollamaModel,
    ollamaBaseUrl: config.ollamaBaseUrl,
    openaiBaseUrl: config.openaiBaseUrl,
    deepseekBaseUrl: config.deepseekBaseUrl,
    maxTokens: config.maxTokens,
    keys: {
      anthropic: summarizeKey(config, 'anthropic'),
      openai: summarizeKey(config, 'openai'),
      deepseek: summarizeKey(config, 'deepseek'),
    },
  }
}

function toBackgroundSummary(config: BackgroundModelConfig): BackgroundModelSummary {
  return { type: config.type, modelName: config.modelName, ollamaModel: config.ollamaModel }
}

function isProviderConfigured(global: Partial<ModelConfig>, provider: KeyProvider): boolean {
  const { key, fromEnv } = KEY_FIELD[provider]
  if (global[fromEnv] === true) return isEnvCredentialDetected(provider)
  const saved = global[key]
  return typeof saved === 'string' && saved.length > 0
}

function validateProviderSelection(selected: Partial<ModelConfig>, global: Partial<ModelConfig>): string | null {
  const trimmedModelName = selected.modelName?.trim()
  if (selected.type === 'ollama') {
    if (!selected.ollamaModel) return 'ollamaModel is required when type is ollama'
    return null
  }
  if (selected.type === 'anthropic' || selected.type === 'openai' || selected.type === 'deepseek') {
    if (!isProviderConfigured(global, selected.type)) return API_KEY_INVALID_MESSAGE
    if (!trimmedModelName) return `modelName is required when type is ${selected.type}`
    return null
  }
  return 'type is required'
}

function dropEmptyKeys(partial: Partial<ModelConfig> | undefined): Partial<ModelConfig> | undefined {
  if (!partial || typeof partial !== 'object') return partial
  const cleaned = { ...partial }
  for (const provider of KEY_PROVIDERS) {
    const field = KEY_FIELD[provider].key
    const value = cleaned[field]
    if (typeof value === 'string' && value.trim() === '') delete cleaned[field]
  }
  return cleaned
}

function validateType(type: string | undefined): string | null {
  if (type !== undefined && !VALID_MODEL_TYPES.includes(type)) {
    return 'type must be one of anthropic, openai, ollama, deepseek'
  }
  return null
}

function validateGlobalPartial(partial: Partial<ModelConfig>, current: Partial<ModelConfig>): string | null {
  const typeError = validateType(partial.type)
  if (typeError) return typeError

  if (partial.maxTokens !== undefined) {
    if (!Number.isInteger(partial.maxTokens) || partial.maxTokens < MIN_MAX_TOKENS || partial.maxTokens > MAX_MAX_TOKENS) {
      return `maxTokens must be an integer between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}`
    }
  }

  for (const provider of KEY_PROVIDERS) {
    const flag = KEY_FIELD[provider].fromEnv
    if (partial[flag] === true && current[flag] !== true && !isEnvCredentialDetected(provider)) {
      return `未检测到环境变量 ${ENV_VAR_BY_PROVIDER[provider]}`
    }
  }

  const merged = { ...current, ...partial }
  return validateProviderSelection(merged, merged)
}

function validateBackgroundPartial(
  partial: Partial<ModelConfig>,
  current: Partial<ModelConfig>,
  mergedGlobal: Partial<ModelConfig>
): string | null {
  const typeError = validateType(partial.type)
  if (typeError) return typeError
  return validateProviderSelection({ ...current, ...partial }, mergedGlobal)
}

function pickBackgroundPartial(partial: Partial<ModelConfig>): Partial<ModelConfig> {
  const picked: Partial<ModelConfig> = {}
  if (partial.type !== undefined) picked.type = partial.type
  if (partial.modelName !== undefined) picked.modelName = partial.modelName
  if (partial.ollamaModel !== undefined) picked.ollamaModel = partial.ollamaModel
  return picked
}

export async function configRoutes(fastify: FastifyInstance) {
  fastify.get('/config/model', async () => {
    let modelProvider: ModelConfigSummary | null = null
    try {
      modelProvider = toSummary(getModelProviderConfig())
    } catch {
      modelProvider = null
    }

    const rawBackground = getRawBackgroundModelProviderConfig()

    return {
      modelProvider,
      backgroundModelProvider: rawBackground ? toBackgroundSummary(rawBackground) : null,
    }
  })

  fastify.patch<{
    Body: {
      modelProvider?: Partial<ModelConfig>
      backgroundModelProvider?: Partial<ModelConfig> | null
    }
  }>('/config/model', async (request, reply) => {
    const { backgroundModelProvider } = request.body
    const modelProvider = dropEmptyKeys(request.body.modelProvider)

    let currentModelProvider: Partial<ModelConfig> = {}
    try {
      currentModelProvider = getModelProviderConfig()
    } catch {
    }
    const mergedGlobal = { ...currentModelProvider, ...modelProvider }

    if (modelProvider !== undefined) {
      const error = validateGlobalPartial(modelProvider, currentModelProvider)
      if (error) {
        return reply.status(400).send({ error })
      }
    }

    const backgroundPartial = backgroundModelProvider ? pickBackgroundPartial(backgroundModelProvider) : null
    if (backgroundPartial) {
      const currentBackground = getRawBackgroundModelProviderConfig() ?? {}
      const error = validateBackgroundPartial(backgroundPartial, currentBackground, mergedGlobal)
      if (error) {
        return reply.status(400).send({ error })
      }
    }

    let modelProviderResult: ModelConfig | null
    let backgroundResult: BackgroundModelConfig | null
    try {
      modelProviderResult = modelProvider !== undefined
        ? updateModelProviderConfig(modelProvider)
        : (() => {
            try {
              return getModelProviderConfig()
            } catch {
              return null
            }
          })()

      backgroundResult = backgroundModelProvider !== undefined
        ? updateBackgroundModelProviderConfig(backgroundPartial)
        : getRawBackgroundModelProviderConfig()
    } catch (err) {
      if (!(err instanceof ConfigFileUnreadableError)) throw err
      console.error(err.message)
      return reply.status(500).send({ error: CONFIG_FILE_UNREADABLE_MESSAGE })
    }

    if (modelProvider !== undefined || backgroundModelProvider !== undefined) {
      try {
        fastify.modelProvider = createModelProvider(getModelProviderConfig())
        fastify.backgroundModelProvider = createModelProvider(getBackgroundModelProviderConfig())
      } catch {
      }
    }

    return {
      modelProvider: modelProviderResult ? toSummary(modelProviderResult) : null,
      backgroundModelProvider: backgroundResult ? toBackgroundSummary(backgroundResult) : null,
    }
  })
}
