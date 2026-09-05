import { db } from '../db/index.js'
import { encrypt, decrypt } from '../db/crypto.js'
import { getEncryptSensitiveFields } from '../config/security.js'
import { DEFAULT_DISPLAY_CONFIG, parseDisplayConfig } from './displayConfig.js'
import type { Message, Session, Preset, PresetSnapshot, MessageEntity, Summary, EmotionState, PresetDisplayConfig } from '../../../shared/types/index.js'

// ─── Preset ───────────────────────────────────────────────

// addressForms 读时解析：与 systemPrompt 同级加密（TDD §3.2.2「Presets.addressForms」），
// 因此先 decrypt() 再 JSON.parse()。NULL（迁移前的旧行、或从未设置过的行）等价于空数组，
// 不告警——这是正常情况；解密失败、JSON 解析失败、或解析出来的值不是字符串数组，都回退
// 空数组但告警，因为这才是真正的数据异常，不是"该角色没有特定称呼"这种合法状态。
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseAddressForms(raw: string | null): string[] {
  if (raw === null) return []

  let decrypted: string
  try {
    decrypted = decrypt(raw)
  } catch (err) {
    console.warn('[Preset] addressForms 解密失败，使用默认值 []:', err)
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(decrypted)
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
    systemPrompt: decrypt(row.systemPrompt),
    addressForms: parseAddressForms(row.addressForms),
  }
}

export function getAllPresets(): Preset[] {
  const rows = db.prepare(`SELECT * FROM Presets ORDER BY updatedAt DESC`).all() as any[]
  return rows.map(row => ({
    ...row,
    wallpaperPath: row.wallpaperPath ?? undefined,
    displayConfig: parseDisplayConfig(row.displayConfig),
    systemPrompt: decrypt(row.systemPrompt),
    addressForms: parseAddressForms(row.addressForms),
  }))
}

export function upsertPreset(preset: Omit<Preset, 'createdAt' | 'updatedAt' | 'displayConfig' | 'addressForms'> & { displayConfig?: PresetDisplayConfig; addressForms?: string[] }): void {
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
    systemPrompt: encrypt(preset.systemPrompt),
    addressForms: encrypt(JSON.stringify(preset.addressForms ?? [])),
    createdAt: now,
    updatedAt: now,
  })
}

