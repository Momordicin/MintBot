import type { FastifyInstance } from 'fastify'
import {
  getModelProviderConfig,
  getBackgroundModelProviderConfig,
  getRawBackgroundModelProviderConfig,
  updateModelProviderConfig,
  updateBackgroundModelProviderConfig,
} from '../config/index.js'
import { createModelProvider } from '../providers/ModelProvider.js'
import type { ModelConfig } from '../../../shared/types/index.js'

const VALID_MODEL_TYPES: readonly string[] = ['anthropic', 'openai', 'ollama', 'deepseek']
const MIN_MAX_TOKENS = 1
const MAX_MAX_TOKENS = 32000

export interface ModelConfigSummary {
  type: 'anthropic' | 'openai' | 'ollama' | 'deepseek'
  hasAnthropicApiKey: boolean
  hasOpenaiApiKey: boolean
  hasDeepseekApiKey: boolean
  openaiBaseUrl?: string
  deepseekBaseUrl?: string
  ollamaBaseUrl?: string
  ollamaModel?: string
  modelName?: string
  maxTokens?: number
}

function toSummary(config: ModelConfig): ModelConfigSummary {
  const { anthropicApiKey, openaiApiKey, deepseekApiKey, ...rest } = config
  return {
    ...rest,
    hasAnthropicApiKey: typeof anthropicApiKey === 'string' && anthropicApiKey.length > 0,
    hasOpenaiApiKey: typeof openaiApiKey === 'string' && openaiApiKey.length > 0,
    hasDeepseekApiKey: typeof deepseekApiKey === 'string' && deepseekApiKey.length > 0,
  }
}

function validateModelConfigPartial(partial: Partial<ModelConfig>, current: Partial<ModelConfig>): string | null {
  if (partial.type !== undefined && !VALID_MODEL_TYPES.includes(partial.type)) {
    return 'type must be one of anthropic, openai, ollama, deepseek'
  }

  if (partial.maxTokens !== undefined) {
    if (!Number.isInteger(partial.maxTokens) || partial.maxTokens < MIN_MAX_TOKENS || partial.maxTokens > MAX_MAX_TOKENS) {
      return `maxTokens must be an integer between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}`
    }
  }

  const merged = { ...current, ...partial }
  const trimmedModelName = merged.modelName?.trim()
  if (merged.type === 'anthropic') {
    if (!merged.anthropicApiKey) return 'anthropicApiKey is required when type is anthropic'
    if (!trimmedModelName) return 'modelName is required when type is anthropic'
  } else if (merged.type === 'openai') {
    if (!merged.openaiApiKey) return 'openaiApiKey is required when type is openai'
    if (!trimmedModelName) return 'modelName is required when type is openai'
  } else if (merged.type === 'deepseek') {
    if (!merged.deepseekApiKey) return 'deepseekApiKey is required when type is deepseek'
    if (!trimmedModelName) return 'modelName is required when type is deepseek'
  } else if (merged.type === 'ollama') {
    if (!merged.ollamaModel) return 'ollamaModel is required when type is ollama'
  } else {
    return 'type is required'
  }
  return null
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
      backgroundModelProvider: rawBackground ? toSummary(rawBackground) : null,
    }
  })

  fastify.patch<{
    Body: {
      modelProvider?: Partial<ModelConfig>
      backgroundModelProvider?: Partial<ModelConfig> | null
    }
  }>('/config/model', async (request, reply) => {
    const { modelProvider, backgroundModelProvider } = request.body

    if (modelProvider !== undefined) {
      let currentModelProvider: Partial<ModelConfig> = {}
      try {
        currentModelProvider = getModelProviderConfig()
      } catch {
      }
      const error = validateModelConfigPartial(modelProvider, currentModelProvider)
      if (error) {
        return reply.status(400).send({ error })
      }
    }

    if (backgroundModelProvider !== undefined && backgroundModelProvider !== null) {
      const currentBackground = getRawBackgroundModelProviderConfig() ?? {}
      const error = validateModelConfigPartial(backgroundModelProvider, currentBackground)
      if (error) {
        return reply.status(400).send({ error })
      }
    }

    const modelProviderResult = modelProvider !== undefined
      ? updateModelProviderConfig(modelProvider)
      : (() => {
          try {
            return getModelProviderConfig()
          } catch {
            return null
          }
        })()

    const backgroundResult = backgroundModelProvider !== undefined
      ? updateBackgroundModelProviderConfig(backgroundModelProvider)
      : getRawBackgroundModelProviderConfig()

    if (modelProvider !== undefined || backgroundModelProvider !== undefined) {
      try {
        fastify.modelProvider = createModelProvider(getModelProviderConfig())
        fastify.backgroundModelProvider = createModelProvider(getBackgroundModelProviderConfig())
      } catch {
      }
    }

    return {
      modelProvider: modelProviderResult ? toSummary(modelProviderResult) : null,
      backgroundModelProvider: backgroundResult ? toSummary(backgroundResult) : null,
    }
  })
}
