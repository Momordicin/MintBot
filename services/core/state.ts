import type { FastifyInstance } from 'fastify'
import type { ModelConfig } from '../../shared/types/index.js'
import { getCurrentState } from './session/index.js'
import { getEmotionState } from './session/queries.js'
import { getOllamaBaseUrl, isOllamaRunning } from './providers/ollama.js'

// GET /state 和 POST /switch-preset 返回同一套结构，抽成共享函数避免两处重复维护
export async function buildStatePayload(fastify: FastifyInstance) {
  const state = getCurrentState()
  const snapshot = state?.session.presetSnapshot ?? null

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
    embeddingQueue: null,
  }
}
