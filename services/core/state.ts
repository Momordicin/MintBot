import type { FastifyInstance } from 'fastify'
import type { ModelConfig } from '../../shared/types/index.js'
import { getCurrentState } from './session/index.js'
import { getEmotionState, getPresetById } from './session/queries.js'
import { getOllamaBaseUrl, isOllamaRunning } from './providers/ollama.js'
import { computeEmbeddingQueueStatus } from './memory/orchestrator.js'

// GET /state 和 POST /switch-preset 返回同一套结构，抽成共享函数避免两处重复维护
export async function buildStatePayload(fastify: FastifyInstance) {
  const state = getCurrentState()
  const frozenSnapshot = state?.session.presetSnapshot ?? null

  // presetSnapshot 里除 wallpaperPath 外的字段都是"创建时写入、只读"（TDD Sessions 表定义），
  // 但 wallpaperPath 需要反映壁纸上传后的最新值，因此单独读一次 Presets 表覆盖它；
  // 其余字段仍然使用冻结快照，不受这次改动影响
  let snapshot = frozenSnapshot
  if (frozenSnapshot) {
    const preset = getPresetById(frozenSnapshot.presetId)
    snapshot = { ...frozenSnapshot, wallpaperPath: preset?.wallpaperPath ?? frozenSnapshot.wallpaperPath }
  }

  let ollamaReady: boolean | null = null
  if (snapshot?.modelType === 'ollama') {
    const modelConfig = fastify.config.modelProvider as ModelConfig | undefined
    const baseUrl = getOllamaBaseUrl(modelConfig?.ollamaBaseUrl)
    ollamaReady = await isOllamaRunning(baseUrl)
  }

  return {
    sessionId: state?.session.sessionId ?? null,
    presetSnapshot: snapshot,
    ollamaReady,
    emotion: state ? getEmotionState(state.session.sessionId) : null,
    embeddingQueue: computeEmbeddingQueueStatus(),
  }
}
