import { db } from '../db/index.js'
import { encrypt, decrypt } from '../db/crypto.js'
import { getEncryptSensitiveFields } from '../config/security.js'
import type { Message, Session, Preset, PresetSnapshot, MessageEntity, Summary, EmotionState } from '../../../shared/types/index.js'

// ─── Preset ───────────────────────────────────────────────

export function getPresetById(presetId: string): Preset | null {
  const row = db.prepare(`SELECT * FROM Presets WHERE presetId = ?`).get(presetId) as any
  if (!row) return null
  return {
    ...row,
    wallpaperPath: row.wallpaperPath ?? undefined,
    systemPrompt: decrypt(row.systemPrompt),
  }
}

export function getAllPresets(): Preset[] {
  const rows = db.prepare(`SELECT * FROM Presets ORDER BY updatedAt DESC`).all() as any[]
  return rows.map(row => ({ ...row, wallpaperPath: row.wallpaperPath ?? undefined, systemPrompt: decrypt(row.systemPrompt) }))
}

export function upsertPreset(preset: Omit<Preset, 'createdAt' | 'updatedAt'>): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO Presets (presetId, name, characterId, modelType, modelName, wallpaperPath, systemPrompt, createdAt, updatedAt)
    VALUES (@presetId, @name, @characterId, @modelType, @modelName, @wallpaperPath, @systemPrompt, @createdAt, @updatedAt)
    ON CONFLICT(presetId) DO UPDATE SET
      name = excluded.name,
      characterId = excluded.characterId,
      modelType = excluded.modelType,
      modelName = excluded.modelName,
      wallpaperPath = excluded.wallpaperPath,
      systemPrompt = excluded.systemPrompt,
      updatedAt = excluded.updatedAt
  `).run({
    ...preset,
    wallpaperPath: preset.wallpaperPath ?? null,
    systemPrompt: encrypt(preset.systemPrompt),
    createdAt: now,
    updatedAt: now,
  })
}

// ─── Session ──────────────────────────────────────────────

export function getLatestSessionByPreset(presetId: string): Session | null {
  const row = db.prepare(`
    SELECT * FROM Sessions WHERE presetId = ? ORDER BY lastActiveAt DESC LIMIT 1
  `).get(presetId) as any
  if (!row) return null
  return {
    ...row,
    presetSnapshot: JSON.parse(row.presetSnapshot) as PresetSnapshot,
    title: row.title ?? undefined,
  }
}

export function createSession(session: Session): void {
  db.prepare(`
    INSERT INTO Sessions (sessionId, presetId, presetSnapshot, title, createdAt, lastActiveAt)
    VALUES (@sessionId, @presetId, @presetSnapshot, @title, @createdAt, @lastActiveAt)
  `).run({
    ...session,
    presetSnapshot: JSON.stringify(session.presetSnapshot),
    title: session.title ?? null,
  })
}

export function touchSession(sessionId: string): void {
  db.prepare(`UPDATE Sessions SET lastActiveAt = ? WHERE sessionId = ?`)
    .run(Date.now(), sessionId)
}

// ─── Messages ─────────────────────────────────────────────

export function getRecentMessages(sessionId: string, limit = 50): Message[] {
  const rows = db.prepare(`
    SELECT * FROM Messages
    WHERE sessionId = ? AND visibleToUser = 1
    ORDER BY createdAt DESC
    LIMIT ?
  `).all(sessionId, limit) as any[]

  return rows
    .reverse()  // 返回正序
    .map(row => ({
      ...row,
      content: decrypt(row.content),
      embedded: row.embedded === 1,
      summarized: row.summarized === 1,
      visibleToUser: row.visibleToUser === 1,
    }))
}

export function appendMessage(msg: Omit<Message, 'id'>): number {
  const result = db.prepare(`
    INSERT INTO Messages
      (sessionId, role, content, createdAt, embedded, summarized, visibleToUser, trigger, triggerEventId)
    VALUES
      (@sessionId, @role, @content, @createdAt, @embedded, @summarized, @visibleToUser, @trigger, @triggerEventId)
  `).run({
    ...msg,
    content: encrypt(msg.content),
    embedded: msg.embedded ? 1 : 0,
    summarized: msg.summarized ? 1 : 0,
    visibleToUser: msg.visibleToUser ? 1 : 0,
  })
  return result.lastInsertRowid as number
}

// ─── Embeddings (message_embeddings) ─────────────────────────

// sqlite-vec 写入格式选择：vec0 虚拟表接受 JSON 文本或原始 float32 二进制两种绑定值。
// 这里选择 Float32Array 打包成 Buffer 的二进制格式：BGE-large 实际产出 1024 维向量，
// 二进制格式避免 1024 个浮点数的 JSON 序列化/解析开销，且与列声明 FLOAT[1024] 的存储布局直接对应。
function toVecBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer)
}

export interface EmbeddingSearchResult {
  messageId: number
  sessionId: string
  distance: number
}

// better-sqlite3 默认把 JS number 绑定为 SQLite REAL 类型，而 vec0 的 rowid 主键列
// 严格要求 INTEGER 类型，这里显式转 BigInt 保证绑定类型正确
export function upsertMessageEmbedding(messageId: number, sessionId: string, embedding: number[]): void {
  db.prepare(`
    INSERT OR REPLACE INTO message_embeddings (message_id, session_id, embedding)
    VALUES (@messageId, @sessionId, @embedding)
  `).run({ messageId: BigInt(messageId), sessionId, embedding: toVecBuffer(embedding) })
}

export function searchSimilarMessages(embedding: number[], k: number, sessionId?: string): EmbeddingSearchResult[] {
  const params = { embedding: toVecBuffer(embedding), k, sessionId }
  const rows = (sessionId
    ? db.prepare(`
        SELECT message_id, session_id, distance FROM message_embeddings
        WHERE embedding MATCH @embedding AND k = @k AND session_id = @sessionId
        ORDER BY distance
      `).all(params)
    : db.prepare(`
        SELECT message_id, session_id, distance FROM message_embeddings
        WHERE embedding MATCH @embedding AND k = @k
        ORDER BY distance
      `).all(params)
  ) as any[]

  return rows.map(row => ({
    messageId: row.message_id,
    sessionId: row.session_id,
    distance: row.distance,
  }))
}

// 与 Messages.embedded 标志配套的待处理队列查询，供整理模式批量 embedding 使用
export function getPendingEmbeddingMessages(limit = 200): Message[] {
  const rows = db.prepare(`
    SELECT * FROM Messages WHERE embedded = 0 ORDER BY createdAt ASC LIMIT ?
  `).all(limit) as any[]

  return rows.map(row => ({
    ...row,
    content: decrypt(row.content),
    embedded: row.embedded === 1,
    summarized: row.summarized === 1,
    visibleToUser: row.visibleToUser === 1,
  }))
}

export function getPendingEmbeddingCount(): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM Messages WHERE embedded = 0`).get() as any
  return row.count
}

