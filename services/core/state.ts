import { getCurrentState } from './session/index.js'
import { getEmotionState, getPresetById } from './session/queries.js'
import { getOllamaBaseUrl, isOllamaRunning } from './providers/ollama.js'
import { getAiBaseUrl, isEmbeddingReady } from './providers/EmbeddingProvider.js'
import { computeEmbeddingQueueStatus } from './memory/orchestrator.js'
import { getModelProviderConfig } from './config/index.js'

// GET /state 和 POST /switch-preset 返回同一套结构，抽成共享函数避免两处重复维护
export async function buildStatePayload() {
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
    const baseUrl = getOllamaBaseUrl(getModelProviderConfig().ollamaBaseUrl)
    ollamaReady = await isOllamaRunning(baseUrl)
  }

  // 仅供挂载时的初始 /state 拉取使用；渲染层高频刷新走轻量的 GET /embedding-ready
  // （复用同一个 isEmbeddingReady 健康检查逻辑，不重复实现）
  const embeddingReady = await isEmbeddingReady(getAiBaseUrl())

  return {
    sessionId: state?.session.sessionId ?? null,
    presetSnapshot: snapshot,
    ollamaReady,
    embeddingReady,
    emotion: state ? getEmotionState(state.session.sessionId) : null,
    embeddingQueue: computeEmbeddingQueueStatus(),
  }
}
