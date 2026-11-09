// services/core/routes/config.ts — 模型配置与联网搜索设置的读取与修改路由
// 用法：core/index.ts 注册 configRoutes；GET /config/model、PATCH /config/model、GET /config/web-search、PATCH /config/web-search、POST /config/web-search/test
// 对应文件：src/settings/ModelConfigPanel.tsx / src/settings/WebSearchPanel.tsx / services/core/config/index.ts / services/core/config/keySummary.ts / services/core/providers/envCredentials.ts / services/core/agents/claudeCode.ts / services/core/agents/codex.ts / services/core/search/webSearch.ts / services/core/routes/models.ts / services/core/routes/config.test.ts / shared/errorCodes.ts
import type { FastifyInstance } from 'fastify'
import {
  getModelProviderConfig,
  getBackgroundModelProviderConfig,
  getRawBackgroundModelProviderConfig,
  updateModelProviderConfig,
  updateBackgroundModelProviderConfig,
  getWebSearchConfig,
  updateWebSearchConfig,
  VALID_WEB_SEARCH_PROVIDERS,
  type BackgroundModelConfig,
} from '../config/index.js'
import { summarizeSavedKey } from '../config/keySummary.js'
import { ConfigFileUnreadableError } from '../config/configFileError.js'
import { createModelProvider } from '../providers/ModelProvider.js'
import { ENV_VAR_BY_PROVIDER, isEnvCredentialDetected, isEnvCleared, clearEnvCleared, type KeyProvider } from '../providers/envCredentials.js'
import { getClaudeLoginStatus } from '../agents/claudeCode.js'
import { getCodexLoginStatus } from '../agents/codex.js'
import { testWebSearchKey, WebSearchError } from '../search/webSearch.js'
import { getBaseConfig, listProviderModels } from './models.js'
import type { ModelConfig, WebSearchConfig, WebSearchProvider } from '../../../shared/types/index.js'
import { ERROR_CODES, errorBody, invalidRequest, type ErrorBody } from '../../../shared/errorCodes.js'

