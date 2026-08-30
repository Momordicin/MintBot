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

  // presetSnapshot 里除 wallpaperPath / name / displayConfig / systemPrompt 外的字段都是
  // "创建时写入、只读"（TDD Sessions 表定义），但这四个字段需要分别反映壁纸上传、改名、
  // 显示设置调整、人设编辑后的最新值，因此单独读一次 Presets 表覆盖它们；其余字段仍然使用
  // 冻结快照，不受这次改动影响。
  // 注意：这里只影响设置页/状态接口"展示"出来的 systemPrompt 是不是最新——不影响
  // buildContext.ts 实际发给模型的 system prompt（那个来自 session/index.ts 的 current.preset，
  // 只在 loadSession/switchPreset 或显式 applyNow 时才会刷新），两件事互相独立
  let snapshot = frozenSnapshot
  if (frozenSnapshot) {
    const preset = getPresetById(frozenSnapshot.presetId)
    snapshot = {
      ...frozenSnapshot,
      wallpaperPath: preset?.wallpaperPath ?? frozenSnapshot.wallpaperPath,
      name: preset?.name ?? frozenSnapshot.name,
      displayConfig: preset?.displayConfig ?? frozenSnapshot.displayConfig,
      systemPrompt: preset?.systemPrompt ?? frozenSnapshot.systemPrompt,
    }
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
