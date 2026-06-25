import { describe, it, expect, beforeEach } from 'vitest'
import { db, initDb } from '../db/index.js'
import {
  getPresetById,
  getAllPresets,
  upsertPreset,
  getLatestSessionByPreset,
  createSession,
  touchSession,
  getRecentMessages,
  appendMessage,
} from './queries.js'

initDb()
beforeEach(() => {
  db.exec(`DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;`)
})

// ─── Preset ───────────────────────────────────────────────

describe('Preset', () => {
  it('upsertPreset 插入后能用 getPresetById 读回，systemPrompt 解密正确', () => {
    upsertPreset({
      presetId: 'p1',
      name: '测试角色',
      characterId: 'char-001',
      modelType: 'ollama',
      modelName: 'qwen3',
      wallpaperPath: undefined,
      systemPrompt: '你是一个AI助手',
    })
    const preset = getPresetById('p1')
    expect(preset).not.toBeNull()
    expect(preset!.systemPrompt).toBe('你是一个AI助手')
    expect(preset!.name).toBe('测试角色')
  })

  it('upsertPreset 同一 presetId 再次调用是更新不是报错', () => {
    upsertPreset({ presetId: 'p1', name: '原名', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: '原始', wallpaperPath: undefined })
    upsertPreset({ presetId: 'p1', name: '新名', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: '更新', wallpaperPath: undefined })
    const preset = getPresetById('p1')
    expect(preset!.name).toBe('新名')
    expect(preset!.systemPrompt).toBe('更新')
  })

  it('getPresetById 查不存在的 id 返回 null', () => {
    expect(getPresetById('not-exist')).toBeNull()
  })

  it('getAllPresets 返回所有 preset', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
    upsertPreset({ presetId: 'p2', name: 'B', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'b', wallpaperPath: undefined })
    expect(getAllPresets()).toHaveLength(2)
  })
 
  it('wallpaperPath 写入 null 读出为 undefined，写入路径读出正确', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
    expect(getPresetById('p1')!.wallpaperPath).toBeUndefined()
 
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: 'data/wallpapers/bg.png' })
    expect(getPresetById('p1')!.wallpaperPath).toBe('data/wallpapers/bg.png')
  })
})

// ─── Session ──────────────────────────────────────────────

describe('Session', () => {
  const snapshot = {
    presetId: 'p1',
    name: '测试角色',
    characterId: 'char-001',
    modelType: 'ollama' as const,
    modelName: 'qwen3',
    systemPrompt: '你是一个AI助手',
  }

  it('createSession 后能用 getLatestSessionByPreset 读回，presetSnapshot 反序列化正确', () => {
    createSession({
      sessionId: 's1',
      presetId: 'p1',
      presetSnapshot: snapshot,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    })
    const session = getLatestSessionByPreset('p1')
    expect(session).not.toBeNull()
    expect(session!.presetSnapshot).toEqual(snapshot)
  })

  it('getLatestSessionByPreset 多条 session 时返回 lastActiveAt 最新的', () => {
    createSession({ sessionId: 's1', presetId: 'p1', presetSnapshot: snapshot, createdAt: 1000, lastActiveAt: 1000 })
    createSession({ sessionId: 's2', presetId: 'p1', presetSnapshot: snapshot, createdAt: 2000, lastActiveAt: 2000 })
    const session = getLatestSessionByPreset('p1')
    expect(session!.sessionId).toBe('s2')
  })

  it('getLatestSessionByPreset 查不存在的 presetId 返回 null', () => {
    expect(getLatestSessionByPreset('not-exist')).toBeNull()
  })

  it('title 为 undefined 时存 null，读出来还原为 undefined', () => {
    createSession({ sessionId: 's1', presetId: 'p1', presetSnapshot: snapshot, createdAt: Date.now(), lastActiveAt: Date.now() })
    const session = getLatestSessionByPreset('p1')
    expect(session!.title).toBeUndefined()
  })

  it('touchSession 更新 lastActiveAt', () => {
    createSession({ sessionId: 's1', presetId: 'p1', presetSnapshot: snapshot, createdAt: 1000, lastActiveAt: 1000 })
    touchSession('s1')
    const session = getLatestSessionByPreset('p1')
    expect(session!.lastActiveAt).toBeGreaterThan(1000)
  })
})

// ─── Messages ─────────────────────────────────────────────

describe('Messages', () => {
  it('appendMessage 写入，getRecentMessages 读出 content 解密正确', () => {
    appendMessage({
      sessionId: 's1', role: 'user', content: '你好', createdAt: Date.now(),
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    const msgs = getRecentMessages('s1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('你好')
  })

  it('getRecentMessages 只返回 visibleToUser = true 的消息', () => {
    appendMessage({ sessionId: 's1', role: 'user', content: '可见', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'user', content: '不可见', createdAt: 2000, embedded: false, summarized: false, visibleToUser: false, trigger: 'scheduler', triggerEventId: null })
    const msgs = getRecentMessages('s1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('可见')
  })

  it('getRecentMessages 返回正序', () => {
    appendMessage({ sessionId: 's1', role: 'user', content: '第一条', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'assistant', content: '第二条', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    const msgs = getRecentMessages('s1')
    expect(msgs[0].content).toBe('第一条')
    expect(msgs[1].content).toBe('第二条')
  })

  it('getRecentMessages limit 参数生效', () => {
    for (let i = 0; i < 5; i++) {
      appendMessage({ sessionId: 's1', role: 'user', content: `消息${i}`, createdAt: i * 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    }
    expect(getRecentMessages('s1', 3)).toHaveLength(3)
  })

  it('boolean 字段 0/1 转换正确', () => {
    appendMessage({ sessionId: 's1', role: 'user', content: '测试', createdAt: Date.now(), embedded: true, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    const msgs = getRecentMessages('s1')
    expect(msgs[0].embedded).toBe(true)
    expect(msgs[0].summarized).toBe(false)
    expect(msgs[0].visibleToUser).toBe(true)
  })
})