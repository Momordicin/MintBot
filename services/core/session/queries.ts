// services/core/session/queries.ts — SQLite 数据访问层
// 用法：session、routes、memory、context 各模块直接调用同步读写函数
// 对应文件：services/core/db/index.ts / services/core/session/queries.test.ts
import { db, checkpointTruncate } from '../db/index.js'
import { DEFAULT_DISPLAY_CONFIG, parseDisplayConfig } from './displayConfig.js'
import type { Message, Session, Preset, PresetSnapshot, MessageEntity, Summary, EmotionState, PresetDisplayConfig } from '../../../shared/types/index.js'

export type PresetKeyProvider = 'anthropic' | 'openai' | 'deepseek'

export interface PresetProviderCredential {
  apiKey?: string
  fromEnv: boolean
  summaryApiKey?: string
  summaryFromEnv?: boolean
}

export type PresetCredentials = Record<PresetKeyProvider, PresetProviderCredential>

export interface PresetApiKeyUpdate {
  provider: PresetKeyProvider
  apiKey?: string
  fromEnv?: boolean
  summaryApiKey?: string
  summaryFromEnv?: boolean
}

export type PresetModelType = 'anthropic' | 'openai' | 'ollama' | 'deepseek'

export interface PresetSummaryUpdate {
  model?: { modelType: PresetModelType | null; modelName: string | null }
  keyUpdate?: PresetApiKeyUpdate
}

const KEY_PROVIDER_LIST: readonly PresetKeyProvider[] = ['anthropic', 'openai', 'deepseek']

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseAddressForms(raw: string | null): string[] {
  if (raw === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn('[Preset] addressForms JSON 解析失败，使用默认值 []:', err)
    return []
  }

  if (!isStringArray(parsed)) {
    console.warn('[Preset] addressForms 类型错误，应为字符串数组，使用默认值 []')
    return []
  }
  return parsed
}

export function getPresetById(presetId: string): Preset | null {
  const row = db.prepare(`SELECT * FROM Presets WHERE presetId = ?`).get(presetId) as any
  if (!row) return null
  return {
    ...row,
    wallpaperPath: row.wallpaperPath ?? undefined,
    displayConfig: parseDisplayConfig(row.displayConfig),
    addressForms: parseAddressForms(row.addressForms),
  }
}

export function getAllPresets(): Preset[] {
  const rows = db.prepare(`SELECT * FROM Presets ORDER BY updatedAt DESC`).all() as any[]
  return rows.map(row => ({
    ...row,
    wallpaperPath: row.wallpaperPath ?? undefined,
    displayConfig: parseDisplayConfig(row.displayConfig),
    addressForms: parseAddressForms(row.addressForms),
  }))
}

export function upsertPreset(preset: Omit<Preset, 'createdAt' | 'updatedAt' | 'displayConfig' | 'addressForms' | 'summaryModelType' | 'summaryModelName'> & { displayConfig?: PresetDisplayConfig; addressForms?: string[] }): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO Presets (presetId, name, characterId, modelType, modelName, wallpaperPath, displayConfig, systemPrompt, addressForms, createdAt, updatedAt)
    VALUES (@presetId, @name, @characterId, @modelType, @modelName, @wallpaperPath, @displayConfig, @systemPrompt, @addressForms, @createdAt, @updatedAt)
    ON CONFLICT(presetId) DO UPDATE SET
      name = excluded.name,
      characterId = excluded.characterId,
      modelType = excluded.modelType,
      modelName = excluded.modelName,
      wallpaperPath = excluded.wallpaperPath,
      displayConfig = excluded.displayConfig,
      systemPrompt = excluded.systemPrompt,
      addressForms = excluded.addressForms,
      updatedAt = excluded.updatedAt
  `).run({
    ...preset,
    wallpaperPath: preset.wallpaperPath ?? null,
    displayConfig: JSON.stringify(preset.displayConfig ?? DEFAULT_DISPLAY_CONFIG),
    systemPrompt: preset.systemPrompt,
    addressForms: JSON.stringify(preset.addressForms ?? []),
    createdAt: now,
    updatedAt: now,
  })
}

export function createPreset(preset: Omit<Preset, 'createdAt' | 'updatedAt' | 'summaryModelType' | 'summaryModelName'>): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO Presets (presetId, name, characterId, modelType, modelName, wallpaperPath, displayConfig, systemPrompt, addressForms, createdAt, updatedAt)
    VALUES (@presetId, @name, @characterId, @modelType, @modelName, @wallpaperPath, @displayConfig, @systemPrompt, @addressForms, @createdAt, @updatedAt)
  `).run({
    ...preset,
    wallpaperPath: preset.wallpaperPath ?? null,
    displayConfig: JSON.stringify(preset.displayConfig),
    systemPrompt: preset.systemPrompt,
    addressForms: JSON.stringify(preset.addressForms),
    createdAt: now,
    updatedAt: now,
  })
}