export function markMessageEmbedded(messageId: number): void {
  db.prepare(`UPDATE Messages SET embedded = 1 WHERE id = ?`).run(messageId)
}

// 全表（不分 session）最近一条消息的 createdAt，供整理模式编排器判断 activeConversation
// （TDD §3.8："最近 5 分钟内是否有消息"，为全局判断，不分 session）
export function getMostRecentMessageTime(): number | null {
  const row = db.prepare(`SELECT MAX(createdAt) as maxCreatedAt FROM Messages`).get() as any
  return row.maxCreatedAt ?? null
}

// 全表（不分 session）最早一条未摘要消息的 createdAt，供 EmbeddingQueueStatus.oldestUnsummarizedAge 使用
export function getOldestUnsummarizedMessageTime(): number | null {
  const row = db.prepare(`SELECT MIN(createdAt) as minCreatedAt FROM Messages WHERE summarized = 0`).get() as any
  return row.minCreatedAt ?? null
}

// 按 id 批量取消息（已解密），供 RAG 召回（retrieval.ts）按融合排序回查原文使用
export function getMessagesByIds(ids: number[]): Message[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT * FROM Messages WHERE id IN (${placeholders})`).all(...ids) as any[]

  return rows.map(row => ({
    ...row,
    content: decrypt(row.content),
    embedded: row.embedded === 1,
    summarized: row.summarized === 1,
    visibleToUser: row.visibleToUser === 1,
  }))
}

// 与 Messages.summarized 标志配套的待摘要消息查询（按 session），供摘要生成（summarizer.ts）使用。
// limit 与 embedQueue.ts 的 batchSize 同款默认值（200），避免一次性把过大的 backlog 塞进单次模型调用
export function getPendingSummaryMessages(sessionId: string, limit = 200): Message[] {
  const rows = db.prepare(`
    SELECT * FROM Messages WHERE sessionId = ? AND summarized = 0 ORDER BY createdAt ASC, id ASC LIMIT ?
  `).all(sessionId, limit) as any[]

  return rows.map(row => ({
    ...row,
    content: decrypt(row.content),
    embedded: row.embedded === 1,
    summarized: row.summarized === 1,
    visibleToUser: row.visibleToUser === 1,
  }))
}

// 有待摘要消息的 session 列表，供整理模式编排器（orchestrator.ts）遍历处理
export function getSessionsWithPendingSummaries(): string[] {
  const rows = db.prepare(`SELECT DISTINCT sessionId FROM Messages WHERE summarized = 0`).all() as any[]
  return rows.map(row => row.sessionId)
}

// 对应 session 的待摘要消息数，供 shouldTriggerSummary 的 messageCountSinceLastSummary 输入使用
export function getPendingSummaryCount(sessionId: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM Messages WHERE sessionId = ? AND summarized = 0`).get(sessionId) as any
  return row.count
}