// 手动创建新 preset 专用：与 upsertPreset 故意分开，不复用——upsertPreset 是
// INSERT ... ON CONFLICT(presetId) DO UPDATE，presetId 撞车时会静默覆盖已有行；
// "创建"语义要求撞车即报错（DB 唯一约束抛出的原始错误），而不是把已有角色悄悄顶掉。
// 供 POST /presets（routes/presets.ts）使用，presetId 由路由层调用方生成（crypto.randomUUID()）
export function createPreset(preset: Omit<Preset, 'createdAt' | 'updatedAt'>): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO Presets (presetId, name, characterId, modelType, modelName, wallpaperPath, displayConfig, systemPrompt, addressForms, createdAt, updatedAt)
    VALUES (@presetId, @name, @characterId, @modelType, @modelName, @wallpaperPath, @displayConfig, @systemPrompt, @addressForms, @createdAt, @updatedAt)
  `).run({
    ...preset,
    wallpaperPath: preset.wallpaperPath ?? null,
    displayConfig: JSON.stringify(preset.displayConfig),
    systemPrompt: encrypt(preset.systemPrompt),
    addressForms: encrypt(JSON.stringify(preset.addressForms)),
    createdAt: now,
    updatedAt: now,
  })
}

// 壁纸上传后单独更新 wallpaperPath，不走 upsertPreset 整体替换（避免要求调用方在只想改
// 一个字段时也要传完整 Preset 对象）
export function updatePresetWallpaper(presetId: string, wallpaperPath: string): void {
  db.prepare(`UPDATE Presets SET wallpaperPath = ?, updatedAt = ? WHERE presetId = ?`)
    .run(wallpaperPath, Date.now(), presetId)
}

// 改名同理，单独更新 name，不走 upsertPreset 整体替换
export function updatePresetName(presetId: string, name: string): void {
  db.prepare(`UPDATE Presets SET name = ?, updatedAt = ? WHERE presetId = ?`)
    .run(name, Date.now(), presetId)
}

// displayConfig 同理，单独更新（PATCH /presets/:presetId 已在路由层把部分字段合并到当前
// 已存值之上，这里直接整体写回合并后的完整对象）
export function updatePresetDisplayConfig(presetId: string, displayConfig: PresetDisplayConfig): void {
  db.prepare(`UPDATE Presets SET displayConfig = ?, updatedAt = ? WHERE presetId = ?`)
    .run(JSON.stringify(displayConfig), Date.now(), presetId)
}

// systemPrompt 同理单独更新，但多一步 encrypt()——该字段属于 TDD §3.6 加密字段范围
// （角色设定），与 upsertPreset/getPresetById 已有的加解密处理保持一致
export function updatePresetSystemPrompt(presetId: string, systemPrompt: string): void {
  db.prepare(`UPDATE Presets SET systemPrompt = ?, updatedAt = ? WHERE presetId = ?`)
    .run(encrypt(systemPrompt), Date.now(), presetId)
}

// addressForms 同理单独更新，同样过 encrypt()——该字段属于 TDD §3.2.2/§3.6 加密范围
// （角色对用户的称呼，隐私敏感度与角色设定相当）。本阶段无 PATCH 路由调用它，供后续
// 角色卡导入/设置页编辑功能落地时使用
export function updatePresetAddressForms(presetId: string, addressForms: string[]): void {
  db.prepare(`UPDATE Presets SET addressForms = ?, updatedAt = ? WHERE presetId = ?`)
    .run(encrypt(JSON.stringify(addressForms)), Date.now(), presetId)
}

// 每 preset 对话模型覆盖：modelType/modelName 两个字段永远一起写（要么都非空代表自定义，
// 要么都为 null 代表清除覆盖、跟随全局 modelProvider 配置），不允许出现"有 modelType
// 没 modelName"的半吊子状态，因此不像 name/displayConfig/systemPrompt 那样拆成单字段更新
export function updatePresetModelConfig(
  presetId: string,
  modelType: 'anthropic' | 'openai' | 'ollama' | 'deepseek' | null,
  modelName: string | null
): void {
  db.prepare(`UPDATE Presets SET modelType = ?, modelName = ?, updatedAt = ? WHERE presetId = ?`)
    .run(modelType, modelName, Date.now(), presetId)
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

// 分页查询：用 id（autoincrement，单调递增，等价于插入顺序/createdAt 顺序）做游标，而非
// createdAt（时间戳可能重复，不适合做唯一游标）。beforeId 未传时取最新一页；传了时取
// id < beforeId 的一页。多取 limit + 1 条来判断 hasMore，避免额外一次 COUNT(*) 查询。
// 供 GET /messages（routes/messages.ts）分页展示历史消息使用，不影响 getRecentMessages
// （buildContext.ts 消费路径）的行为
export function getMessagesPage(
  sessionId: string,
  limit: number,
  beforeId?: number
): { messages: Message[]; hasMore: boolean } {
  const rows = (beforeId !== undefined
    ? db.prepare(`
        SELECT * FROM Messages
        WHERE sessionId = ? AND visibleToUser = 1 AND id < ?
        ORDER BY id DESC
        LIMIT ?
      `).all(sessionId, beforeId, limit + 1)
    : db.prepare(`
        SELECT * FROM Messages
        WHERE sessionId = ? AND visibleToUser = 1
        ORDER BY id DESC
        LIMIT ?
      `).all(sessionId, limit + 1)
  ) as any[]

  const hasMore = rows.length > limit

  return {
    hasMore,
    messages: rows
      .slice(0, limit)
      .reverse()  // 返回正序
      .map(row => ({
        ...row,
        content: decrypt(row.content),
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

// 当前激活角色自己的待 embedding 消息数/最早等待时间，供 computeEmbeddingQueueStatus
// 拆分"当前角色" vs. "全局队列"展示使用（EmbeddingQueueStatus.activePresetPendingCount /
// activePresetOldestPendingAge）
export function getPendingEmbeddingCountForSession(sessionId: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM Messages WHERE sessionId = ? AND embedded = 0`).get(sessionId) as any
  return row.count
}

