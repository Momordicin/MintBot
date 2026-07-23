import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
  upsertMessageEmbedding,
  searchSimilarMessages,
  getPendingEmbeddingMessages,
  getPendingEmbeddingCount,
  markMessageEmbedded,
  insertEntity,
  getCurrentEntities,
  getEntitiesAsOf,
  closeEntity,
  indexMessageFts,
  searchMessagesFts,
  upsertEmotionState,
  getEmotionState,
  resetEmotionState,
} from './queries.js'

initDb()
beforeEach(() => {
  db.exec(`
    DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;
    DELETE FROM message_embeddings; DELETE FROM message_fts; DELETE FROM MessageEntities;
    DELETE FROM EmotionStates;
  `)
})

// 构造确定性的 1024 维测试向量：仅在指定维度写入值，其余补零
function vec(dim: number, value: number): number[] {
  const v = new Array(1024).fill(0)
  v[dim] = value
  return v
}

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

// ─── Embeddings ───────────────────────────────────────────

describe('Embeddings', () => {
  it('upsertMessageEmbedding 写入后 searchSimilarMessages 能按距离排序召回', () => {
    upsertMessageEmbedding(1, 's1', vec(0, 1))     // 与 query 完全一致
    upsertMessageEmbedding(2, 's1', vec(0, 0.9))   // 较接近
    upsertMessageEmbedding(3, 's1', vec(0, -1))    // 较远

    const results = searchSimilarMessages(vec(0, 1), 2)
    expect(results).toHaveLength(2)
    expect(results[0].messageId).toBe(1)
    expect(results[1].messageId).toBe(2)
    expect(results[0].distance).toBeLessThan(results[1].distance)
  })

  it('searchSimilarMessages 按 sessionId 过滤', () => {
    upsertMessageEmbedding(1, 's1', vec(0, 1))
    upsertMessageEmbedding(2, 's2', vec(0, 1))

    const results = searchSimilarMessages(vec(0, 1), 5, 's1')
    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe(1)
    expect(results[0].sessionId).toBe('s1')
  })

  // vec0 PARTITION KEY 修复验证：session_id 声明为 PARTITION KEY 后，
  // 会话内语料超过 k 时，按会话过滤的 KNN 查询仍应返回该会话内真正最近的邻居，
  // 不会被另一会话中距离更近但不属于该会话的向量挤出结果集（旧的“先全局 top-k 再过滤”实现会漏召回）
  it('vec0 PARTITION KEY：会话内语料超过 k 时，按会话过滤仍返回该会话真正的最近邻', () => {
    // s1: 5 条，与 query 距离依次增大
    for (let i = 0; i < 5; i++) {
      upsertMessageEmbedding(i + 1, 's1', vec(0, 1 - i * 0.01))
    }
    // s2: 10 条，与 query 完全一致（distance = 0），比 s1 任何一条都更接近
    for (let i = 0; i < 10; i++) {
      upsertMessageEmbedding(100 + i, 's2', vec(0, 1))
    }

    const k = 3
    const results = searchSimilarMessages(vec(0, 1), k, 's1')
    expect(results).toHaveLength(k)
    expect(results.map(r => r.messageId)).toEqual([1, 2, 3])
    expect(results.every(r => r.sessionId === 's1')).toBe(true)
  })

  it('getPendingEmbeddingMessages / getPendingEmbeddingCount / markMessageEmbedded 配套流程', () => {
    const id1 = appendMessage({ sessionId: 's1', role: 'user', content: '待处理1', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'user', content: '待处理2', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'user', content: '已处理', createdAt: 3000, embedded: true, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getPendingEmbeddingCount()).toBe(2)
    const pending = getPendingEmbeddingMessages()
    expect(pending).toHaveLength(2)
    expect(pending[0].content).toBe('待处理1')

    markMessageEmbedded(id1)
    expect(getPendingEmbeddingCount()).toBe(1)
  })
})

// ─── Entities ─────────────────────────────────────────────

describe('Entities', () => {
  it('insertEntity 后 getCurrentEntities 能读回，value 解密正确', () => {
    insertEntity({ messageId: 1, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })
    const entities = getCurrentEntities('s1')
    expect(entities).toHaveLength(1)
    expect(entities[0].value).toBe('喜欢猫')
    expect(entities[0].validUntil).toBeNull()
  })

  it('getCurrentEntities 按 type 过滤', () => {
    insertEntity({ messageId: 1, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })
    insertEntity({ messageId: 2, sessionId: 's1', type: 'person', value: '同事小李', validFrom: 1000 })
    const preferences = getCurrentEntities('s1', 'preference')
    expect(preferences).toHaveLength(1)
    expect(preferences[0].value).toBe('喜欢猫')
  })

  it('closeEntity 双时态关闭后 getCurrentEntities 不再返回，但历史仍在表中', () => {
    const id = insertEntity({ messageId: 1, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })
    closeEntity(id, 5000)
    expect(getCurrentEntities('s1')).toHaveLength(0)

    const row = db.prepare(`SELECT * FROM MessageEntities WHERE id = ?`).get(id) as any
    expect(row.validUntil).toBe(5000)
  })

  it('getEntitiesAsOf 返回指定时间点仍有效的实体', () => {
    const id = insertEntity({ messageId: 1, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })
    closeEntity(id, 5000)

    expect(getEntitiesAsOf('s1', 3000)).toHaveLength(1)
    expect(getEntitiesAsOf('s1', 6000)).toHaveLength(0)
  })
})

// ─── Encryption modes (encryptSensitiveFields) ─────────────
// getEncryptSensitiveFields() 读取的是 process.env.ENCRYPT_SENSITIVE_FIELDS，本身不做缓存，
// 因此测试内直接读写该环境变量即可让 crypto.ts 的判断实时生效，无需额外的测试 hook
describe('Encryption modes (encryptSensitiveFields)', () => {
  const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
  afterEach(() => {
    process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
  })

  it('encryptSensitiveFields=false（本地默认）：消息内容明文落盘且可正常读回', () => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
    const id = appendMessage({
      sessionId: 's1', role: 'user', content: '本地明文消息', createdAt: Date.now(),
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })

    const raw = db.prepare(`SELECT content FROM Messages WHERE id = ?`).get(id) as any
    expect(raw.content).toBe('本地明文消息')

    const msgs = getRecentMessages('s1')
    expect(msgs[0].content).toBe('本地明文消息')
  })

  it('encryptSensitiveFields=true（线上部署）：消息内容加密落盘，读回后解密正确', () => {
    process.env.ENCRYPT_SENSITIVE_FIELDS = 'true'
    const id = appendMessage({
      sessionId: 's1', role: 'user', content: '线上加密消息', createdAt: Date.now(),
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })

    const raw = db.prepare(`SELECT content FROM Messages WHERE id = ?`).get(id) as any
    expect(raw.content).not.toBe('线上加密消息')

    const msgs = getRecentMessages('s1')
    expect(msgs[0].content).toBe('线上加密消息')
  })
})