export function markMessagesSummarized(messageIds: number[]): void {
  if (messageIds.length === 0) return
  const placeholders = messageIds.map(() => '?').join(',')
  db.prepare(`UPDATE Messages SET summarized = 1 WHERE id IN (${placeholders})`).run(...messageIds)
}

// ─── Entities (MessageEntities，双时态) ───────────────────────

export function insertEntity(entity: Omit<MessageEntity, 'id' | 'createdAt' | 'validUntil'> & { validUntil?: number | null }): number {
  const result = db.prepare(`
    INSERT INTO MessageEntities (messageId, sessionId, type, value, validFrom, validUntil, createdAt)
    VALUES (@messageId, @sessionId, @type, @value, @validFrom, @validUntil, @createdAt)
  `).run({
    messageId: entity.messageId,
    sessionId: entity.sessionId,
    type: entity.type,
    value: encrypt(entity.value),
    validFrom: entity.validFrom,
    validUntil: entity.validUntil ?? null,
    createdAt: Date.now(),
  })
  return result.lastInsertRowid as number
}

// 当前仍有效的实体（validUntil IS NULL），可选按 type 过滤
export function getCurrentEntities(sessionId: string, type?: MessageEntity['type']): MessageEntity[] {
  const rows = (type
    ? db.prepare(`
        SELECT * FROM MessageEntities
        WHERE sessionId = ? AND type = ? AND validUntil IS NULL
        ORDER BY validFrom DESC
      `).all(sessionId, type)
    : db.prepare(`
        SELECT * FROM MessageEntities
        WHERE sessionId = ? AND validUntil IS NULL
        ORDER BY validFrom DESC
      `).all(sessionId)
  ) as any[]

  return rows.map(row => ({ ...row, value: decrypt(row.value) }))
}

// 双时态 as-of 查询：某时间点当时仍有效的实体
export function getEntitiesAsOf(sessionId: string, timestamp: number, type?: MessageEntity['type']): MessageEntity[] {
  const rows = (type
    ? db.prepare(`
        SELECT * FROM MessageEntities
        WHERE sessionId = ? AND type = ? AND validFrom <= ? AND (validUntil IS NULL OR validUntil > ?)
        ORDER BY validFrom DESC
      `).all(sessionId, type, timestamp, timestamp)
    : db.prepare(`
        SELECT * FROM MessageEntities
        WHERE sessionId = ? AND validFrom <= ? AND (validUntil IS NULL OR validUntil > ?)
        ORDER BY validFrom DESC
      `).all(sessionId, timestamp, timestamp)
  ) as any[]

  return rows.map(row => ({ ...row, value: decrypt(row.value) }))
}

// 双时态关闭：不硬删除历史，只标记失效时间
export function closeEntity(id: number, validUntil: number = Date.now()): void {
  db.prepare(`UPDATE MessageEntities SET validUntil = ? WHERE id = ?`).run(validUntil, id)
}

// ─── FTS (message_fts，与 encryptSensitiveFields 共用同一开关) ───

export interface FtsSearchResult {
  messageId: number
  sessionId: string
  rank: number
}

// 索引消息明文内容用于关键词召回。encryptSensitiveFields = true（线上部署）时不落盘明文，直接 no-op，
// 召回退化为纯向量检索；= false（本地默认）时正常写入 FTS 索引
export function indexMessageFts(messageId: number, sessionId: string, content: string): void {
  if (getEncryptSensitiveFields()) return
  db.prepare(`
    INSERT INTO message_fts (content, message_id, session_id)
    VALUES (@content, @messageId, @sessionId)
  `).run({ content, messageId, sessionId })
}