export function updatePresetWallpaper(presetId: string, wallpaperPath: string): void {
  db.prepare(`UPDATE Presets SET wallpaperPath = ?, updatedAt = ? WHERE presetId = ?`)
    .run(wallpaperPath, Date.now(), presetId)
}

export function updatePresetName(presetId: string, name: string): void {
  db.prepare(`UPDATE Presets SET name = ?, updatedAt = ? WHERE presetId = ?`)
    .run(name, Date.now(), presetId)
}

export function updatePresetDisplayConfig(presetId: string, displayConfig: PresetDisplayConfig): void {
  db.prepare(`UPDATE Presets SET displayConfig = ?, updatedAt = ? WHERE presetId = ?`)
    .run(JSON.stringify(displayConfig), Date.now(), presetId)
}

export function updatePresetSystemPrompt(presetId: string, systemPrompt: string): void {
  db.prepare(`UPDATE Presets SET systemPrompt = ?, updatedAt = ? WHERE presetId = ?`)
    .run(systemPrompt, Date.now(), presetId)
}

export function updatePresetAddressForms(presetId: string, addressForms: string[]): void {
  db.prepare(`UPDATE Presets SET addressForms = ?, updatedAt = ? WHERE presetId = ?`)
    .run(JSON.stringify(addressForms), Date.now(), presetId)
}

export function getPresetApiKeys(presetId: string): PresetCredentials {
  const credentials: PresetCredentials = {
    anthropic: { fromEnv: false, summaryFromEnv: false },
    openai: { fromEnv: false, summaryFromEnv: false },
    deepseek: { fromEnv: false, summaryFromEnv: false },
  }
  const rows = db.prepare(`SELECT provider, apiKey, fromEnv, summaryApiKey, summaryFromEnv FROM PresetApiKeys WHERE presetId = ?`)
    .all(presetId) as { provider: string; apiKey: string | null; fromEnv: number; summaryApiKey: string | null; summaryFromEnv: number }[]
  for (const row of rows) {
    if (!KEY_PROVIDER_LIST.includes(row.provider as PresetKeyProvider)) continue
    credentials[row.provider as PresetKeyProvider] = {
      ...(row.apiKey ? { apiKey: row.apiKey } : {}),
      fromEnv: row.fromEnv === 1,
      ...(row.summaryApiKey ? { summaryApiKey: row.summaryApiKey } : {}),
      summaryFromEnv: row.summaryFromEnv === 1,
    }
  }
  return credentials
}

function writePresetApiKey(presetId: string, update: PresetApiKeyUpdate): void {
  const existing = db.prepare(`SELECT apiKey, fromEnv, summaryApiKey, summaryFromEnv FROM PresetApiKeys WHERE presetId = ? AND provider = ?`)
    .get(presetId, update.provider) as { apiKey: string | null; fromEnv: number; summaryApiKey: string | null; summaryFromEnv: number } | undefined
  db.prepare(`
    INSERT INTO PresetApiKeys (presetId, provider, apiKey, fromEnv, summaryApiKey, summaryFromEnv)
    VALUES (@presetId, @provider, @apiKey, @fromEnv, @summaryApiKey, @summaryFromEnv)
    ON CONFLICT(presetId, provider) DO UPDATE SET
      apiKey = excluded.apiKey,
      fromEnv = excluded.fromEnv,
      summaryApiKey = excluded.summaryApiKey,
      summaryFromEnv = excluded.summaryFromEnv
  `).run({
    presetId,
    provider: update.provider,
    apiKey: update.apiKey ?? existing?.apiKey ?? null,
    fromEnv: (update.fromEnv ?? existing?.fromEnv === 1) ? 1 : 0,
    summaryApiKey: update.summaryApiKey ?? existing?.summaryApiKey ?? null,
    summaryFromEnv: (update.summaryFromEnv ?? existing?.summaryFromEnv === 1) ? 1 : 0,
  })
}

