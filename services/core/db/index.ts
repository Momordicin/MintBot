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
 
function runMigrations() {
  const current = db.pragma('user_version', { simple: true }) as number
 
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
}
 
export function initDb() {
  sqliteVec.load(db)
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
 
  runMigrations()
  const encrypt = getEncryptSensitiveFields()
  console.log(
    encrypt
      ? '[DB] encryptSensitiveFields = true (AES-256-GCM, FTS disabled)'
      : '[DB] encryptSensitiveFields = false (plaintext at rest, FTS enabled)'
  )
  console.log('[DB] Initialized')
}