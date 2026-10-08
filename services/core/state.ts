import { getCurrentState } from './session/index.js'
import { getEmotionState, getPresetById } from './session/queries.js'
import { getLastAttentionAt, isExplicitSleep } from './session/attention.js'
import { getOllamaBaseUrl, isOllamaRunning } from './providers/ollama.js'
import { getAiBaseUrl, isEmbeddingReady } from './providers/EmbeddingProvider.js'
import { computeEmbeddingQueueStatus } from './memory/orchestrator.js'
import { getModelProviderConfig } from './config/index.js'

export async function buildStatePayload() {
  const state = getCurrentState()
  const frozenSnapshot = state?.session.presetSnapshot ?? null

  let snapshot = frozenSnapshot
  if (frozenSnapshot) {
    const preset = getPresetById(frozenSnapshot.presetId)
    snapshot = {
      ...frozenSnapshot,
      wallpaperPath: preset?.wallpaperPath ?? frozenSnapshot.wallpaperPath,
      name: preset?.name ?? frozenSnapshot.name,
      displayConfig: preset?.displayConfig ?? frozenSnapshot.displayConfig,
      systemPrompt: preset?.systemPrompt ?? frozenSnapshot.systemPrompt,
      modelType: preset ? preset.modelType : frozenSnapshot.modelType,
      modelName: preset ? preset.modelName : frozenSnapshot.modelName,
    }
  }

  const effectiveModelType = snapshot ? (snapshot.modelType ?? getModelProviderConfig().type) : null
  let ollamaReady: boolean | null = null
  if (effectiveModelType === 'ollama') {
    const baseUrl = getOllamaBaseUrl(getModelProviderConfig().ollamaBaseUrl)
    ollamaReady = await isOllamaRunning(baseUrl)
  }

  const embeddingReady = await isEmbeddingReady(getAiBaseUrl())

  return {
    sessionId: state?.session.sessionId ?? null,
    presetSnapshot: snapshot,
    ollamaReady,
    embeddingReady,
    emotion: state ? getEmotionState(state.session.sessionId) : null,
    embeddingQueue: computeEmbeddingQueueStatus(Date.now(), state?.session.sessionId ?? null),
    lastAttentionAt: state ? getLastAttentionAt(state.session.sessionId) : null,
    explicitSleep: state ? isExplicitSleep(state.session.sessionId) : false,
  }
}
