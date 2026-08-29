import DatabaseConstructor, { Database } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec'
import path from 'path'
import fs from 'fs'
import * as dotenv from 'dotenv'
import { getEncryptSensitiveFields } from '../config/security.js'


dotenv.config()
 
const DB_PATH = process.env.DB_PATH ?? './data/db.sqlite'
 
// 确保 data 目录存在
const dbDir = path.dirname(DB_PATH)
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}
 
export const db: Database = new DatabaseConstructor(DB_PATH);
 
// 开启 WAL 模式（提升并发读写性能）
db.pragma('journal_mode = WAL')
 
function runMigrations(): { needsFtsBackfill: boolean } {
  const current = db.pragma('user_version', { simple: true }) as number
  let needsFtsBackfill = false

  if (current < 1) {
    db.exec(`ALTER TABLE Presets ADD COLUMN wallpaperPath TEXT`)
    db.pragma('user_version = 1')
    console.log('[DB] Migration v1: added wallpaperPath to Presets')
  }

  if (current < 2) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS message_embeddings USING vec0(
      message_id INTEGER PRIMARY KEY,
      embedding FLOAT[1024]
    )
  `)
  db.pragma('user_version = 2')
  console.log('[DB] Migration v2: created message_embeddings vec table')
  }

  if (current < 3) {
    // vec0 虚拟表不支持 ALTER 添加 PARTITION KEY，需 drop + 重建；
    // message_embeddings 目前无 embedding 生产者写入，表为空，drop 安全
    db.exec(`
      DROP TABLE IF EXISTS message_embeddings;

      CREATE VIRTUAL TABLE message_embeddings USING vec0(
        message_id INTEGER PRIMARY KEY,
        session_id TEXT PARTITION KEY,
        embedding FLOAT[1024]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
        content,
        message_id UNINDEXED,
        session_id UNINDEXED,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS MessageEntities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        messageId   INTEGER NOT NULL,
        sessionId   TEXT    NOT NULL,
        type        TEXT    NOT NULL,  -- person / event / preference / place / other
        value       TEXT    NOT NULL,
        validFrom   INTEGER NOT NULL,  -- Unix 毫秒，事实生效时间
        validUntil  INTEGER,           -- NULL 表示当前仍有效，双时态设计
        createdAt   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entities_session ON MessageEntities(sessionId);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON MessageEntities(sessionId, type);
    `)
    db.pragma('user_version = 3')
    console.log('[DB] Migration v3: repartitioned message_embeddings by session_id, added message_fts + MessageEntities')
  }

  if (current < 4) {
    // 每个 session 当前情绪状态（可覆盖，非历史时间线）；perceivedUser* 两列按 TDD §3.9
    // 完整结构建表，Phase 2 基础版恒为 NULL，避免将来实现 perceived_user 时再次迁移
    db.exec(`
      CREATE TABLE IF NOT EXISTS EmotionStates (
        sessionId          TEXT    PRIMARY KEY,
        selfLabel          TEXT    NOT NULL,
        selfIntensity      REAL    NOT NULL,
        perceivedUserLabel TEXT,
        perceivedUserIntensity REAL,
        updatedAt          INTEGER NOT NULL
      );
    `)
    db.pragma('user_version = 4')
    console.log('[DB] Migration v4: created EmotionStates table')
  }

  if (current < 5) {
    // FTS5 虚拟表不支持原地更换分词器，只能 drop + 重建（同 v3 迁移 message_embeddings 的先例）。
    // DIV-002：unicode61 对中文基本不分词（整段中文被当成一个 token），关键词召回对中文完全失效；
    // 换成 simple（wangfenjin/simple，libsimple 扩展，见 vendor/libsimple-windows-x64/）后中文按
    // 逐字符子串索引，可命中任意跨"词"边界的子串，已用真实数据验证。官方文档提到的拼音检索
    // （如输入 "zhangliang" 命中"张亮"）实测未生效，具体原因未查明，不在本次修复范围内，
    // 后续如需拼音检索需单独调研。
    db.exec(`DROP TABLE IF EXISTS message_fts`)
    db.exec(`
      CREATE VIRTUAL TABLE message_fts USING fts5(
        content,
        message_id UNINDEXED,
        session_id UNINDEXED,
        tokenize = 'simple'
      );
    `)

    // 回填：indexMessageFts 只在 processEmbedQueue 处理 pending 消息时被调用一次，已经
    // embedded 的历史消息不会自动重新走这个流程；直接 drop + 重建会导致它们永久从关键词召回
    // 里消失（向量召回不受影响）。回填本身需要调用 session 层的 indexMessageFts，为保持
    // "session → db" 单向依赖（db 层不反向 import session 层），这里只标记需要回填，
    // 由调用方（services/core/index.ts）在 initDb() 之后决定是否执行实际回填。
    needsFtsBackfill = true

    db.pragma('user_version = 5')
    console.log('[DB] Migration v5: switched message_fts tokenizer to simple (Chinese substring search), needs FTS backfill')
  }

  if (current < 6) {
    // getSupersededMessageIds（RAG 召回失效标注，见 memory/retrieval.ts）新增了按 messageId
    // 查 MessageEntities 的路径，之前只有 sessionId / (sessionId, type) 两个索引，messageId
    // 上是全表扫描；每次触发 RAG 召回都会跑一次，加个索引避免长期运行后表变大时的扫描成本
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_messageId ON MessageEntities(messageId)`)
    db.pragma('user_version = 6')
    console.log('[DB] Migration v6: added messageId index to MessageEntities')
  }

  if (current < 7) {
    // 每角色显示设置（聊天窗口背景叠色）JSON blob，读时按 session/displayConfig.ts 的
    // parseDisplayConfig 合并默认值，见 TDD §3.2.2「Presets.displayConfig」
    db.exec(`ALTER TABLE Presets ADD COLUMN displayConfig TEXT`)
    db.pragma('user_version = 7')
    console.log('[DB] Migration v7: added displayConfig to Presets')
  }

  return { needsFtsBackfill }
}

