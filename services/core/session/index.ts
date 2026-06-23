import { randomUUID } from 'crypto'
import type { Session, Preset, Message, PresetSnapshot } from '../../../shared/types/index.js'
import {
  getPresetById,
  getLatestSessionByPreset,
  createSession,
  touchSession,
  getRecentMessages,
  appendMessage,
} from './queries.js'

interface SessionState {
  session: Session
  preset: Preset
}

let current: SessionState | null = null

// ─── 加载或新建 session ────────────────────────────────────

export function loadSession(presetId: string): SessionState {
  const preset = getPresetById(presetId)
  if (!preset) throw new Error(`[Session] Preset not found: ${presetId}`)
  // TODO Phase 3：加载 preset 后需验证 characterId 对应的角色包是否存在
  // 检查 assets/characters/{characterId}/manifest.json 是否可读
  // 不存在时给出明确错误或降级到默认角色，避免立绘加载失败静默报错

  let session = getLatestSessionByPreset(presetId)

  if (!session) {
    const snapshot: PresetSnapshot = {
      presetId: preset.presetId,
      name: preset.name,
      characterId: preset.characterId, 
      modelType: preset.modelType,
      modelName: preset.modelName,
      systemPrompt: preset.systemPrompt,
    }
    session = {
      sessionId: randomUUID(),
      presetId: preset.presetId,
      presetSnapshot: snapshot,
      title: undefined,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    createSession(session)
    console.log(`[Session] Created new session ${session.sessionId} for preset ${presetId}`)
  } else {
    console.log(`[Session] Resumed session ${session.sessionId} for preset ${presetId}`)
  }

  current = { session, preset }
  return current
}

// ─── 切换角色 ──────────────────────────────────────────────

export function switchPreset(presetId: string): SessionState {
  console.log(`[Session] Switching to preset ${presetId}`)
  current = null  // 清空当前状态，情绪状态 Phase 2 在这里一并清零
  return loadSession(presetId)
}

// ─── 读取当前状态 ──────────────────────────────────────────

export function getCurrentState(): SessionState | null {
  return current
}

export function requireCurrentState(): SessionState {
  if (!current) throw new Error('[Session] No active session')
  return current
}

// ─── 消息操作 ──────────────────────────────────────────────

export function getHistory(limit = 50): Message[] {
  const { session } = requireCurrentState()
  return getRecentMessages(session.sessionId, limit)
}

export function addMessage(
  role: Message['role'],
  content: string,
  trigger: Message['trigger'] = 'user'
): number {
  const { session } = requireCurrentState()
  const id = appendMessage({
    sessionId: session.sessionId,
    role,
    content,
    createdAt: Date.now(),
    embedded: false,
    summarized: false,
    visibleToUser: true,
    trigger,
    triggerEventId: null,
  })
  touchSession(session.sessionId)
  return id
}