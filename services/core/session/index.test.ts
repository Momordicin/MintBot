import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, db } from '../db/index.js'
import { upsertPreset, upsertEmotionState, getEmotionState } from './queries.js'
import { loadSession, switchPreset } from './index.js'

initDb()

beforeEach(() => {
  db.exec(`
    DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;
    DELETE FROM message_embeddings; DELETE FROM message_fts; DELETE FROM MessageEntities;
    DELETE FROM EmotionStates;
  `)
  upsertPreset({
    presetId: 'p1',
    name: '角色一',
    characterId: 'char-001',
    modelType: 'ollama',
    modelName: 'qwen3',
    systemPrompt: '你是角色一',
  })
  upsertPreset({
    presetId: 'p2',
    name: '角色二',
    characterId: 'char-002',
    modelType: 'ollama',
    modelName: 'qwen3',
    systemPrompt: '你是角色二',
  })
})

describe('switchPreset', () => {
  it('切换到新 preset 后，新 session 的情绪状态为 null（即使之前手动 upsert 过）', () => {
    const { session } = loadSession('p1')
    upsertEmotionState(session.sessionId, { self: { label: 'happy', intensity: 0.8 }, perceived_user: null })
    expect(getEmotionState(session.sessionId)).not.toBeNull()

    const newState = switchPreset('p2')
    expect(getEmotionState(newState.session.sessionId)).toBeNull()
  })

  it('切回同一 preset 恢复旧 session 时，情绪状态也被清零', () => {
    const { session } = loadSession('p1')
    upsertEmotionState(session.sessionId, { self: { label: 'sad', intensity: 0.4 }, perceived_user: null })

    switchPreset('p2')
    const resumedState = switchPreset('p1')

    expect(resumedState.session.sessionId).toBe(session.sessionId)
    expect(getEmotionState(resumedState.session.sessionId)).toBeNull()
  })
})
