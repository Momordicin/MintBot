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

  // presetSnapshot 里除 wallpaperPath / name / displayConfig / systemPrompt / modelType /
  // modelName 外的字段都是"创建时写入、只读"（TDD Sessions 表定义），但这六个字段需要
  // 分别反映壁纸上传、改名、显示设置调整、人设编辑、模型覆盖调整后的最新值，因此单独读
  // 一次 Presets 表覆盖它们；其余字段仍然使用冻结快照，不受这次改动影响。
  // 注意：这里只影响设置页/状态接口"展示"出来的值是不是最新——不影响 buildContext.ts /
  // createModelProviderForPreset 实际使用的模型（那个来自 session/index.ts 的
  // current.preset，只在 loadSession/switchPreset 或显式 applyNow 时才会刷新），两件事
  // 互相独立。
  // modelType/modelName 用 preset ? preset.X : frozenSnapshot.X 而非其它四个字段的
  // `preset?.X ?? frozenSnapshot.X` 写法：preset.modelType/modelName 本身可以合法为
  // null（表示"未自定义，跟随全局"），`??` 会把这个合法的 null 误当成"取不到值"从而
  // 错误地回退到冻结快照里的旧值
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

  // snapshot 为 null（没有活跃 session）时不存在"当前生效模型"这回事，effectiveModelType
  // 保持 null，不读取 getModelProviderConfig()（同原有行为，也是 state.test.ts 里
  // "无 session 时不应该读到 getModelProviderConfig()" 这条注释的前提）。snapshot 存在但
  // modelType 为 null 时，表示这个 preset 没有自定义覆盖、跟随全局对话模型——这种情况才需要
  // 用全局 type 判断是否要检测 Ollama 运行状态，否则一个跟随全局、而全局恰好是 ollama 的
  // preset 会被误判为不需要检测
  const effectiveModelType = snapshot ? (snapshot.modelType ?? getModelProviderConfig().type) : null
  let ollamaReady: boolean | null = null
  if (effectiveModelType === 'ollama') {
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
