import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, db } from '../db/index.js'
import { upsertPreset, upsertEmotionState, getEmotionState, updatePresetSystemPrompt } from './queries.js'
import { loadSession, switchPreset, getCurrentState, refreshCurrentPresetIfActive } from './index.js'

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

  it('切回同一 preset 恢复旧 session 时，情绪状态被完整保留，不被清零', () => {
    const { session } = loadSession('p1')
    upsertEmotionState(session.sessionId, { self: { label: 'sad', intensity: 0.4 }, perceived_user: null })

    switchPreset('p2')
    const resumedState = switchPreset('p1')

    expect(resumedState.session.sessionId).toBe(session.sessionId)
    expect(getEmotionState(resumedState.session.sessionId)).toEqual({
      self: { label: 'sad', intensity: 0.4 },
      perceived_user: null,
    })
  })
})

describe('manifest 缓存（Part A：loadSession/switchPreset 填充 SessionState.manifest）', () => {
  it('preset 的 characterId 对应存在的角色包时，loadSession 返回缓存的 manifest', () => {
    upsertPreset({
      presetId: 'p3',
      name: '角色三',
      characterId: 'Mint',
      modelType: 'ollama',
      modelName: 'qwen3',
      systemPrompt: '你是 Mint',
    })

    const { manifest } = loadSession('p3')

    expect(manifest).not.toBeNull()
    expect(manifest!.avatar).toBe('avatar.png')
  })

  it('preset 的 characterId 没有对应角色包目录时，manifest 为 null，loadSession 不抛错', () => {
    // p2 的 characterId 是 char-002，assets/characters/ 下没有这个目录（已知的、
    // 本阶段之外的种子数据缺口，见 TDD/seed.ts），是本用例要验证的降级路径
    expect(() => loadSession('p2')).not.toThrow()
    const { manifest } = loadSession('p2')

    expect(manifest).toBeNull()
  })

  it('switchPreset 切到新 preset 时同样填充 manifest 字段', () => {
    upsertPreset({
      presetId: 'p3',
      name: '角色三',
      characterId: 'Mint',
      modelType: 'ollama',
      modelName: 'qwen3',
      systemPrompt: '你是 Mint',
    })
    loadSession('p1')

    const { manifest } = switchPreset('p3')

    expect(manifest).not.toBeNull()
    expect(manifest!.avatar).toBe('avatar.png')
  })
})

describe('refreshCurrentPresetIfActive', () => {
  it('给定的 presetId 是当前激活 session 的 preset 时，内存缓存的 preset 刷新为最新值', () => {
    const { session } = loadSession('p1')
    upsertEmotionState(session.sessionId, { self: { label: 'happy', intensity: 0.6 }, perceived_user: null })

    updatePresetSystemPrompt('p1', '更新后的人设')
    refreshCurrentPresetIfActive('p1')

    expect(getCurrentState()!.preset.systemPrompt).toBe('更新后的人设')
    // session 本身、情绪状态均不受影响——与 switchPreset 刻意区分的窄范围原语
    expect(getCurrentState()!.session.sessionId).toBe(session.sessionId)
    expect(getEmotionState(session.sessionId)).not.toBeNull()
  })

  it('给定的 presetId 不是当前激活 session 的 preset 时，是真正的 no-op', () => {
    const { session } = loadSession('p1')
    upsertEmotionState(session.sessionId, { self: { label: 'calm', intensity: 0.3 }, perceived_user: null })
    const before = getCurrentState()!.preset

    // 编辑的是一个当前没在用的 preset（p2）
    updatePresetSystemPrompt('p2', '不应该生效的人设')
    refreshCurrentPresetIfActive('p2')

    expect(getCurrentState()!.preset).toEqual(before)
    expect(getCurrentState()!.preset.systemPrompt).toBe('你是角色一')
    expect(getEmotionState(session.sessionId)).not.toBeNull()
  })
})