function writesSecret(update: PresetApiKeyUpdate | undefined): boolean {
  return update?.apiKey !== undefined || update?.summaryApiKey !== undefined
}

export function upsertPresetApiKey(presetId: string, update: PresetApiKeyUpdate): void {
  writePresetApiKey(presetId, update)
  if (writesSecret(update)) checkpointTruncate('[Presets]')
}

export function updatePresetModelConfig(
  presetId: string,
  modelType: PresetModelType | null,
  modelName: string | null,
  keyUpdate?: PresetApiKeyUpdate,
  summary?: PresetSummaryUpdate
): void {
  db.transaction(() => {
    db.prepare(`UPDATE Presets SET modelType = ?, modelName = ?, updatedAt = ? WHERE presetId = ?`)
      .run(modelType, modelName, Date.now(), presetId)
    if (summary?.model) {
      db.prepare(`UPDATE Presets SET summaryModelType = ?, summaryModelName = ? WHERE presetId = ?`)
        .run(summary.model.modelType, summary.model.modelName, presetId)
    }
    if (keyUpdate) writePresetApiKey(presetId, keyUpdate)
    if (summary?.keyUpdate) writePresetApiKey(presetId, summary.keyUpdate)
  })()
  if (writesSecret(keyUpdate) || writesSecret(summary?.keyUpdate)) checkpointTruncate('[Presets]')
}

export function getPresetIdBySession(sessionId: string): string | null {
  const row = db.prepare(`SELECT presetId FROM Sessions WHERE sessionId = ?`).get(sessionId) as { presetId: string } | undefined
  return row?.presetId ?? null
}

export function getMostRecentOtherPresetId(excludePresetId: string): string | null {
  const row = db.prepare(`
    SELECT p.presetId AS presetId
    FROM Presets p
    LEFT JOIN (SELECT presetId, MAX(lastActiveAt) AS lastActiveAt FROM Sessions GROUP BY presetId) s ON s.presetId = p.presetId
    WHERE p.presetId != ?
    ORDER BY s.lastActiveAt IS NULL ASC, s.lastActiveAt DESC, p.createdAt DESC
    LIMIT 1
  `).get(excludePresetId) as { presetId: string } | undefined
  return row?.presetId ?? null
}

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

export function sessionExists(sessionId: string): boolean {
  return db.prepare(`SELECT 1 FROM Sessions WHERE sessionId = ?`).get(sessionId) !== undefined
}

export function touchSession(sessionId: string): void {
  db.prepare(`UPDATE Sessions SET lastActiveAt = ? WHERE sessionId = ?`)
    .run(Date.now(), sessionId)
}

export function getRecentMessages(sessionId: string, limit = 50): Message[] {
  const rows = db.prepare(`
    SELECT * FROM Messages
    WHERE sessionId = ? AND visibleToUser = 1
    ORDER BY createdAt DESC
    LIMIT ?
  `).all(sessionId, limit) as any[]

  return rows
    .reverse()  
    .map(row => ({
      ...row,
      embedded: row.embedded === 1,
      summarized: row.summarized === 1,
      visibleToUser: row.visibleToUser === 1,
    }))
}