export function getOldestPendingEmbeddingTimeForSession(sessionId: string): number | null {
  const row = db.prepare(`SELECT MIN(createdAt) as minCreatedAt FROM Messages WHERE sessionId = ? AND embedded = 0`).get(sessionId) as any
  return row.minCreatedAt ?? null
}

// 排在当前角色最旧待 embedding 消息前面、必须先处理完的全局待处理消息数（全局 FIFO 按
// createdAt ASC 处理，比该消息更早的都排在它前面），供 EmbeddingQueueStatus.pendingAheadOfActivePreset 使用
export function getPendingEmbeddingCountBefore(createdAt: number): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM Messages WHERE embedded = 0 AND createdAt < ?`).get(createdAt) as any
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

// 单 session 最近一条消息的 createdAt，供 session/attention.ts 的 getLastAttentionAt 在内存
// 无记录时兜底取初值使用（TDD §3.7 附「状态存放」：初值取该 session 最近一条消息的 createdAt）
export function getMostRecentMessageTimeForSession(sessionId: string): number | null {
  const row = db.prepare(`SELECT MAX(createdAt) as maxCreatedAt FROM Messages WHERE sessionId = ?`).get(sessionId) as any
  return row.maxCreatedAt ?? null
}

// 全表（不分 session）最早一条未摘要消息的 createdAt，供 EmbeddingQueueStatus.oldestUnsummarizedAge 使用
export function getOldestUnsummarizedMessageTime(): number | null {
  const row = db.prepare(`SELECT MIN(createdAt) as minCreatedAt FROM Messages WHERE summarized = 0`).get() as any
  return row.minCreatedAt ?? null
}

// 按 id 批量取消息的 createdAt（不解密，只取时间戳），供 RAG 召回（retrieval.ts）在最终 top-k
// 确定之前对候选分数做新鲜度加成排序使用——避免对全部候选做一次完整解密（getMessagesByIds）
export function getMessageCreatedAtByIds(ids: number[]): Map<number, number> {
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT id, createdAt FROM Messages WHERE id IN (${placeholders})`).all(...ids) as { id: number; createdAt: number }[]
  return new Map(rows.map(row => [row.id, row.createdAt]))
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

// 有待摘要消息的 session 列表，供整理模式编排器（orchestrator.ts）遍历处理。按该 session
// 最后一条消息（不限于未摘要的）的 createdAt 降序排列——最近还在聊的角色排在前面优先处理，
// 长期没碰的角色排在后面（仍会被处理到，只是靠后）
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

// 分页查询：与 getCurrentEntities 同样过滤"当前仍有效"（validUntil IS NULL），但按 id
// （单调递增，等价于插入顺序）而非 validFrom 排序——validFrom 取自消息 createdAt，同一批次
// 抽取的多个实体可能共享同一个 validFrom，无法作为分页游标唯一定位，id 才能保证游标稳定。
// 供 GET /entities（routes/memory.ts，设置窗口实体浏览）使用，不影响 getCurrentEntities
// （buildContext.ts/entityExtractor.ts/retrieval.ts 消费路径）的排序行为
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
      .reverse()  // 返回正序，与 getMessagesPage 的翻页约定一致
      .map(row => ({ ...row, value: decrypt(row.value) })),
  }
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