// ─── EmotionState ─────────────────────────────────────────

describe('EmotionState', () => {
  it('upsertEmotionState 写入后 getEmotionState 能读回', () => {
    upsertEmotionState('s1', { self: { label: 'curious', intensity: 0.7 }, perceived_user: null })
    const emotion = getEmotionState('s1')
    expect(emotion).toEqual({ self: { label: 'curious', intensity: 0.7 }, perceived_user: null })
  })

  it('getEmotionState 查不存在的 sessionId 返回 null', () => {
    expect(getEmotionState('not-exist')).toBeNull()
  })

  it('resetEmotionState 删除后 getEmotionState 变 null', () => {
    upsertEmotionState('s1', { self: { label: 'happy', intensity: 0.5 }, perceived_user: null })
    resetEmotionState('s1')
    expect(getEmotionState('s1')).toBeNull()
  })

  it('同一 sessionId 第二次 upsert 覆盖而不是报错', () => {
    upsertEmotionState('s1', { self: { label: 'happy', intensity: 0.5 }, perceived_user: null })
    upsertEmotionState('s1', { self: { label: 'sad', intensity: 0.3 }, perceived_user: null })
    const emotion = getEmotionState('s1')
    expect(emotion!.self).toEqual({ label: 'sad', intensity: 0.3 })
  })

  it('perceived_user 为 null 时往返仍为 null（Phase 2 占位）', () => {
    upsertEmotionState('s1', { self: { label: 'idle', intensity: 0.1 }, perceived_user: null })
    expect(getEmotionState('s1')!.perceived_user).toBeNull()
  })
})

// ─── FTS (message_fts) ──────────────────────────────────────
// tokenize = 'unicode61' 对连续中文字符会整体切成一个 token（不做分词），
// 因此测试用例使用空格分隔的词以验证 INSERT / MATCH / session 过滤 / 开关本身的行为，
// 而不是验证中文分词效果（分词方案由 TDD/迁移既定，不在本次改动范围内）
describe('FTS (message_fts)', () => {
  const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
  afterEach(() => {
    process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
  })

  it('encryptSensitiveFields=false：写入索引后可通过关键词召回', () => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
    indexMessageFts(1, 's1', 'cat likes fish very much')
    indexMessageFts(2, 's1', 'today is a sunny day')

    const results = searchMessagesFts('cat')
    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe(1)
    expect(results[0].sessionId).toBe('s1')
  })

  it('encryptSensitiveFields=false：按 sessionId 过滤只返回该会话命中', () => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
    indexMessageFts(1, 's1', 'cat likes fish')
    indexMessageFts(2, 's2', 'cat likes fish too')

    const results = searchMessagesFts('cat', 's1')
    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe(1)
    expect(results[0].sessionId).toBe('s1')
  })

  it('encryptSensitiveFields=true：写入为 no-op，搜索直接返回空数组（召回退化为纯向量检索）', () => {
    process.env.ENCRYPT_SENSITIVE_FIELDS = 'true'
    indexMessageFts(1, 's1', 'cat likes fish')

    const raw = db.prepare(`SELECT COUNT(*) as count FROM message_fts`).get() as any
    expect(raw.count).toBe(0)
    expect(searchMessagesFts('cat')).toEqual([])
  })
})