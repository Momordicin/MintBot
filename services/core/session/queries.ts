import { db } from '../db/index.js'
import { encrypt, decrypt } from '../db/crypto.js'
import { getEncryptSensitiveFields } from '../config/security.js'
import type { Message, Session, Preset, PresetSnapshot, MessageEntity } from '../../../shared/types/index.js'

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