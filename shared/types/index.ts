// 建议索引（写 SQLite schema 时建立）：
// CREATE INDEX idx_messages_session ON Messages(sessionId, createdAt)
// CREATE INDEX idx_messages_visible ON Messages(sessionId, visibleToUser)

export interface ModelConfig {
  type: 'anthropic' | 'openai' | 'ollama'
  anthropicApiKey?: string
  openaiApiKey?: string
  openaiBaseUrl?: string
  ollamaBaseUrl?: string
  ollamaModel?: string
  modelName?: string
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

// Preset（可复用的配置模板，用户管理）
export interface Preset {
  presetId: string
  name: string                 // 用户起的名字，建议唯一
  characterId: string
  modelType: 'anthropic' | 'openai' | 'ollama'
  modelName: string
  wallpaperPath?: string
  systemPrompt: string
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
  modelType: 'anthropic' | 'openai' | 'ollama'
  modelName: string
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
  perceived_user: EmotionLabel
}

export interface EmbeddingQueueStatus {
  pendingCount: number
  oldestPendingAge: number        // 分钟
  oldestUnsummarizedAge: number   // 天
  activeConversation: boolean     // 最近 5 分钟内是否有消息
  lastEmbeddingRun: number        // timestamp
}

export interface AppState {
  sessionId: string | null
  presetSnapshot: PresetSnapshot | null
  emotion: EmotionState | null        // Phase 2 预留，从最近 Message 解析
  embeddingQueue: EmbeddingQueueStatus | null  // Phase 2 预留
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

export interface PendingTool {
  toolId: string
  tool: string
  args: Record<string, unknown>
  expiresAt: number  // timestamp，默认 30s 超时
}

export interface CompletionOptions {
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal  // 用于中断流式请求（Phase 6 预留）
}