export function getMessagesPage(
  sessionId: string,
  limit: number,
  beforeId?: number
): { messages: Message[]; hasMore: boolean } {
  const anchor = beforeId !== undefined
    ? db.prepare(`SELECT createdAt FROM Messages WHERE id = ? AND sessionId = ?`).get(beforeId, sessionId) as { createdAt: number } | undefined
    : undefined

  const rows = (beforeId === undefined
    ? db.prepare(`
        SELECT * FROM Messages
        WHERE sessionId = ? AND visibleToUser = 1
        ORDER BY createdAt DESC, id DESC
        LIMIT ?
      `).all(sessionId, limit + 1)
    : anchor
      ? db.prepare(`
          SELECT * FROM Messages
          WHERE sessionId = ? AND visibleToUser = 1 AND (createdAt < ? OR (createdAt = ? AND id < ?))
          ORDER BY createdAt DESC, id DESC
          LIMIT ?
        `).all(sessionId, anchor.createdAt, anchor.createdAt, beforeId, limit + 1)
      : db.prepare(`
          SELECT * FROM Messages
          WHERE sessionId = ? AND visibleToUser = 1 AND id < ?
          ORDER BY createdAt DESC, id DESC
          LIMIT ?
        `).all(sessionId, beforeId, limit + 1)
  ) as any[]

  const hasMore = rows.length > limit

  return {
    hasMore,
    messages: rows
      .slice(0, limit)
      .reverse()  
      .map(row => ({
        ...row,
        embedded: row.embedded === 1,
        summarized: row.summarized === 1,
        visibleToUser: row.visibleToUser === 1,
      })),
  }
}

export function appendMessage(msg: Omit<Message, 'id'>): number {
  const result = db.prepare(`
    INSERT INTO Messages
      (sessionId, role, content, createdAt, embedded, summarized, visibleToUser, trigger, triggerEventId)
    VALUES
      (@sessionId, @role, @content, @createdAt, @embedded, @summarized, @visibleToUser, @trigger, @triggerEventId)
  `).run({
    ...msg,
    embedded: msg.embedded ? 1 : 0,
    summarized: msg.summarized ? 1 : 0,
    visibleToUser: msg.visibleToUser ? 1 : 0,
  })
  return result.lastInsertRowid as number
}

export function appendExchange(
  sessionId: string,
  userContent: string,
  userCreatedAt: number,
  assistantContent: string
): number {
  const base = { sessionId, embedded: false, summarized: false, visibleToUser: true, trigger: 'user' as const, triggerEventId: null }
  const run = db.transaction(() => {
    appendMessage({ ...base, role: 'user', content: userContent, createdAt: userCreatedAt })
    const assistantId = appendMessage({ ...base, role: 'assistant', content: assistantContent, createdAt: Date.now() })
    touchSession(sessionId)
    return assistantId
  })
  return run()
}

function toVecBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer)
}

export interface EmbeddingSearchResult {
  messageId: number
  sessionId: string
  distance: number
}

export function upsertMessageEmbedding(messageId: number, sessionId: string, embedding: number[]): void {
  db.prepare(`
    INSERT OR REPLACE INTO message_embeddings (message_id, session_id, embedding)
    VALUES (@messageId, @sessionId, @embedding)
  `).run({ messageId: BigInt(messageId), sessionId, embedding: toVecBuffer(embedding) })
}

export function embedMessageIfExists(messageId: number, sessionId: string, content: string, embedding: number[]): boolean {
  const run = db.transaction(() => {
    if (db.prepare(`SELECT 1 FROM Messages WHERE id = ?`).get(messageId) === undefined) return false
    upsertMessageEmbedding(messageId, sessionId, embedding)
    indexMessageFts(messageId, sessionId, content)
    markMessageEmbedded(messageId)
    return true
  })
  return run()
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

export function getPendingEmbeddingMessages(limit = 200): Message[] {
  const rows = db.prepare(`
    SELECT * FROM Messages WHERE embedded = 0 ORDER BY createdAt ASC LIMIT ?
  `).all(limit) as any[]

  return rows.map(row => ({
    ...row,
    embedded: row.embedded === 1,
    summarized: row.summarized === 1,
    visibleToUser: row.visibleToUser === 1,
  }))
}

export function getPendingEmbeddingCount(): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM Messages WHERE embedded = 0`).get() as any
  return row.count
}

export function getPendingEmbeddingCountForSession(sessionId: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM Messages WHERE sessionId = ? AND embedded = 0`).get(sessionId) as any
  return row.count
}

