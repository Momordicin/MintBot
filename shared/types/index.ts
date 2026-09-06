// 建议索引（写 SQLite schema 时建立）：
// CREATE INDEX idx_messages_session ON Messages(sessionId, createdAt)
// CREATE INDEX idx_messages_visible ON Messages(sessionId, visibleToUser)

export interface ModelConfig {
  type: 'anthropic' | 'openai' | 'ollama' | 'deepseek'
  anthropicApiKey?: string
  openaiApiKey?: string
  openaiBaseUrl?: string
  deepseekApiKey?: string
  deepseekBaseUrl?: string
  ollamaBaseUrl?: string
  ollamaModel?: string
  modelName?: string
  maxTokens?: number   // max_tokens 上限，对话和整理模式公用，空值默认各自落回1000
  
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema 格式，Phase 5 细化
}

export interface BuiltContext {
  system: string
  messages: ChatMessage[]
  tools?: ToolSchema[]       // Phase 5 预留
}

export interface NerEntity {
  text: string
  label: string   // 原始 NER 标签（PER/ORG/LOC/TIME），MessageEntity.type 映射由 entityExtractor 负责
  start: number
  end: number
}

export interface MessageEntity {
  id: number
  messageId: number
  sessionId: string
  type: 'person' | 'event' | 'preference' | 'place' | 'other'
  value: string
  validFrom: number
  validUntil: number | null
  createdAt: number
}

export interface ChatMessage{
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface Message{
  id: number
  sessionId: string
  role: 'system' | 'user' | 'assistant'
  content: string         // 多模态时改为Json
  createdAt: number
  embedded: boolean           // Phase 2 预留
  summarized: boolean           // Phase 2 预留
  visibleToUser: boolean
  trigger?: 'user' | 'scheduler' | 'emotion' | 'admin'  // Phase 6 预留
  triggerEventId: number | null     // Phase 6 预留
}

// 建议索引（写 SQLite schema 时建立）：
// CREATE INDEX idx_summaries_session ON Summaries(sessionId)
export interface Summary {
  id: number
  sessionId: string
  content: string            // 摘要内容
  fromMessageId: number
  toMessageId: number
  createdAt: number
}

// 每角色显示设置（聊天窗口背景叠色），见 docs/MintBot_TDD.md §3.2.2「Presets.displayConfig」
export interface PresetDisplayConfig {
  chatBgRgb: [number, number, number]   // 0-255 整数，对应 CSS 变量 --chat-bg-rgb
  chatBgOpacity: number                 // 0-1，对应 CSS 变量 --chat-bg-opacity
  // 以下三个字段服务于 src/chat/theme.ts 的参考实现结构化主题模型（day/night + 单一 accent +
  // tint 旋钮），本层只存储与校验，派生消费不在这层的职责范围内：
  themeMode: 'day' | 'night' | 'auto'   // 'auto' 解析成具体 'day'/'night' 是渲染层/主进程的职责，这一层原样存储
  accentRgb: [number, number, number]   // 0-255 整数，用户选择的唯一 accent 色，对应 theme.ts ThemeInput.accentRgb
  tintStrength: number                  // 0-1，0 = 纯参考发布值，对应 theme.ts ThemeInput.tintStrength
}

// Preset（可复用的配置模板，用户管理）
export interface Preset {
  presetId: string
  name: string                 // 用户起的名字，建议唯一
  characterId: string
  modelType: 'anthropic' | 'openai' | 'ollama' | 'deepseek' | null   // null = 未自定义，跟随全局 modelProvider 配置
  modelName: string | null
  wallpaperPath?: string
  displayConfig: PresetDisplayConfig  // 读时永远补齐默认值，下游无需处理 null（见 session/displayConfig.ts）
  systemPrompt: string
  addressForms: string[]  // 角色对用户的称呼候选集，读时永远补齐为数组，见 docs/MintBot_TDD.md §3.2.2「Presets.addressForms」
  createdAt: number
  updatedAt: number
}

export interface Character {
  characterId: string
  name: string
  // 后期扩展：立绘路径、manifest 等
}

export interface PresetSnapshot {
  presetId: string
  name: string
  characterId: string
  modelType: 'anthropic' | 'openai' | 'ollama' | 'deepseek' | null   // null = 未自定义，跟随全局 modelProvider 配置
  modelName: string | null
  wallpaperPath?: string
  displayConfig?: PresetDisplayConfig  // 可选：已存在的冻结快照 blob 确实没有这个字段（v7 之前创建的 session）
  systemPrompt: string
  // 后期扩展：hooks、角色包配置等
}

export interface Session{
  sessionId: string
  presetId: string             // 关联原始 Preset
  presetSnapshot: PresetSnapshot       // JSON.stringify(PresetSnapshot)，创建时写入，只读
  title?: string               // 预留，对用户不可见，算法内部用
  createdAt: number
  lastActiveAt: number
}

export interface EmotionLabel {
  label: string
  intensity: number  // 0-1
}

export interface EmotionState {
  self: EmotionLabel
  perceived_user: EmotionLabel | null  // Phase 2 基础版留空占位，Phase 后续实现前恒为 null
}

export interface EmbeddingQueueStatus {
  pendingCount: number
  oldestPendingAge: number        // 分钟
  oldestUnsummarizedAge: number   // 天
  activeConversation: boolean     // 最近 5 分钟内是否有消息
  lastEmbeddingRun: number        // timestamp
  activePresetPendingCount: number | null      // 当前激活角色自己的待 embedding 消息数；无激活 session 时为 null
  activePresetOldestPendingAge: number | null  // 分钟；无激活 session 时为 null，有激活 session 但它自己没有待处理消息时为 0
  pendingAheadOfActivePreset: number | null    // 排在当前角色最旧待处理消息前面、必须先处理完的全局数量；无激活 session 时为 null，有激活 session 但它自己没有待处理消息时为 0
}

export interface AppState {
  sessionId: string | null
  presetSnapshot: PresetSnapshot | null
  emotion: EmotionState | null        // 读取 EmotionStates 表（getEmotionState），随 session/preset 恢复
  embeddingQueue: EmbeddingQueueStatus | null  // Phase 2 预留
  embeddingReady: boolean
  ollamaReady: boolean | null   // 仅当前 preset 用 ollama 时为 boolean，否则为 null（见 state.ts buildStatePayload）
  lastAttentionAt: number | null  // 上次"搭理 bot"的时刻，供悬浮窗立绘状态模型 y 求值使用（TDD §3.7 附）；无激活 session 时为 null
  explicitSleep: boolean          // 显式睡着标记，同上；无激活 session 时为 false
}

export type SSEEventType =
  | 'message_chunk'
  | 'message_done'
  | 'emotion'
  | 'tool_confirm'
  | 'tool_result'
  | 'audio_chunk'
  | 'audio_done'
  | 'proactive'
  | 'system'
  | 'window-behavior-changed'

export interface PendingTool {
  toolId: string
  tool: string
  args: Record<string, unknown>
  expiresAt: number  // timestamp，默认 30s 超时
}

export interface CompletionOptions {
  maxTokens?: number
  signal?: AbortSignal  // 用于中断流式请求（Phase 6 预留）
  // 向模型发信json格式化的显式开关 
  // 对不满足格式条件的调用开启
  // response_format: json_object 会导致 OpenAI 400 或 DeepSeek 输出空白直到耗尽 token 预算
  // 因此只有 chat.ts 的对话链路显式传 true，其余调用方默认关闭
  jsonMode?: boolean
}