// 判断哪些消息关联的实体已被后续对话更新过（entityExtractor.ts Layer 3 检测到实体值变更时
// 调用 closeEntity 关闭旧实体行）：只要某条消息在 MessageEntities 里存在至少一条已关闭
// （validUntil IS NOT NULL）的记录，就认为该消息内容可能已过时，供 RAG 召回片段标注使用
// （buildContext.ts）。不影响 getCurrentEntities 等其它查询，仅是一次独立的只读判断
export function getSupersededMessageIds(ids: number[]): Set<number> {
  if (ids.length === 0) return new Set()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT DISTINCT messageId FROM MessageEntities WHERE messageId IN (${placeholders}) AND validUntil IS NOT NULL
  `).all(...ids) as { messageId: number }[]
  return new Set(rows.map(row => row.messageId))
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

// v5 迁移回填（DIV-002：message_fts 分词器换成 simple 后 drop + 重建）：把已 embedded 的历史
// 消息重新索引进新表，否则它们会永久从关键词召回里消失（向量召回不受影响）。放在 session 层
// 而不是 db/index.ts 里，是为了保持 "session → db" 单向依赖，不让 db 层反向 import session 层。
// 调用方：services/core/index.ts 在 initDb() 返回 needsFtsBackfill=true 时调用一次。
export function backfillMessageFts(): number {
  const embeddedMessages = db.prepare(`
    SELECT id, sessionId, content FROM Messages WHERE embedded = 1
  `).all() as { id: number; sessionId: string; content: string }[]
  for (const msg of embeddedMessages) {
    indexMessageFts(msg.id, msg.sessionId, decrypt(msg.content))
  }
  return embeddedMessages.length
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

// ─── Forget（按时间段硬删除，隐私/后悔场景）─────────────────
// 与 insertSummaryAndMarkMessages 同样的"事务化组合"考量：forgetMessages 把级联删除的多个
// DELETE 语句包进一个事务，避免进程在中途崩溃留下"embedding/fts/实体已删但 Messages 还在"
// 或反过来的孤儿数据/半删除中间态

// 按时间范围查该 session 的消息 id（升序），边界 [fromTime, toTime] 为闭区间，供
// checkForgetImpact / forgetTimeRange（forget.ts）判断"删掉这段时间会影响到哪些消息"使用
export function getMessageIdsInTimeRange(sessionId: string, fromTime: number, toTime: number): number[] {
  const rows = db.prepare(`
    SELECT id FROM Messages WHERE sessionId = ? AND createdAt >= ? AND createdAt <= ? ORDER BY id ASC
  `).all(sessionId, fromTime, toTime) as { id: number }[]
  return rows.map(row => row.id)
}

// 查找与 [minMessageId, maxMessageId] 区间有重叠的摘要（区间重叠判断：
// NOT (toMessageId < minMessageId OR fromMessageId > maxMessageId)），content 解密返回，
// 供 checkForgetImpact 判断待删消息是否已被某条摘要覆盖使用
export function getSummariesOverlappingRange(sessionId: string, minMessageId: number, maxMessageId: number): Summary[] {
  const rows = db.prepare(`
    SELECT * FROM Summaries
    WHERE sessionId = ? AND NOT (toMessageId < ? OR fromMessageId > ?)
  `).all(sessionId, minMessageId, maxMessageId) as any[]
  return rows.map(row => ({ ...row, content: decrypt(row.content) }))
}

// 级联硬删除：message_embeddings + message_fts + MessageEntities（按 messageId）+ 指定的
// summaryIdsToDelete（可选）+ Messages 本身，全部在一个事务里完成。messageIds 为空数组时
// 直接返回全 0，不碰数据库（同 getMessagesByIds/getSupersededMessageIds 对空数组输入的处理方式）。
// 强制要求 sessionId 并在每条 DELETE 上都加 session 过滤，作为纵深防御——目前唯一调用方
// （forgetTimeRange）传入的 id 本来就是从同一个 sessionId 查出来的，不会跨 session，
// 但这里是直接导出的底层函数，以后任何脚本/路由如果不小心传了别的 session 的 id 进来，
// 这一层过滤能兜底，不会把安全假设全部压在调用方身上
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

  return run()
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