export function getOldestPendingEmbeddingTimeForSession(sessionId: string): number | null {
  const row = db.prepare(`SELECT MIN(createdAt) as minCreatedAt FROM Messages WHERE sessionId = ? AND embedded = 0`).get(sessionId) as any
  return row.minCreatedAt ?? null
}

export function getPendingEmbeddingCountBefore(createdAt: number): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM Messages WHERE embedded = 0 AND createdAt < ?`).get(createdAt) as any
  return row.count
}

export function markMessageEmbedded(messageId: number): void {
  db.prepare(`UPDATE Messages SET embedded = 1 WHERE id = ?`).run(messageId)
}

export function getMostRecentMessageTime(): number | null {
  const row = db.prepare(`SELECT MAX(createdAt) as maxCreatedAt FROM Messages`).get() as any
  return row.maxCreatedAt ?? null
}

export function getMostRecentMessageTimeForSession(sessionId: string): number | null {
  const row = db.prepare(`SELECT MAX(createdAt) as maxCreatedAt FROM Messages WHERE sessionId = ?`).get(sessionId) as any
  return row.maxCreatedAt ?? null
}

export function getOldestUnsummarizedMessageTime(): number | null {
  const row = db.prepare(`SELECT MIN(createdAt) as minCreatedAt FROM Messages WHERE summarized = 0`).get() as any
  return row.minCreatedAt ?? null
}

export function getMessageCreatedAtByIds(ids: number[]): Map<number, number> {
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT id, createdAt FROM Messages WHERE id IN (${placeholders})`).all(...ids) as { id: number; createdAt: number }[]
  return new Map(rows.map(row => [row.id, row.createdAt]))
}

export function getMessagesByIds(ids: number[]): Message[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT * FROM Messages WHERE id IN (${placeholders})`).all(...ids) as any[]

  return rows.map(row => ({
    ...row,
    embedded: row.embedded === 1,
    summarized: row.summarized === 1,
    visibleToUser: row.visibleToUser === 1,
  }))
}

export function getPendingSummaryMessages(sessionId: string, limit = 200): Message[] {
  const rows = db.prepare(`
    SELECT * FROM Messages WHERE sessionId = ? AND summarized = 0 ORDER BY createdAt ASC, id ASC LIMIT ?
  `).all(sessionId, limit) as any[]

  return rows.map(row => ({
    ...row,
    embedded: row.embedded === 1,
    summarized: row.summarized === 1,
    visibleToUser: row.visibleToUser === 1,
  }))
}

export function getSessionsWithPendingSummaries(): string[] {
  const rows = db.prepare(`
    SELECT sessionId, MAX(createdAt) as lastMessageAt
    FROM Messages
    GROUP BY sessionId
    HAVING SUM(CASE WHEN summarized = 0 THEN 1 ELSE 0 END) > 0
    ORDER BY lastMessageAt DESC
  `).all() as any[]
  return rows.map(row => row.sessionId)
}

export function getPendingSummaryCount(sessionId: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM Messages WHERE sessionId = ? AND summarized = 0`).get(sessionId) as any
  return row.count
}

export function markMessagesSummarized(messageIds: number[]): void {
  if (messageIds.length === 0) return
  const placeholders = messageIds.map(() => '?').join(',')
  db.prepare(`UPDATE Messages SET summarized = 1 WHERE id IN (${placeholders})`).run(...messageIds)
}

export function insertEntity(entity: Omit<MessageEntity, 'id' | 'createdAt' | 'validUntil'> & { validUntil?: number | null }): number {
  const result = db.prepare(`
    INSERT INTO MessageEntities (messageId, sessionId, type, value, validFrom, validUntil, createdAt)
    VALUES (@messageId, @sessionId, @type, @value, @validFrom, @validUntil, @createdAt)
  `).run({
    messageId: entity.messageId,
    sessionId: entity.sessionId,
    type: entity.type,
    value: entity.value,
    validFrom: entity.validFrom,
    validUntil: entity.validUntil ?? null,
    createdAt: Date.now(),
  })
  return result.lastInsertRowid as number
}

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

  return rows
}