export function initDb(): { needsFtsBackfill: boolean } {
  sqliteVec.load(db)
  // simple 分词器扩展（libsimple，wangfenjin/simple v0.7.1 Windows x64 预编译版，见 vendor/
  // libsimple-windows-x64/），message_fts 建表用到 tokenize='simple'，必须在任何 FTS5 相关的
  // 建表语句之前加载。用相对于 process.cwd() 的项目根目录路径而非 __dirname：tsc 编译不会把
  // vendor/ 下的非 .ts 资源复制到 out/ 目录，用项目根目录相对路径可以保证 tsx 直接跑源码
  // （tsx watch services/core/index.ts）和编译后跑 out/（pm2 start ecosystem.config.cjs）
  // 都能找到同一份 vendor 文件，两种启动方式的工作目录都是项目根目录。
  db.loadExtension(path.resolve(process.cwd(), 'services/core/db/vendor/libsimple-windows-x64/simple.dll'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS Presets (
      presetId     TEXT    PRIMARY KEY,
      name         TEXT    NOT NULL,
      characterId  TEXT    NOT NULL,
      modelType    TEXT    NOT NULL CHECK(modelType IN ('anthropic', 'openai', 'ollama')),
      modelName    TEXT    NOT NULL,
      systemPrompt TEXT    NOT NULL,
      createdAt    INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL
    );
 
    CREATE TABLE IF NOT EXISTS Sessions (
      sessionId      TEXT    PRIMARY KEY,
      presetId       TEXT    NOT NULL,
      presetSnapshot TEXT    NOT NULL,
      title          TEXT,
      createdAt      INTEGER NOT NULL,
      lastActiveAt   INTEGER NOT NULL
    );
 
    CREATE TABLE IF NOT EXISTS Messages (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId      TEXT    NOT NULL,
      role           TEXT    NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
      content        TEXT    NOT NULL,
      createdAt      INTEGER NOT NULL,
      embedded       INTEGER NOT NULL DEFAULT 0,
      summarized     INTEGER NOT NULL DEFAULT 0,
      visibleToUser  INTEGER NOT NULL DEFAULT 1,
      trigger        TEXT    CHECK(trigger IN ('user', 'scheduler', 'emotion', 'admin')),
      triggerEventId INTEGER
    );
 
    CREATE TABLE IF NOT EXISTS Summaries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId     TEXT    NOT NULL,
      content       TEXT    NOT NULL,
      fromMessageId INTEGER NOT NULL,
      toMessageId   INTEGER NOT NULL,
      createdAt     INTEGER NOT NULL
    );
 
    CREATE INDEX IF NOT EXISTS idx_messages_session ON Messages(sessionId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_messages_visible ON Messages(sessionId, visibleToUser);
    CREATE INDEX IF NOT EXISTS idx_summaries_session ON Summaries(sessionId);
  `)
 
  const { needsFtsBackfill } = runMigrations()
  const encrypt = getEncryptSensitiveFields()
  console.log(
    encrypt
      ? '[DB] encryptSensitiveFields = true (AES-256-GCM, FTS disabled)'
      : '[DB] encryptSensitiveFields = false (plaintext at rest, FTS enabled)'
  )
  console.log('[DB] Initialized')
  return { needsFtsBackfill }
}