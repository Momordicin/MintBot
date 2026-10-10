// services/core/state.ts — 组装"当前状态"载荷：会话、预设快照、各服务就绪情况、情绪、注意力
// 用法：buildStatePayload() 由 core/index.ts 的 GET /state 与 routes/presets.ts（切换、壁纸、PATCH 的响应）调用；每次现算
// 形状：{ sessionId, presetSnapshot（冻结快照上叠加预设表里的壁纸/名称/显示配置/人设/模型）, ollamaReady, embeddingReady, emotion, embeddingQueue, lastAttentionAt, explicitSleep }
// 对应文件：src/chat/ChatWindow.tsx / src/overlay/OverlayApp.tsx / src/settings/SettingsApp.tsx / electron/main/index.ts（GET /state 调用方）/ services/core/routes/presets.ts / services/core/state.test.ts
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
