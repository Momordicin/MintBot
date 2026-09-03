import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db, initDb } from '../db/index.js'
import {
  getPresetById,
  getAllPresets,
  upsertPreset,
  createPreset,
  updatePresetName,
  updatePresetDisplayConfig,
  updatePresetSystemPrompt,
  updatePresetAddressForms,
  getLatestSessionByPreset,
  createSession,
  touchSession,
  getRecentMessages,
  getMessagesPage,
  appendMessage,
  upsertMessageEmbedding,
  searchSimilarMessages,
  getPendingEmbeddingMessages,
  getPendingEmbeddingCount,
  getPendingEmbeddingCountForSession,
  getOldestPendingEmbeddingTimeForSession,
  getPendingEmbeddingCountBefore,
  markMessageEmbedded,
  getMostRecentMessageTime,
  getOldestUnsummarizedMessageTime,
  insertEntity,
  getCurrentEntities,
  getCurrentEntitiesPage,
  getEntitiesAsOf,
  closeEntity,
  indexMessageFts,
  searchMessagesFts,
  backfillMessageFts,
  upsertEmotionState,
  getEmotionState,
  resetEmotionState,
  getSessionsWithPendingSummaries,
  getPendingSummaryCount,
  getSummaries,
  insertSummary,
  getMessageCreatedAtByIds,
  getSupersededMessageIds,
  getMessagesByIds,
  getMessageIdsInTimeRange,
  getSummariesOverlappingRange,
  forgetMessages,
} from './queries.js'
import { DEFAULT_DISPLAY_CONFIG } from './displayConfig.js'

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

  it('updatePresetName 更新 name 字段，其余字段不受影响', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
    updatePresetName('p1', 'B')
    const preset = getPresetById('p1')!
    expect(preset.name).toBe('B')
    expect(preset.systemPrompt).toBe('a')
  })

  it('upsertPreset 不传 displayConfig 时默认写入 DEFAULT_DISPLAY_CONFIG', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
    expect(getPresetById('p1')!.displayConfig).toEqual(DEFAULT_DISPLAY_CONFIG)
  })

  it('upsertPreset 传入 displayConfig 时按传入值写入', () => {
    const displayConfig = { chatBgRgb: [1, 2, 3] as [number, number, number], chatBgOpacity: 0.2 }
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined, displayConfig })
    expect(getPresetById('p1')!.displayConfig).toEqual(displayConfig)
  })

  it('getPresetById/getAllPresets 对迁移前的旧行（displayConfig 列为 NULL）返回默认值', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
    // 模拟迁移前从未写过 displayConfig 的历史行
    db.prepare(`UPDATE Presets SET displayConfig = NULL WHERE presetId = ?`).run('p1')

    expect(getPresetById('p1')!.displayConfig).toEqual(DEFAULT_DISPLAY_CONFIG)
    expect(getAllPresets()[0].displayConfig).toEqual(DEFAULT_DISPLAY_CONFIG)
  })

  it('updatePresetDisplayConfig 更新后能通过 getPresetById 读回，其余字段不受影响', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
    const displayConfig = { chatBgRgb: [100, 100, 100] as [number, number, number], chatBgOpacity: 0.1 }
    updatePresetDisplayConfig('p1', displayConfig)

    const preset = getPresetById('p1')!
    expect(preset.displayConfig).toEqual(displayConfig)
    expect(preset.name).toBe('A')
    expect(preset.systemPrompt).toBe('a')
  })

  it('updatePresetSystemPrompt 更新后能通过 getPresetById 读回，其余字段不受影响', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: '原始人设', wallpaperPath: undefined })
    updatePresetSystemPrompt('p1', '新的人设正文')

    const preset = getPresetById('p1')!
    expect(preset.systemPrompt).toBe('新的人设正文')
    expect(preset.name).toBe('A')
  })

  it('encryptSensitiveFields=true 时 updatePresetSystemPrompt 加密落盘，getPresetById 解密后仍与原文一致', () => {
    const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
    process.env.ENCRYPT_SENSITIVE_FIELDS = 'true'
    try {
      upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: '原始人设', wallpaperPath: undefined })
      updatePresetSystemPrompt('p1', '加密后的人设正文')

      const raw = db.prepare(`SELECT systemPrompt FROM Presets WHERE presetId = ?`).get('p1') as any
      expect(raw.systemPrompt).not.toBe('加密后的人设正文')

      expect(getPresetById('p1')!.systemPrompt).toBe('加密后的人设正文')
    } finally {
      process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
    }
  })

  it('upsertPreset 不传 addressForms 时默认写入空数组', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
    expect(getPresetById('p1')!.addressForms).toEqual([])
  })

  it('upsertPreset 传入 addressForms 时按传入值写入', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined, addressForms: ['小明', '亲爱的'] })
    expect(getPresetById('p1')!.addressForms).toEqual(['小明', '亲爱的'])
  })

  it('getPresetById/getAllPresets 对迁移前的旧行（addressForms 列为 NULL）返回空数组，不告警', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
    // 模拟迁移前从未写过 addressForms 的历史行
    db.prepare(`UPDATE Presets SET addressForms = NULL WHERE presetId = ?`).run('p1')

    expect(getPresetById('p1')!.addressForms).toEqual([])
    expect(getAllPresets()[0].addressForms).toEqual([])
  })

  it('addressForms 列内容不是合法 JSON（数据损坏场景）时返回空数组并告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
    db.prepare(`UPDATE Presets SET addressForms = ? WHERE presetId = ?`).run('{not valid json', 'p1')

    expect(getPresetById('p1')!.addressForms).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('updatePresetAddressForms 更新后能通过 getPresetById 读回，其余字段不受影响', () => {
    upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
    updatePresetAddressForms('p1', ['小明', '笨蛋'])

    const preset = getPresetById('p1')!
    expect(preset.addressForms).toEqual(['小明', '笨蛋'])
    expect(preset.name).toBe('A')
    expect(preset.systemPrompt).toBe('a')
  })

  it('encryptSensitiveFields=true 时 updatePresetAddressForms 加密落盘，getPresetById 解密后仍与原文一致', () => {
    const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
    process.env.ENCRYPT_SENSITIVE_FIELDS = 'true'
    try {
      upsertPreset({ presetId: 'p1', name: 'A', characterId: 'c1', modelType: 'ollama', modelName: 'qwen3', systemPrompt: 'a', wallpaperPath: undefined })
      updatePresetAddressForms('p1', ['小明', '笨蛋'])

      const raw = db.prepare(`SELECT addressForms FROM Presets WHERE presetId = ?`).get('p1') as any
      expect(raw.addressForms).not.toBe(JSON.stringify(['小明', '笨蛋']))

      expect(getPresetById('p1')!.addressForms).toEqual(['小明', '笨蛋'])
    } finally {
      process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
    }
  })

  // createPreset：手动创建入口专用，故意与 upsertPreset 分开测试——
  // 见 docs/MintBot_TDD.md「角色创建：固定种子角色集 → 手动创建 UI + 角色卡导入」
  it('createPreset 插入后能用 getPresetById 读回，各字段（含 systemPrompt 解密）正确', () => {
    createPreset({
      presetId: 'p1',
      name: '新角色',
      characterId: 'char-001',
      modelType: null,
      modelName: null,
      wallpaperPath: undefined,
      displayConfig: DEFAULT_DISPLAY_CONFIG,
      systemPrompt: '你是新角色',
      addressForms: [],
    })

    const preset = getPresetById('p1')
    expect(preset).not.toBeNull()
    expect(preset!.name).toBe('新角色')
    expect(preset!.characterId).toBe('char-001')
    expect(preset!.modelType).toBeNull()
    expect(preset!.modelName).toBeNull()
    expect(preset!.wallpaperPath).toBeUndefined()
    expect(preset!.displayConfig).toEqual(DEFAULT_DISPLAY_CONFIG)
    expect(preset!.systemPrompt).toBe('你是新角色')
    expect(preset!.addressForms).toEqual([])
  })

  it('createPreset 撞上已存在的 presetId 时抛错，而不是静默覆盖（与 upsertPreset 的行为差异）', () => {
    createPreset({
      presetId: 'p1',
      name: '原角色',
      characterId: 'char-001',
      modelType: null,
      modelName: null,
      wallpaperPath: undefined,
      displayConfig: DEFAULT_DISPLAY_CONFIG,
      systemPrompt: '原始人设',
      addressForms: [],
    })

    expect(() => createPreset({
      presetId: 'p1',
      name: '撞车角色',
      characterId: 'char-002',
      modelType: null,
      modelName: null,
      wallpaperPath: undefined,
      displayConfig: DEFAULT_DISPLAY_CONFIG,
      systemPrompt: '撞车人设',
      addressForms: [],
    })).toThrow()

    // 原有行未被顶掉
    expect(getPresetById('p1')!.name).toBe('原角色')
    expect(getPresetById('p1')!.systemPrompt).toBe('原始人设')
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

describe('getMessagesPage', () => {
  it('limit 生效，返回最近 limit 条，正序排列，hasMore 为 true', () => {
    for (let i = 0; i < 5; i++) {
      appendMessage({ sessionId: 's1', role: 'user', content: `消息${i}`, createdAt: i * 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    }
    const { messages, hasMore } = getMessagesPage('s1', 3)
    expect(messages.map(m => m.content)).toEqual(['消息2', '消息3', '消息4'])
    expect(hasMore).toBe(true)
  })

  it('没有更多数据时 hasMore 为 false', () => {
    for (let i = 0; i < 3; i++) {
      appendMessage({ sessionId: 's1', role: 'user', content: `消息${i}`, createdAt: i * 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    }
    const { messages, hasMore } = getMessagesPage('s1', 3)
    expect(messages).toHaveLength(3)
    expect(hasMore).toBe(false)
  })

  it('beforeId 正确排除新消息，只取更旧的一页', () => {
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(appendMessage({ sessionId: 's1', role: 'user', content: `消息${i}`, createdAt: i * 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null }))
    }
    const { messages, hasMore } = getMessagesPage('s1', 3, ids[3])
    expect(messages.map(m => m.content)).toEqual(['消息0', '消息1', '消息2'])
    expect(hasMore).toBe(false)
  })

  it('连续翻页不重复不遗漏：7 条消息 limit=3 翻 3 页', () => {
    for (let i = 0; i < 7; i++) {
      appendMessage({ sessionId: 's1', role: 'user', content: `消息${i}`, createdAt: i * 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    }

    const page1 = getMessagesPage('s1', 3)
    expect(page1.messages.map(m => m.content)).toEqual(['消息4', '消息5', '消息6'])
    expect(page1.hasMore).toBe(true)

    const page2 = getMessagesPage('s1', 3, page1.messages[0].id)
    expect(page2.messages.map(m => m.content)).toEqual(['消息1', '消息2', '消息3'])
    expect(page2.hasMore).toBe(true)

    const page3 = getMessagesPage('s1', 3, page2.messages[0].id)
    expect(page3.messages.map(m => m.content)).toEqual(['消息0'])
    expect(page3.hasMore).toBe(false)
  })

  it('过滤 visibleToUser = false 的消息', () => {
    appendMessage({ sessionId: 's1', role: 'user', content: '可见', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'user', content: '不可见', createdAt: 2000, embedded: false, summarized: false, visibleToUser: false, trigger: 'scheduler', triggerEventId: null })
    const { messages } = getMessagesPage('s1', 10)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('可见')
  })

  it('多 session 隔离，不跨 session 泄漏', () => {
    appendMessage({ sessionId: 's1', role: 'user', content: 's1消息', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's2', role: 'user', content: 's2消息', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    const { messages } = getMessagesPage('s1', 10)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('s1消息')
  })
})

// ─── Pending summaries (Messages.summarized) ───────────────

describe('getSessionsWithPendingSummaries / getPendingSummaryCount', () => {
  it('无待摘要消息时 getSessionsWithPendingSummaries 返回空数组，getPendingSummaryCount 返回 0', () => {
    expect(getSessionsWithPendingSummaries()).toEqual([])
    expect(getPendingSummaryCount('s1')).toBe(0)
  })

  it('有待摘要消息时能正确列出 session 并统计数量', () => {
    appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'user', content: 'b', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's2', role: 'user', content: 'c', createdAt: 3000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's2', role: 'user', content: 'd', createdAt: 4000, embedded: false, summarized: true, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getSessionsWithPendingSummaries().sort()).toEqual(['s1', 's2'])
    expect(getPendingSummaryCount('s1')).toBe(2)
    expect(getPendingSummaryCount('s2')).toBe(1)
  })

  it('session 内消息全部已摘要时不再出现在 getSessionsWithPendingSummaries 中', () => {
    appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: true, visibleToUser: true, trigger: 'user', triggerEventId: null })
    expect(getSessionsWithPendingSummaries()).toEqual([])
    expect(getPendingSummaryCount('s1')).toBe(0)
  })

  it('按 session 最后一条消息时间（不限于未摘要的）降序返回：最近还在聊的 session 排在前面', () => {
    // s1 最后一条消息在 1000（早），s2 最后一条消息在 5000（晚，且是已摘要消息，
    // 但仍代表该 session 最近还在聊），s3 最后一条消息在 3000（居中）
    appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's2', role: 'user', content: 'b', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's2', role: 'user', content: 'c', createdAt: 5000, embedded: false, summarized: true, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's3', role: 'user', content: 'd', createdAt: 3000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getSessionsWithPendingSummaries()).toEqual(['s2', 's3', 's1'])
  })
})

// ─── 当前激活角色 vs. 全局队列（EmbeddingQueueStatus 拆分字段的底层查询）────

describe('getPendingEmbeddingCountForSession / getOldestPendingEmbeddingTimeForSession / getPendingEmbeddingCountBefore', () => {
  it('session 没有待 embedding 消息时，count 为 0，oldest 为 null', () => {
    expect(getPendingEmbeddingCountForSession('s1')).toBe(0)
    expect(getOldestPendingEmbeddingTimeForSession('s1')).toBeNull()
  })

  it('只统计指定 session 自己的待 embedding 消息，不受其它 session 影响', () => {
    appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'user', content: 'b', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's2', role: 'user', content: 'c', createdAt: 500, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getPendingEmbeddingCountForSession('s1')).toBe(2)
    expect(getOldestPendingEmbeddingTimeForSession('s1')).toBe(1000)
    expect(getPendingEmbeddingCountForSession('s2')).toBe(1)
  })

  it('已 embedded 的消息不计入 count/oldest', () => {
    const id = appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    markMessageEmbedded(id)
    appendMessage({ sessionId: 's1', role: 'user', content: 'b', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getPendingEmbeddingCountForSession('s1')).toBe(1)
    expect(getOldestPendingEmbeddingTimeForSession('s1')).toBe(2000)
  })

  it('getPendingEmbeddingCountBefore 统计全局早于给定时间且未 embedded 的消息数（跨 session）', () => {
    appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's2', role: 'user', content: 'b', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's3', role: 'user', content: 'c', createdAt: 3000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getPendingEmbeddingCountBefore(3000)).toBe(2)
    expect(getPendingEmbeddingCountBefore(1000)).toBe(0)
    expect(getPendingEmbeddingCountBefore(3001)).toBe(3)
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

  it('getMostRecentMessageTime 无消息时返回 null，有消息时返回全表最大 createdAt（不分 session）', () => {
    expect(getMostRecentMessageTime()).toBeNull()

    appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's2', role: 'user', content: 'b', createdAt: 3000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'user', content: 'c', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getMostRecentMessageTime()).toBe(3000)
  })

  it('getOldestUnsummarizedMessageTime 无未摘要消息时返回 null，有时返回全表最小 createdAt（不分 session）', () => {
    expect(getOldestUnsummarizedMessageTime()).toBeNull()

    appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's2', role: 'user', content: 'b', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'user', content: 'c', createdAt: 500, embedded: false, summarized: true, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getOldestUnsummarizedMessageTime()).toBe(1000)
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

describe('getCurrentEntitiesPage', () => {
  it('limit 生效，返回最近 limit 条，按 id 正序排列，hasMore 为 true', () => {
    for (let i = 0; i < 5; i++) {
      insertEntity({ messageId: i, sessionId: 's1', type: 'preference', value: `偏好${i}`, validFrom: 1000 })
    }
    const { entities, hasMore } = getCurrentEntitiesPage('s1', 3)
    expect(entities.map(e => e.value)).toEqual(['偏好2', '偏好3', '偏好4'])
    expect(hasMore).toBe(true)
  })

  it('没有更多数据时 hasMore 为 false', () => {
    for (let i = 0; i < 3; i++) {
      insertEntity({ messageId: i, sessionId: 's1', type: 'preference', value: `偏好${i}`, validFrom: 1000 })
    }
    const { entities, hasMore } = getCurrentEntitiesPage('s1', 3)
    expect(entities).toHaveLength(3)
    expect(hasMore).toBe(false)
  })

  it('beforeId 正确排除新记录，只取更旧的一页', () => {
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(insertEntity({ messageId: i, sessionId: 's1', type: 'preference', value: `偏好${i}`, validFrom: 1000 }))
    }
    const { entities, hasMore } = getCurrentEntitiesPage('s1', 3, ids[3])
    expect(entities.map(e => e.value)).toEqual(['偏好0', '偏好1', '偏好2'])
    expect(hasMore).toBe(false)
  })

  it('type 过滤与分页组合使用', () => {
    for (let i = 0; i < 3; i++) {
      insertEntity({ messageId: i, sessionId: 's1', type: 'preference', value: `偏好${i}`, validFrom: 1000 })
    }
    for (let i = 0; i < 3; i++) {
      insertEntity({ messageId: i, sessionId: 's1', type: 'person', value: `人物${i}`, validFrom: 1000 })
    }
    const { entities, hasMore } = getCurrentEntitiesPage('s1', 2, undefined, 'preference')
    expect(entities.map(e => e.value)).toEqual(['偏好1', '偏好2'])
    expect(hasMore).toBe(true)
  })

  it('已关闭（validUntil 已设置）的实体不返回，与 getCurrentEntities 行为一致', () => {
    const id = insertEntity({ messageId: 1, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })
    closeEntity(id, 5000)
    const { entities } = getCurrentEntitiesPage('s1', 10)
    expect(entities).toHaveLength(0)
  })
})

// ─── getMessageCreatedAtByIds（RAG 召回新鲜度加成排序用）─────
describe('getMessageCreatedAtByIds', () => {
  it('按 id 批量返回 createdAt', () => {
    const id1 = appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    const id2 = appendMessage({ sessionId: 's1', role: 'user', content: 'b', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    const result = getMessageCreatedAtByIds([id1, id2])

    expect(result.get(id1)).toBe(1000)
    expect(result.get(id2)).toBe(2000)
  })

  it('传入不存在的 id 时该 id 不出现在返回的 Map 中', () => {
    const id1 = appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    const result = getMessageCreatedAtByIds([id1, 99999])

    expect(result.get(id1)).toBe(1000)
    expect(result.has(99999)).toBe(false)
    expect(result.size).toBe(1)
  })

  it('空数组输入返回空 Map', () => {
    expect(getMessageCreatedAtByIds([])).toEqual(new Map())
  })
})

// ─── getSupersededMessageIds（RAG 召回"可能已过时"标注用）────
describe('getSupersededMessageIds', () => {
  it('消息关联的实体已被 closeEntity 关闭时，该消息 id 出现在返回的 Set 中', () => {
    const entityId = insertEntity({ messageId: 1, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })
    closeEntity(entityId, 5000)

    const result = getSupersededMessageIds([1])

    expect(result.has(1)).toBe(true)
  })

  it('实体未关闭（validUntil IS NULL）的消息不会被误判为过时', () => {
    insertEntity({ messageId: 1, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })

    const result = getSupersededMessageIds([1])

    expect(result.has(1)).toBe(false)
  })

  it('传入不存在关联实体的 id 不会出现在返回的 Set 中', () => {
    const result = getSupersededMessageIds([12345])
    expect(result.has(12345)).toBe(false)
  })

  it('空数组输入返回空 Set', () => {
    expect(getSupersededMessageIds([])).toEqual(new Set())
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
// tokenize = 'simple'（wangfenjin/simple，libsimple 扩展，DIV-002 修复）：中文按逐字符子串
// 索引，可命中任意跨"词"边界的子串；英文仍按连续字母整词索引，行为与旧的 unicode61 一致。
// 拼音检索（官方文档提到的功能）实测未生效，不在本次修复范围内，不在此断言。
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

  it('中文 2 字词可命中（DIV-002）', () => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
    indexMessageFts(1, 's1', '我喜欢猫和狗')
    indexMessageFts(2, 's1', '今天天气很好')

    const results = searchMessagesFts('喜欢')
    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe(1)
  })

  it('中文单字可命中', () => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
    indexMessageFts(1, 's1', '我喜欢猫和狗')

    const results = searchMessagesFts('猫')
    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe(1)
  })

  it('专有名词（游戏名/人名）可命中', () => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
    indexMessageFts(1, 's1', '我最近在玩原神')
    indexMessageFts(2, 's1', '张三昨天来找我了')

    expect(searchMessagesFts('原神')).toHaveLength(1)
    expect(searchMessagesFts('张三')).toHaveLength(1)
  })

  it('跨"词"边界的中文子串可命中（逐字符索引，不依赖分词边界）', () => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
    indexMessageFts(1, 's1', '我喜欢猫和狗')

    // "欢猫" 横跨"喜欢"和"猫"两个词边界，不是一个真实存在的词
    const results = searchMessagesFts('欢猫')
    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe(1)
  })
})

// backfillMessageFts 是 v5 迁移（DIV-002：message_fts 分词器换成 simple）里"回填已 embedded
// 历史消息"那一步的实现，这里直接单测这个函数本身，而不是重跑一次完整迁移（迁移只在
// initDb() 首次建库时按 user_version 触发一次）
describe('backfillMessageFts (v5 迁移回填逻辑)', () => {
  const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
  afterEach(() => {
    process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
  })

  it('embedded=1 但未出现在 message_fts 里的历史消息（模拟迁移前 drop 后的状态），回填后可被关键词召回', () => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
    // 模拟迁移场景：这些消息在旧表里已经 embedded=1，但 message_fts 表刚被 drop + 重建，是空的
    const id1 = appendMessage({
      sessionId: 's1', role: 'user', content: '我喜欢猫和狗',
      createdAt: 1000, embedded: true, summarized: false, visibleToUser: true,
      trigger: 'user', triggerEventId: null,
    })
    const id2 = appendMessage({
      sessionId: 's1', role: 'user', content: '今天天气很好',
      createdAt: 2000, embedded: true, summarized: false, visibleToUser: true,
      trigger: 'user', triggerEventId: null,
    })

    expect(searchMessagesFts('猫')).toEqual([])

    const backfilledCount = backfillMessageFts()
    expect(backfilledCount).toBe(2)

    const results = searchMessagesFts('猫')
    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe(id1)
    void id2
  })

  it('未 embedded 的消息不参与回填', () => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
    appendMessage({
      sessionId: 's1', role: 'user', content: '还没处理的消息',
      createdAt: 1000, embedded: false, summarized: false, visibleToUser: true,
      trigger: 'user', triggerEventId: null,
    })

    expect(backfillMessageFts()).toBe(0)
    expect(searchMessagesFts('处理')).toEqual([])
  })
})

// ─── Summaries ────────────────────────────────────────────

describe('getSummaries', () => {
  it('没有摘要时返回空数组', () => {
    expect(getSummaries('s1')).toEqual([])
  })

  it('按 createdAt 升序返回该 session 的全部摘要，content 解密正确（往返验证）', () => {
    // insertSummary 内部用 Date.now() 写入 createdAt（不暴露可控参数），这里插入后直接改写
    // createdAt 确保两条摘要时间戳不同，避免同一毫秒内插入导致排序断言不稳定
    const id1 = insertSummary({ sessionId: 's1', content: '第一段摘要', fromMessageId: 1, toMessageId: 2 })
    const id2 = insertSummary({ sessionId: 's1', content: '第二段摘要', fromMessageId: 3, toMessageId: 4 })
    insertSummary({ sessionId: 's2', content: '别的会话摘要', fromMessageId: 1, toMessageId: 1 })
    db.prepare(`UPDATE Summaries SET createdAt = 1000 WHERE id = ?`).run(id1)
    db.prepare(`UPDATE Summaries SET createdAt = 2000 WHERE id = ?`).run(id2)

    const summaries = getSummaries('s1')
    expect(summaries).toHaveLength(2)
    expect(summaries[0].id).toBe(id1)
    expect(summaries[0].content).toBe('第一段摘要')
    expect(summaries[1].id).toBe(id2)
    expect(summaries[1].content).toBe('第二段摘要')
  })

  it('encryptSensitiveFields=true 时落盘 content 非明文，getSummaries 解密后仍能正确还原', () => {
    const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
    process.env.ENCRYPT_SENSITIVE_FIELDS = 'true'
    try {
      const id = insertSummary({ sessionId: 's1', content: '加密摘要正文', fromMessageId: 1, toMessageId: 1 })
      const raw = db.prepare(`SELECT content FROM Summaries WHERE id = ?`).get(id) as any
      expect(raw.content).not.toBe('加密摘要正文')

      const summaries = getSummaries('s1')
      expect(summaries[0].content).toBe('加密摘要正文')
    } finally {
      process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
    }
  })
})

// ─── Forget（按时间段硬删除，隐私/后悔场景）─────────────────

describe('getMessageIdsInTimeRange', () => {
  it('闭区间边界：createdAt 恰好等于 fromTime/toTime 时包含在内', () => {
    const id1 = appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    const id2 = appendMessage({ sessionId: 's1', role: 'user', content: 'b', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'user', content: 'c', createdAt: 2001, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getMessageIdsInTimeRange('s1', 1000, 2000)).toEqual([id1, id2])
  })

  it('范围外的消息不返回', () => {
    appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 500, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's1', role: 'user', content: 'b', createdAt: 3000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getMessageIdsInTimeRange('s1', 1000, 2000)).toEqual([])
  })

  it('跨 session 隔离', () => {
    const id1 = appendMessage({ sessionId: 's1', role: 'user', content: 'a', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId: 's2', role: 'user', content: 'b', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getMessageIdsInTimeRange('s1', 0, 5000)).toEqual([id1])
  })

  it('无消息时返回空数组', () => {
    expect(getMessageIdsInTimeRange('s1', 0, 5000)).toEqual([])
  })
})

describe('getSummariesOverlappingRange', () => {
  it('摘要完全在范围内：返回该摘要', () => {
    const id = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: 3, toMessageId: 5 })
    const results = getSummariesOverlappingRange('s1', 1, 10)
    expect(results.map(s => s.id)).toEqual([id])
  })

  it('左边界部分重叠（摘要跨入范围左侧）：返回该摘要', () => {
    const id = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: 1, toMessageId: 5 })
    const results = getSummariesOverlappingRange('s1', 5, 10)
    expect(results.map(s => s.id)).toEqual([id])
  })

  it('右边界部分重叠（摘要跨出范围右侧）：返回该摘要', () => {
    const id = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: 8, toMessageId: 15 })
    const results = getSummariesOverlappingRange('s1', 5, 10)
    expect(results.map(s => s.id)).toEqual([id])
  })

  it('完全在范围外：不返回', () => {
    insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: 20, toMessageId: 30 })
    expect(getSummariesOverlappingRange('s1', 1, 10)).toEqual([])
  })

  it('恰好相邻但不重叠：不返回', () => {
    insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: 11, toMessageId: 20 })
    expect(getSummariesOverlappingRange('s1', 1, 10)).toEqual([])
  })

  it('跨 session 隔离', () => {
    insertSummary({ sessionId: 's2', content: '别的会话摘要', fromMessageId: 3, toMessageId: 5 })
    expect(getSummariesOverlappingRange('s1', 1, 10)).toEqual([])
  })

  it('content 解密正确', () => {
    insertSummary({ sessionId: 's1', content: '真实摘要正文', fromMessageId: 3, toMessageId: 5 })
    const results = getSummariesOverlappingRange('s1', 1, 10)
    expect(results[0].content).toBe('真实摘要正文')
  })
})