const VALID_MODEL_TYPES: readonly string[] = ['anthropic', 'openai', 'ollama', 'deepseek']
const MIN_MAX_TOKENS = 1
const MAX_MAX_TOKENS = 32000
const KEY_PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai', 'deepseek']

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
  envCleared: boolean
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
  return {
    ...summarizeSavedKey(config[key]),
    fromEnv: config[fromEnv] === true,
    envDetected: isEnvCredentialDetected(provider),
    envCleared: isEnvCleared(provider),
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

function validateProviderSelection(selected: Partial<ModelConfig>, global: Partial<ModelConfig>): ErrorBody | null {
  const trimmedModelName = selected.modelName?.trim()
  if (selected.type === 'ollama') {
    if (!selected.ollamaModel) return invalidRequest('ollamaModel is required when type is ollama')
    return null
  }
  if (selected.type === 'anthropic' || selected.type === 'openai' || selected.type === 'deepseek') {
    if (!isProviderConfigured(global, selected.type)) return errorBody(ERROR_CODES.API_KEY_INVALID)
    if (!trimmedModelName) return invalidRequest(`modelName is required when type is ${selected.type}`)
    return null
  }
  return invalidRequest('type is required')
}

function dropEmptyKeys(partial: Partial<ModelConfig> | undefined): Partial<ModelConfig> | undefined {
  if (!partial || typeof partial !== 'object') return partial
  const cleaned = { ...partial }
  for (const provider of KEY_PROVIDERS) {
    const field = KEY_FIELD[provider].key
    const value = cleaned[field]
    if (typeof value !== 'string') continue
    if (value.trim() === '') delete cleaned[field]
    else cleaned[field] = value.trim()
  }
  return cleaned
}

function validateType(type: string | undefined): ErrorBody | null {
  if (type !== undefined && !VALID_MODEL_TYPES.includes(type)) {
    return invalidRequest('type must be one of anthropic, openai, ollama, deepseek')
  }
  return null
}

function touchesModelSelection(partial: Partial<ModelConfig>): boolean {
  return partial.type !== undefined || partial.modelName !== undefined || partial.ollamaModel !== undefined
}

function validateKeySourceInUse(
  partial: Partial<ModelConfig>,
  current: Partial<ModelConfig>,
  background: BackgroundModelConfig | null
): ErrorBody | null {
  const merged = { ...current, ...partial }
  for (const provider of KEY_PROVIDERS) {
    const { key, fromEnv } = KEY_FIELD[provider]
    if (partial[fromEnv] !== false || current[fromEnv] !== true) continue
    const inUse = merged.type === provider || background?.type === provider
    const saved = merged[key]
    if (inUse && !(typeof saved === 'string' && saved.length > 0)) {
      return errorBody(ERROR_CODES.KEY_SOURCE_IN_USE, { provider })
    }
  }
  return null
}

async function validateNewKeys(partial: Partial<ModelConfig>): Promise<ErrorBody | null> {
  for (const provider of KEY_PROVIDERS) {
    const { key, fromEnv } = KEY_FIELD[provider]
    const given = partial[key]
    if (typeof given !== 'string') continue
    const result = await listProviderModels(provider, { ...getBaseConfig(provider), [key]: given, [fromEnv]: false })
    if ('code' in result) return errorBody(result.code, result.params)
  }
  return null
}

function validateGlobalPartial(partial: Partial<ModelConfig>, current: Partial<ModelConfig>, checkSelection: boolean): ErrorBody | null {
  const typeError = validateType(partial.type)
  if (typeError) return typeError

  if (partial.maxTokens !== undefined) {
    if (!Number.isInteger(partial.maxTokens) || partial.maxTokens < MIN_MAX_TOKENS || partial.maxTokens > MAX_MAX_TOKENS) {
      return invalidRequest(`maxTokens must be an integer between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}`)
    }
  }

  for (const provider of KEY_PROVIDERS) {
    const flag = KEY_FIELD[provider].fromEnv
    if (partial[flag] === true && current[flag] !== true && !isEnvCredentialDetected(provider)) {
      return errorBody(ERROR_CODES.ENV_VAR_MISSING, { envVar: ENV_VAR_BY_PROVIDER[provider] })
    }
  }

  if (!checkSelection) return null
  const merged = { ...current, ...partial }
  return validateProviderSelection(merged, merged)
}

function validateBackgroundPartial(
  partial: Partial<ModelConfig>,
  current: Partial<ModelConfig>,
  mergedGlobal: Partial<ModelConfig>
): ErrorBody | null {
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

const WEB_SEARCH_KEY_FIELDS = ['deepseekApiKey', 'tavilyApiKey', 'anysearchApiKey'] as const

const WEB_SEARCH_KEY_BY_PROVIDER: Partial<Record<WebSearchProvider, (typeof WEB_SEARCH_KEY_FIELDS)[number]>> = {
  deepseek: 'deepseekApiKey',
  tavily: 'tavilyApiKey',
}

interface WebSearchPatchBody {
  order?: unknown
  deepseekApiKey?: unknown
  tavilyApiKey?: unknown
  anysearchApiKey?: unknown
  anysearchZone?: unknown
  copyDeepseekKeyFromModel?: unknown
}

function readModelConfig(): Partial<ModelConfig> {
  try {
    return getModelProviderConfig()
  } catch {
    return {}
  }
}

async function buildWebSearchSummary() {
  const config = getWebSearchConfig()
  const model = readModelConfig()
  const [claude, codex] = await Promise.all([getClaudeLoginStatus(), getCodexLoginStatus()])
  return {
    order: config.order,
    anysearchZone: config.anysearchZone,
    deepseek: summarizeSavedKey(config.deepseekApiKey),
    tavily: summarizeSavedKey(config.tavilyApiKey),
    anysearch: summarizeSavedKey(config.anysearchApiKey),
    modelDeepseek: summarizeSavedKey(model.deepseekApiKey),
    claude: { loggedIn: claude },
    codex: { loggedIn: codex },
  }
}

async function validateWebSearchOrder(order: WebSearchProvider[], current: WebSearchConfig, effective: WebSearchConfig): Promise<ErrorBody | null> {
  for (const provider of order) {
    if (current.order.includes(provider)) continue
    const keyField = WEB_SEARCH_KEY_BY_PROVIDER[provider]
    if (keyField && !effective[keyField]) {
      return errorBody(ERROR_CODES.WEB_SEARCH_KEY_MISSING, { provider })
    }
    if (provider === 'claude' && !(await getClaudeLoginStatus())) {
      return errorBody(ERROR_CODES.WEB_SEARCH_LOGIN_MISSING, { provider })
    }
    if (provider === 'codex' && !(await getCodexLoginStatus())) {
      return errorBody(ERROR_CODES.WEB_SEARCH_LOGIN_MISSING, { provider })
    }
  }
  return null
}

async function buildWebSearchPatch(body: WebSearchPatchBody, current: WebSearchConfig): Promise<{ patch: Partial<WebSearchConfig> } | { error: ErrorBody }> {
  const patch: Partial<WebSearchConfig> = {}

  if (body.order !== undefined) {
    const { order } = body
    if (!Array.isArray(order) || order.some(item => !VALID_WEB_SEARCH_PROVIDERS.includes(item as WebSearchProvider))) {
      return { error: invalidRequest('order must be an array of deepseek, tavily, anysearch, claude, codex') }
    }
    if (new Set(order).size !== order.length) return { error: invalidRequest('order must not contain duplicates') }
    patch.order = order as WebSearchProvider[]
  }

  for (const field of WEB_SEARCH_KEY_FIELDS) {
    const value = body[field]
    if (value === undefined) continue
    if (typeof value !== 'string') return { error: invalidRequest(`${field} must be a string`) }
    if (value.trim() !== '') patch[field] = value.trim()
  }

  if (body.anysearchZone !== undefined) {
    if (body.anysearchZone !== 'cn' && body.anysearchZone !== 'intl' && body.anysearchZone !== null) {
      return { error: invalidRequest('anysearchZone must be cn, intl or null') }
    }
    patch.anysearchZone = body.anysearchZone
  }

  if (body.copyDeepseekKeyFromModel !== undefined) {
    if (body.copyDeepseekKeyFromModel !== true) return { error: invalidRequest('copyDeepseekKeyFromModel must be true') }
    const saved = readModelConfig().deepseekApiKey
    if (typeof saved !== 'string' || saved === '') return { error: errorBody(ERROR_CODES.WEB_SEARCH_NO_SAVED_DEEPSEEK_KEY) }
    patch.deepseekApiKey = saved
  }

  if (patch.order) {
    const error = await validateWebSearchOrder(patch.order, current, { ...current, ...patch })
    if (error) return { error }
  }
  return { patch }
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
      const error = validateGlobalPartial(modelProvider, currentModelProvider, touchesModelSelection(modelProvider))
        ?? validateKeySourceInUse(modelProvider, currentModelProvider, getRawBackgroundModelProviderConfig())
        ?? await validateNewKeys(modelProvider)
      if (error) {
        return reply.status(400).send(error)
      }
    }

    const backgroundPartial = backgroundModelProvider ? pickBackgroundPartial(backgroundModelProvider) : null
    if (backgroundPartial) {
      const currentBackground = getRawBackgroundModelProviderConfig() ?? {}
      const error = validateBackgroundPartial(backgroundPartial, currentBackground, mergedGlobal)
      if (error) {
        return reply.status(400).send(error)
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
      return reply.status(500).send(errorBody(ERROR_CODES.CONFIG_FILE_UNREADABLE))
    }

    if (modelProvider !== undefined) {
      for (const provider of KEY_PROVIDERS) {
        const { key, fromEnv } = KEY_FIELD[provider]
        if (modelProvider[key] !== undefined || modelProvider[fromEnv] !== undefined) clearEnvCleared(provider)
      }
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

  fastify.get('/config/web-search', async () => buildWebSearchSummary())

  fastify.patch<{ Body: WebSearchPatchBody }>('/config/web-search', async (request, reply) => {
    const built = await buildWebSearchPatch(request.body ?? {}, getWebSearchConfig())
    if ('error' in built) return reply.status(400).send(built.error)

    try {
      updateWebSearchConfig(built.patch)
    } catch (err) {
      if (!(err instanceof ConfigFileUnreadableError)) throw err
      console.error(err.message)
      return reply.status(500).send(errorBody(ERROR_CODES.CONFIG_FILE_UNREADABLE))
    }
    return buildWebSearchSummary()
  })

  fastify.post<{ Body: { provider?: unknown } }>('/config/web-search/test', async (request, reply) => {
    const provider = request.body?.provider
    if (provider !== 'deepseek' && provider !== 'tavily' && provider !== 'anysearch') {
      return reply.status(400).send(invalidRequest('provider must be one of deepseek, tavily, anysearch'))
    }
    try {
      await testWebSearchKey(provider, new AbortController().signal)
      return { ok: true }
    } catch (err) {
      if (err instanceof WebSearchError) {
        if (err.kind === 'not_configured') return { ok: false, ...errorBody(ERROR_CODES.WEB_SEARCH_KEY_MISSING, { provider }) }
        if (err.status === 401 || err.status === 403) return { ok: false, ...errorBody(ERROR_CODES.API_KEY_INVALID) }
        if (err.kind === 'timeout' || err.kind === 'connect') return { ok: false, ...errorBody(ERROR_CODES.PROVIDER_UNREACHABLE) }
      }
      return { ok: false, ...errorBody(ERROR_CODES.WEB_SEARCH_TEST_FAILED, { reason: err instanceof Error ? err.message : String(err) }) }
    }
  })
}