// 关键词召回。encryptSensitiveFields = true 时索引本就为空，直接返回 []（不发起 MATCH 查询）
export function searchMessagesFts(query: string, sessionId?: string, limit = 10): FtsSearchResult[] {
  if (getEncryptSensitiveFields()) return []

  const params = { query, sessionId, limit }
  const rows = (sessionId
    ? db.prepare(`
        SELECT message_id, session_id, rank FROM message_fts
        WHERE content MATCH @query AND session_id = @sessionId
        ORDER BY rank LIMIT @limit
      `).all(params)
    : db.prepare(`
        SELECT message_id, session_id, rank FROM message_fts
        WHERE content MATCH @query
        ORDER BY rank LIMIT @limit
      `).all(params)
  ) as any[]

  return rows.map(row => ({
    messageId: row.message_id,
    sessionId: row.session_id,
    rank: row.rank,
  }))
}

// ─── Summaries ────────────────────────────────────────────
// content 属于 TDD §3.6 加密字段范围（消息内容、角色设定、API Key、摘要、实体聚合结果），
// 与 Messages/MessageEntities 一致过 encrypt()/decrypt()

export function insertSummary(summary: Omit<Summary, 'id' | 'createdAt'>): number {
  const result = db.prepare(`
    INSERT INTO Summaries (sessionId, content, fromMessageId, toMessageId, createdAt)
    VALUES (@sessionId, @content, @fromMessageId, @toMessageId, @createdAt)
  `).run({ ...summary, content: encrypt(summary.content), createdAt: Date.now() })
  return result.lastInsertRowid as number
}

// insertSummary + markMessagesSummarized 事务化组合：摘要生成（summarizer.ts）使用这个而非
// 分别调用两者，避免进程在两步之间崩溃导致"写完 Summary 但消息未标记"或反过来的中间态
export function insertSummaryAndMarkMessages(
  summary: Omit<Summary, 'id' | 'createdAt'>,
  messageIds: number[]
): number {
  const run = db.transaction(() => {
    const summaryId = insertSummary(summary)
    markMessagesSummarized(messageIds)
    return summaryId
  })
  return run()
}

// 按 createdAt 升序返回该 session 的全部摘要，供 buildContext.ts 注入历史摘要使用
export function getSummaries(sessionId: string): Summary[] {
  const rows = db.prepare(`SELECT * FROM Summaries WHERE sessionId = ? ORDER BY createdAt ASC`).all(sessionId) as any[]
  return rows.map(row => ({ ...row, content: decrypt(row.content) }))
}

// ─── EmotionState（session 当前情绪状态，可覆盖，非历史时间线）───
// 情绪标签/强度不属于 TDD §3.6 加密字段范围（消息内容、角色设定、API Key、摘要、实体聚合结果），
// 因此不过 encrypt()/decrypt()

export function upsertEmotionState(sessionId: string, emotion: EmotionState): void {
  db.prepare(`
    INSERT INTO EmotionStates
      (sessionId, selfLabel, selfIntensity, perceivedUserLabel, perceivedUserIntensity, updatedAt)
    VALUES
      (@sessionId, @selfLabel, @selfIntensity, @perceivedUserLabel, @perceivedUserIntensity, @updatedAt)
    ON CONFLICT(sessionId) DO UPDATE SET
      selfLabel = excluded.selfLabel,
      selfIntensity = excluded.selfIntensity,
      perceivedUserLabel = excluded.perceivedUserLabel,
      perceivedUserIntensity = excluded.perceivedUserIntensity,
      updatedAt = excluded.updatedAt
  `).run({
    sessionId,
    selfLabel: emotion.self.label,
    selfIntensity: emotion.self.intensity,
    perceivedUserLabel: emotion.perceived_user?.label ?? null,
    perceivedUserIntensity: emotion.perceived_user?.intensity ?? null,
    updatedAt: Date.now(),
  })
}

export function getEmotionState(sessionId: string): EmotionState | null {
  const row = db.prepare(`SELECT * FROM EmotionStates WHERE sessionId = ?`).get(sessionId) as any
  if (!row) return null
  return {
    self: { label: row.selfLabel, intensity: row.selfIntensity },
    perceived_user: row.perceivedUserLabel === null
      ? null
      : { label: row.perceivedUserLabel, intensity: row.perceivedUserIntensity },
  }
}

// "清零"按删除理解：删除后 getEmotionState 自然返回 null
export function resetEmotionState(sessionId: string): void {
  db.prepare(`DELETE FROM EmotionStates WHERE sessionId = ?`).run(sessionId)
}