describe('forgetMessages', () => {
  it('级联删除 message_embeddings/message_fts/MessageEntities/Messages', () => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
    const id1 = appendMessage({ sessionId: 's1', role: 'user', content: '待删1', createdAt: 1000, embedded: true, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    const id2 = appendMessage({ sessionId: 's1', role: 'user', content: '待删2', createdAt: 2000, embedded: true, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    upsertMessageEmbedding(id1, 's1', vec(0, 1))
    upsertMessageEmbedding(id2, 's1', vec(0, 0.5))
    indexMessageFts(id1, 's1', '待删1')
    indexMessageFts(id2, 's1', '待删2')
    insertEntity({ messageId: id1, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })
    insertEntity({ messageId: id2, sessionId: 's1', type: 'preference', value: '喜欢狗', validFrom: 2000 })

    const result = forgetMessages({ sessionId: 's1', messageIds: [id1, id2], summaryIdsToDelete: [] })

    expect(result.deletedMessages).toBe(2)
    expect(result.deletedEntities).toBe(2)
    expect(result.deletedEmbeddings).toBe(2)
    expect(result.deletedFts).toBe(2)
    expect(result.deletedSummaries).toBe(0)

    expect(getMessagesByIds([id1, id2])).toEqual([])
    expect(searchSimilarMessages(vec(0, 1), 5, 's1')).toEqual([])
    expect(searchMessagesFts('待删')).toEqual([])
    expect(getCurrentEntities('s1')).toEqual([])
  })

  it('不在 summaryIdsToDelete 里的摘要不受影响', () => {
    const id1 = appendMessage({ sessionId: 's1', role: 'user', content: '待删', createdAt: 1000, embedded: false, summarized: true, visibleToUser: true, trigger: 'user', triggerEventId: null })
    const summaryId = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: id1, toMessageId: id1 })

    const result = forgetMessages({ sessionId: 's1', messageIds: [id1], summaryIdsToDelete: [] })

    expect(result.deletedSummaries).toBe(0)
    expect(getSummaries('s1').map(s => s.id)).toEqual([summaryId])
  })

  it('指定的 summaryIdsToDelete 会被删除', () => {
    const id1 = appendMessage({ sessionId: 's1', role: 'user', content: '待删', createdAt: 1000, embedded: false, summarized: true, visibleToUser: true, trigger: 'user', triggerEventId: null })
    const summaryId = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: id1, toMessageId: id1 })

    const result = forgetMessages({ sessionId: 's1', messageIds: [id1], summaryIdsToDelete: [summaryId] })

    expect(result.deletedSummaries).toBe(1)
    expect(getSummaries('s1')).toEqual([])
  })

  it('未被指定删除的其它消息/其它 session 数据不受影响', () => {
    const targetId = appendMessage({ sessionId: 's1', role: 'user', content: '待删', createdAt: 1000, embedded: true, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    const keepId = appendMessage({ sessionId: 's1', role: 'user', content: '保留', createdAt: 2000, embedded: true, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    const otherSessionId = appendMessage({ sessionId: 's2', role: 'user', content: '别的会话', createdAt: 1000, embedded: true, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    upsertMessageEmbedding(targetId, 's1', vec(0, 1))
    upsertMessageEmbedding(keepId, 's1', vec(0, 0.5))
    upsertMessageEmbedding(otherSessionId, 's2', vec(0, 0.2))
    insertEntity({ messageId: keepId, sessionId: 's1', type: 'preference', value: '保留实体', validFrom: 2000 })

    forgetMessages({ sessionId: 's1', messageIds: [targetId], summaryIdsToDelete: [] })

    expect(getMessagesByIds([keepId, otherSessionId])).toHaveLength(2)
    expect(searchSimilarMessages(vec(0, 0.5), 5, 's1').map(r => r.messageId)).toEqual([keepId])
    expect(searchSimilarMessages(vec(0, 0.2), 5, 's2').map(r => r.messageId)).toEqual([otherSessionId])
    expect(getCurrentEntities('s1')).toHaveLength(1)
  })

  it('传入的 messageId 实际属于另一个 sessionId 时，纵深防御过滤会拦住，不跨 session 删除', () => {
    const otherSessionMsgId = appendMessage({ sessionId: 's2', role: 'user', content: '别的会话', createdAt: 1000, embedded: true, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    upsertMessageEmbedding(otherSessionMsgId, 's2', vec(0, 1))
    indexMessageFts(otherSessionMsgId, 's2', '别的会话')
    insertEntity({ messageId: otherSessionMsgId, sessionId: 's2', type: 'preference', value: '别的实体', validFrom: 1000 })

    const result = forgetMessages({ sessionId: 's1', messageIds: [otherSessionMsgId], summaryIdsToDelete: [] })

    expect(result).toEqual({ deletedMessages: 0, deletedEntities: 0, deletedSummaries: 0, deletedEmbeddings: 0, deletedFts: 0 })
    expect(getMessagesByIds([otherSessionMsgId])).toHaveLength(1)
    expect(searchSimilarMessages(vec(0, 1), 5, 's2').map(r => r.messageId)).toEqual([otherSessionMsgId])
    expect(getCurrentEntities('s2')).toHaveLength(1)
  })

  it('空 messageIds 数组时不抛错、返回全 0、不产生任何数据库改动', () => {
    const id1 = appendMessage({ sessionId: 's1', role: 'user', content: '保留', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    const result = forgetMessages({ sessionId: 's1', messageIds: [], summaryIdsToDelete: [999] })

    expect(result).toEqual({ deletedMessages: 0, deletedEntities: 0, deletedSummaries: 0, deletedEmbeddings: 0, deletedFts: 0 })
    expect(getMessagesByIds([id1])).toHaveLength(1)
  })
})