export function getCurrentEntitiesPage(
  sessionId: string,
  limit: number,
  beforeId?: number,
  type?: MessageEntity['type']
): { entities: MessageEntity[]; hasMore: boolean } {
  const conditions = ['sessionId = ?', 'validUntil IS NULL']
  const params: (string | number)[] = [sessionId]

  if (type !== undefined) {
    conditions.push('type = ?')
    params.push(type)
  }
  if (beforeId !== undefined) {
    conditions.push('id < ?')
    params.push(beforeId)
  }
  params.push(limit + 1)

  const rows = db.prepare(`
    SELECT * FROM MessageEntities
    WHERE ${conditions.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params) as any[]

  const hasMore = rows.length > limit

  return {
    hasMore,
    entities: rows
      .slice(0, limit)
      .reverse()  
  }
}

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

  return rows
}

export function closeEntity(id: number, validUntil: number = Date.now()): void {
  db.prepare(`UPDATE MessageEntities SET validUntil = ? WHERE id = ?`).run(validUntil, id)
}

export function getSupersededMessageIds(ids: number[]): Set<number> {
  if (ids.length === 0) return new Set()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT DISTINCT messageId FROM MessageEntities WHERE messageId IN (${placeholders}) AND validUntil IS NOT NULL
  `).all(...ids) as { messageId: number }[]
  return new Set(rows.map(row => row.messageId))
}

export interface FtsSearchResult {
  messageId: number
  sessionId: string
  rank: number
}

export function indexMessageFts(messageId: number, sessionId: string, content: string): void {
  db.prepare(`
    INSERT INTO message_fts (content, message_id, session_id)
    VALUES (@content, @messageId, @sessionId)
  `).run({ content, messageId, sessionId })
}

