export interface ModelConfig {
    type: 'anthropic' | 'openai' | 'ollama';
    anthropicApiKey?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
    modelName?: string;
}
export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
export interface BuiltContext {
    system: string;
    messages: ChatMessage[];
    tools?: ToolSchema[];
}
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface Message {
    id: number;
    sessionId: string;
    role: 'system' | 'user' | 'assistant';
    content: string;
    createdAt: number;
    embedded: boolean;
    summarized: boolean;
    visibleToUser: boolean;
    trigger?: 'user' | 'scheduler' | 'emotion' | 'admin';
    triggerEventId: number | null;
}
export interface Summary {
    id: number;
    sessionId: string;
    content: string;
    fromMessageId: number;
    toMessageId: number;
    createdAt: number;
}
export interface Preset {
    presetId: string;
    name: string;
    characterId: string;
    modelType: 'anthropic' | 'openai' | 'ollama';
    modelName: string;
    wallpaperPath?: string;
    systemPrompt: string;
    createdAt: number;
    updatedAt: number;
}
export interface Character {
    characterId: string;
    name: string;
}
export interface PresetSnapshot {
    presetId: string;
    name: string;
    characterId: string;
    modelType: 'anthropic' | 'openai' | 'ollama';
    modelName: string;
    systemPrompt: string;
}
export interface Session {
    sessionId: string;
    presetId: string;
    presetSnapshot: PresetSnapshot;
    title?: string;
    createdAt: number;
    lastActiveAt: number;
}
export interface EmotionLabel {
    label: string;
    intensity: number;
}
export interface EmotionState {
    self: EmotionLabel;
    perceived_user: EmotionLabel;
}
export interface EmbeddingQueueStatus {
    pendingCount: number;
    oldestPendingAge: number;
    oldestUnsummarizedAge: number;
    activeConversation: boolean;
    lastEmbeddingRun: number;
}
export interface AppState {
    sessionId: string | null;
    presetSnapshot: PresetSnapshot | null;
    emotion: EmotionState | null;
    embeddingQueue: EmbeddingQueueStatus | null;
}
export type SSEEventType = 'message_chunk' | 'message_done' | 'emotion' | 'tool_confirm' | 'tool_result' | 'audio_chunk' | 'audio_done' | 'proactive' | 'system';
export interface PendingTool {
    toolId: string;
    tool: string;
    args: Record<string, unknown>;
    expiresAt: number;
}
export interface CompletionOptions {
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
}
