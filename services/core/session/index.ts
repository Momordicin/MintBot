import { randomUUID } from 'crypto'
import type { Session, Preset, Message, PresetSnapshot } from '../../../shared/types/index.js'
import { loadCharacterManifest, type CharacterManifest } from '../characters/manifest.js'
import { broadcastEvent } from '../events/broadcast.js'
import { setDefaultPresetId } from '../config/index.js'
import {
  getPresetById,
  getAllPresets,
  getLatestSessionByPreset,
  createSession,
  touchSession,
  getRecentMessages,
  appendMessage,
} from './queries.js'

interface SessionState {
  session: Session
  preset: Preset
  manifest: CharacterManifest | null
}

let current: SessionState | null = null

export function loadSession(presetId: string): SessionState {
  const preset = getPresetById(presetId)
  if (!preset) throw new Error(`[Session] Preset not found: ${presetId}`)

  const manifest = loadCharacterManifest(preset.characterId)

  let session = getLatestSessionByPreset(presetId)

  if (!session) {
    const snapshot: PresetSnapshot = {
      presetId: preset.presetId,
      name: preset.name,
      characterId: preset.characterId, 
      modelType: preset.modelType,
      modelName: preset.modelName,
      wallpaperPath: preset.wallpaperPath,
      displayConfig: preset.displayConfig,
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

  current = { session, preset, manifest }
  return current
}

export function switchPreset(presetId: string): SessionState {
  console.log(`[Session] Switching to preset ${presetId}`)
  current = null
  const state = loadSession(presetId)

  setDefaultPresetId(presetId)

  broadcastEvent('preset-switched', { sessionId: state.session.sessionId, presetId: state.session.presetId })

  return state
}

export function resolveStartupPresetId(persistedPresetId: string | undefined): string | undefined {
  if (persistedPresetId && getPresetById(persistedPresetId)) return persistedPresetId
  return getAllPresets()[0]?.presetId
}

export function refreshCurrentPresetIfActive(presetId: string): void {
  if (current?.session.presetId !== presetId) return
  const preset = getPresetById(presetId)
  if (!preset) return
  current = { ...current, preset }
}

export function getCurrentState(): SessionState | null {
  return current
}

export function requireCurrentState(): SessionState {
  if (!current) throw new Error('[Session] No active session')
  return current
}

export function getHistory(limit = 50): Message[] {
  const { session } = requireCurrentState()
  return getRecentMessages(session.sessionId, limit)
}

export function addMessage(
  sessionId: string,
  role: Message['role'],
  content: string,
  trigger: Message['trigger'] = 'user'
): number {
  const id = appendMessage({
    sessionId,
    role,
    content,
    createdAt: Date.now(),
    embedded: false,
    summarized: false,
    visibleToUser: true,
    trigger,
    triggerEventId: null,
  })
  touchSession(sessionId)
  return id
}