export function searchMessagesFts(query: string, sessionId?: string, limit = 10): FtsSearchResult[] {
  const text = query.replace(/\0/g, '')
  if (text.trim() === '') return []
  const params = { query: `"${text.replace(/"/g, '""')}"`, sessionId, limit }
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

export function backfillMessageFts(): number {
  const embeddedMessages = db.prepare(`
    SELECT id, sessionId, content FROM Messages WHERE embedded = 1
  `).all() as { id: number; sessionId: string; content: string }[]
  for (const msg of embeddedMessages) {
    indexMessageFts(msg.id, msg.sessionId, msg.content)
  }
  return embeddedMessages.length
}

export function insertSummary(summary: Omit<Summary, 'id' | 'createdAt'>): number {
  const result = db.prepare(`
    INSERT INTO Summaries (sessionId, content, fromMessageId, toMessageId, createdAt)
    VALUES (@sessionId, @content, @fromMessageId, @toMessageId, @createdAt)
  `).run({ ...summary, createdAt: Date.now() })
  return result.lastInsertRowid as number
}

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

export function getSummaries(sessionId: string): Summary[] {
  const rows = db.prepare(`SELECT * FROM Summaries WHERE sessionId = ? ORDER BY createdAt ASC`).all(sessionId) as any[]
  return rows
}

export function getMessageIdsInTimeRange(sessionId: string, fromTime: number, toTime: number): number[] {
  const rows = db.prepare(`
    SELECT id FROM Messages
    WHERE sessionId = @sessionId AND role = 'user' AND createdAt >= @fromTime AND createdAt <= @toTime
    UNION
    SELECT r.id FROM Messages q
    JOIN Messages r ON r.id = (SELECT MIN(n.id) FROM Messages n WHERE n.sessionId = q.sessionId AND n.id > q.id)
    WHERE q.sessionId = @sessionId AND q.role = 'user' AND q.createdAt >= @fromTime AND q.createdAt <= @toTime
      AND r.role = 'assistant'
    ORDER BY id ASC
  `).all({ sessionId, fromTime, toTime }) as { id: number }[]
  return rows.map(row => row.id)
}

export function getSummariesOverlappingRange(sessionId: string, minMessageId: number, maxMessageId: number): Summary[] {
  const rows = db.prepare(`
    SELECT * FROM Summaries
    WHERE sessionId = ? AND NOT (toMessageId < ? OR fromMessageId > ?)
  `).all(sessionId, minMessageId, maxMessageId) as any[]
  return rows
}

export function forgetMessages(params: {
  sessionId: string
  messageIds: number[]
  summaryIdsToDelete: number[]
}): { deletedMessages: number; deletedEntities: number; deletedSummaries: number; deletedEmbeddings: number; deletedFts: number } {
  const { sessionId, messageIds, summaryIdsToDelete } = params
  if (messageIds.length === 0) {
    return { deletedMessages: 0, deletedEntities: 0, deletedSummaries: 0, deletedEmbeddings: 0, deletedFts: 0 }
  }

  const run = db.transaction(() => {
    const messagePlaceholders = messageIds.map(() => '?').join(',')

    const deletedEmbeddings = db.prepare(
      `DELETE FROM message_embeddings WHERE message_id IN (${messagePlaceholders}) AND session_id = ?`
    ).run(...messageIds, sessionId).changes as number

    const deletedFts = db.prepare(
      `DELETE FROM message_fts WHERE message_id IN (${messagePlaceholders}) AND session_id = ?`
    ).run(...messageIds, sessionId).changes as number

    const deletedEntities = db.prepare(
      `DELETE FROM MessageEntities WHERE messageId IN (${messagePlaceholders}) AND sessionId = ?`
    ).run(...messageIds, sessionId).changes as number

    let deletedSummaries = 0
    if (summaryIdsToDelete.length > 0) {
      const summaryPlaceholders = summaryIdsToDelete.map(() => '?').join(',')
      deletedSummaries = db.prepare(
        `DELETE FROM Summaries WHERE id IN (${summaryPlaceholders}) AND sessionId = ?`
      ).run(...summaryIdsToDelete, sessionId).changes as number
    }

    const deletedMessages = db.prepare(
      `DELETE FROM Messages WHERE id IN (${messagePlaceholders}) AND sessionId = ?`
    ).run(...messageIds, sessionId).changes as number

    return { deletedMessages, deletedEntities, deletedSummaries, deletedEmbeddings, deletedFts }
  })

  const result = run()
  checkpointTruncate('[Forget]')
  return result
}

export function deletePresetWithData(presetId: string): void {
  const run = db.transaction(() => {
    const sessionIds = (db.prepare(`SELECT sessionId FROM Sessions WHERE presetId = ?`).all(presetId) as { sessionId: string }[])
      .map(row => row.sessionId)
    const deleteEmbedding = db.prepare(`DELETE FROM message_embeddings WHERE message_id = ?`)

    for (const sessionId of sessionIds) {
      const messageRows = db.prepare(`SELECT id FROM Messages WHERE sessionId = ?`).all(sessionId) as { id: number }[]
      for (const row of messageRows) deleteEmbedding.run(BigInt(row.id))
      db.prepare(`DELETE FROM message_fts WHERE session_id = ?`).run(sessionId)
      db.prepare(`DELETE FROM MessageEntities WHERE sessionId = ?`).run(sessionId)
      db.prepare(`DELETE FROM Summaries WHERE sessionId = ?`).run(sessionId)
      db.prepare(`DELETE FROM EmotionStates WHERE sessionId = ?`).run(sessionId)
      db.prepare(`DELETE FROM Messages WHERE sessionId = ?`).run(sessionId)
      db.prepare(`DELETE FROM Sessions WHERE sessionId = ?`).run(sessionId)
    }

    db.prepare(`DELETE FROM PresetApiKeys WHERE presetId = ?`).run(presetId)
    db.prepare(`DELETE FROM Presets WHERE presetId = ?`).run(presetId)
  })
  run()
  checkpointTruncate('[Presets]')
}

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

export function resetEmotionState(sessionId: string): void {
  db.prepare(`DELETE FROM EmotionStates WHERE sessionId = ?`).run(sessionId)
}