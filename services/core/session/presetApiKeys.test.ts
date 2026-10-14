import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDb, db } from '../db/index.js'
import {
  upsertPreset,
  getPresetById,
  getAllPresets,
  getPresetApiKeys,
  upsertPresetApiKey,
  updatePresetModelConfig,
  getPresetIdBySession,
  deletePresetWithData,
} from './queries.js'
import { loadSession, switchPreset, refreshCurrentPresetIfActive, getCurrentState } from './index.js'

vi.mock('../events/broadcast.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../events/broadcast.js')>()
  return { ...actual, broadcastEvent: vi.fn() }
})

vi.mock('../config/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../config/index.js')>()
  return { ...actual, setDefaultPresetId: vi.fn() }
})

initDb()

beforeEach(() => {
  db.exec(`
    DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;
    DELETE FROM message_embeddings; DELETE FROM message_fts; DELETE FROM MessageEntities;
    DELETE FROM EmotionStates; DELETE FROM PresetApiKeys;
  `)
  upsertPreset({ presetId: 'p1', name: '角色一', characterId: 'char-001', modelType: 'openai', modelName: 'gpt-4o', systemPrompt: '你是角色一' })
  upsertPreset({ presetId: 'p2', name: '角色二', characterId: 'char-002', modelType: 'ollama', modelName: 'qwen3', systemPrompt: '你是角色二' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getPresetApiKeys / upsertPresetApiKey', () => {
  it('没有任何行时三家都返回无 key、fromEnv 为 false', () => {
    expect(getPresetApiKeys('p1')).toEqual({
      anthropic: { fromEnv: false },
      openai: { fromEnv: false },
      deepseek: { fromEnv: false },
    })
  })

  it('写入 apiKey 后读回，只影响该 provider 与该角色', () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-openai-1' })

    expect(getPresetApiKeys('p1').openai).toEqual({ apiKey: 'sk-openai-1', fromEnv: false })
    expect(getPresetApiKeys('p1').anthropic).toEqual({ fromEnv: false })
    expect(getPresetApiKeys('p2').openai).toEqual({ fromEnv: false })
  })

  it('只改 fromEnv 时保留已保存的 apiKey，只改 apiKey 时保留 fromEnv', () => {
    upsertPresetApiKey('p1', { provider: 'deepseek', apiKey: 'sk-deepseek-1' })
    upsertPresetApiKey('p1', { provider: 'deepseek', fromEnv: true })
    expect(getPresetApiKeys('p1').deepseek).toEqual({ apiKey: 'sk-deepseek-1', fromEnv: true })

    upsertPresetApiKey('p1', { provider: 'deepseek', apiKey: 'sk-deepseek-2' })
    expect(getPresetApiKeys('p1').deepseek).toEqual({ apiKey: 'sk-deepseek-2', fromEnv: true })
  })

  it('没有 apiKey 只有 fromEnv 的行读回时不带 apiKey 字段', () => {
    upsertPresetApiKey('p1', { provider: 'anthropic', fromEnv: true })

    expect(getPresetApiKeys('p1').anthropic).toEqual({ fromEnv: true })
  })

  it('写入 apiKey 后执行 WAL checkpoint(TRUNCATE)，只改 fromEnv 时不执行', () => {
    const pragma = vi.spyOn(db, 'pragma')

    upsertPresetApiKey('p1', { provider: 'openai', fromEnv: true })
    expect(pragma).not.toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)')

    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-openai-1' })
    expect(pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)')
  })

  it('updatePresetModelConfig 带 keyUpdate 时模型列与 key 行一起写入并 checkpoint', () => {
    const pragma = vi.spyOn(db, 'pragma')

    updatePresetModelConfig('p1', 'deepseek', 'deepseek-v4-flash', { provider: 'deepseek', apiKey: 'sk-ds' })

    const preset = getPresetById('p1')!
    expect(preset.modelType).toBe('deepseek')
    expect(preset.modelName).toBe('deepseek-v4-flash')
    expect(getPresetApiKeys('p1').deepseek).toEqual({ apiKey: 'sk-ds', fromEnv: false })
    expect(pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)')
  })

  it('updatePresetModelConfig 的 key 写入失败时模型列一并回滚', () => {
    expect(() => updatePresetModelConfig('p1', 'deepseek', 'deepseek-v4-flash', { provider: 'ollama' as never, apiKey: 'x' })).toThrow()

    const preset = getPresetById('p1')!
    expect(preset.modelType).toBe('openai')
    expect(preset.modelName).toBe('gpt-4o')
  })

  it('updatePresetModelConfig 不带 keyUpdate 时不触碰 key 行', () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-openai-1' })

    updatePresetModelConfig('p1', null, null)

    expect(getPresetApiKeys('p1').openai).toEqual({ apiKey: 'sk-openai-1', fromEnv: false })
  })
})

describe('getPresetIdBySession', () => {
  it('按 sessionId 返回 presetId，不存在返回 null', () => {
    const { session } = loadSession('p1')

    expect(getPresetIdBySession(session.sessionId)).toBe('p1')
    expect(getPresetIdBySession('missing')).toBeNull()
  })
})

describe('deletePresetWithData', () => {
  it('同一事务里删除该角色的 key 行，不影响其他角色', () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-openai-1' })
    upsertPresetApiKey('p1', { provider: 'deepseek', fromEnv: true })
    upsertPresetApiKey('p2', { provider: 'openai', apiKey: 'sk-openai-2' })

    deletePresetWithData('p1')

    expect(db.prepare(`SELECT COUNT(*) AS count FROM PresetApiKeys WHERE presetId = 'p1'`).get()).toEqual({ count: 0 })
    expect(getPresetApiKeys('p2').openai).toEqual({ apiKey: 'sk-openai-2', fromEnv: false })
  })
})

describe('key 不进入共享数据', () => {
  it('Preset 对象、getAllPresets 与 session presetSnapshot 序列化中都没有 key', () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-secret-value' })
    const { session } = loadSession('p1')

    expect(JSON.stringify(getPresetById('p1'))).not.toContain('sk-secret-value')
    expect(JSON.stringify(getAllPresets())).not.toContain('sk-secret-value')
    expect(JSON.stringify(session.presetSnapshot)).not.toContain('sk-secret-value')
    const rows = db.prepare(`SELECT * FROM Sessions`).all()
    expect(JSON.stringify(rows)).not.toContain('sk-secret-value')
  })
})

describe('session 状态里的角色凭据', () => {
  it('loadSession 载入当前角色的凭据', () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-openai-1' })

    const state = loadSession('p1')

    expect(state.credentials.openai).toEqual({ apiKey: 'sk-openai-1', fromEnv: false })
  })

  it('switchPreset 换成新角色的凭据', () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-openai-1' })
    upsertPresetApiKey('p2', { provider: 'openai', apiKey: 'sk-openai-2' })
    loadSession('p1')

    const state = switchPreset('p2')

    expect(state.credentials.openai.apiKey).toBe('sk-openai-2')
  })

  it('refreshCurrentPresetIfActive 刷新当前角色的凭据，非当前角色不刷新', () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-openai-1' })
    loadSession('p1')
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-openai-new' })
    expect(getCurrentState()!.credentials.openai.apiKey).toBe('sk-openai-1')

    refreshCurrentPresetIfActive('p2')
    expect(getCurrentState()!.credentials.openai.apiKey).toBe('sk-openai-1')

    refreshCurrentPresetIfActive('p1')
    expect(getCurrentState()!.credentials.openai.apiKey).toBe('sk-openai-new')
  })
})
