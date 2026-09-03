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

// GET /config/model 的响应类型：anthropicApiKey/openaiApiKey/deepseekApiKey 永远不回显明文，
// 只回传 hasAnthropicApiKey/hasOpenaiApiKey/hasDeepseekApiKey 供设置页判断是否已配置
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

// 校验通过返回 null，失败返回错误信息（供 400 响应使用）。current 是该 section 当前已存
// 的值（写入前），用于计算合并后的"生效配置"是否满足对应 type 的必填字段——这是用户
// 主动发起的请求，无效输入直接 400 拒绝整个请求，不做被动文件热重载那套"单字段告警回退"
function validateModelConfigPartial(partial: Partial<ModelConfig>, current: Partial<ModelConfig>): string | null {
  if (partial.type !== undefined && !VALID_MODEL_TYPES.includes(partial.type)) {
    return 'type must be one of anthropic, openai, ollama, deepseek'
  }

  const merged = { ...current, ...partial }
  // modelName 需要 trim 后再判断非空——同 routes/presets.ts 的 trimmedModelName 校验口径一致，
  // 否则一个全空格的值会通过这里的真值判断，被当作合法 modelName 写入
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
    // getModelProviderConfig() 未配置时会抛错——目前只有配置了才能启动服务，理论上不会
    // 命中，但这里仍用 try/catch 兜底返回 modelProvider: null，不让整个设置页因为这一个
    // 接口挂掉
    let modelProvider: ModelConfigSummary | null = null
    try {
      modelProvider = toSummary(getModelProviderConfig())
    } catch {
      modelProvider = null
    }

    // 用原始覆盖状态（fallback 之前）而非 getBackgroundModelProviderConfig()：设置页
    // 需要知道"没有配置覆盖"，而不是覆盖 fallback 之后恰好等于全局配置的值
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
        // 未配置，视为空对象参与合并校验
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

    // undefined 表示 body 没带这个字段——不触碰该 section，响应里读现有值；
    // null（仅 backgroundModelProvider）表示显式清除覆盖
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

    // 只要真的写了任一 section，就立即同步重建 fastify.modelProvider/backgroundModelProvider——
    // 与 index.ts 里 startConfigWatcher(onReload) 的重建逻辑完全一样，但不等 chokidar 的
    // 异步 reload 触发。orchestrator.ts 的整理模式调度直接读 fastify.backgroundModelProvider
    // 这个单例（不像 chat.ts 每次请求现读 getModelProviderConfig()），如果只依赖 chokidar，
    // 这次 PATCH 保存后到下一次 chokidar reload 触发之间，若正好有一次整理模式 tick 跑起来，
    // 用的还是保存前的旧模型/旧 key——这里补上，让摘要模型跟对话模型有同样"保存后立即生效"
    // 的保证。getModelProviderConfig() 未配置时会抛错，用 try/catch 兜底跳过，不让这个
    // 收尾步骤反过来让本该成功的写入请求返回失败
    if (modelProvider !== undefined || backgroundModelProvider !== undefined) {
      try {
        fastify.modelProvider = createModelProvider(getModelProviderConfig())
        fastify.backgroundModelProvider = createModelProvider(getBackgroundModelProviderConfig())
      } catch {
        // 未配置 modelProvider 时跳过重建，等真正配置好后的下一次写入/reload 自然会建上
      }
    }

    return {
      modelProvider: modelProviderResult ? toSummary(modelProviderResult) : null,
      backgroundModelProvider: backgroundResult ? toSummary(backgroundResult) : null,
    }
  })
}
