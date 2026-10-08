import DatabaseConstructor, { Database } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec'
import path from 'path'
import fs from 'fs'
import * as dotenv from 'dotenv'
import { getEncryptSensitiveFields } from '../config/security.js'


dotenv.config({ quiet: true })
 
const DB_PATH = process.env.DB_PATH ?? './data/db.sqlite'

if (process.env.VITEST && DB_PATH !== ':memory:') {
  throw new Error(`[DB] refusing to open "${DB_PATH}" under vitest; DB_PATH must be :memory:`)
}
 
const dbDir = path.dirname(DB_PATH)
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}
 
export const db: Database = new DatabaseConstructor(DB_PATH);
 
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
    db.exec(`DROP TABLE IF EXISTS message_fts`)
    db.exec(`
      CREATE VIRTUAL TABLE message_fts USING fts5(
        content,
        message_id UNINDEXED,
        session_id UNINDEXED,
        tokenize = 'simple'
      );
    `)

    needsFtsBackfill = true

    db.pragma('user_version = 5')
    console.log('[DB] Migration v5: switched message_fts tokenizer to simple (Chinese substring search), needs FTS backfill')
  }

  if (current < 6) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_messageId ON MessageEntities(messageId)`)
    db.pragma('user_version = 6')
    console.log('[DB] Migration v6: added messageId index to MessageEntities')
  }

  if (current < 7) {
    db.exec(`ALTER TABLE Presets ADD COLUMN displayConfig TEXT`)
    db.pragma('user_version = 7')
    console.log('[DB] Migration v7: added displayConfig to Presets')
  }

  if (current < 8) {
    const migrateV8 = db.transaction(() => {
      db.exec(`
        CREATE TABLE Presets_new (
          presetId     TEXT    PRIMARY KEY,
          name         TEXT    NOT NULL,
          characterId  TEXT    NOT NULL,
          modelType    TEXT    CHECK(modelType IS NULL OR modelType IN ('anthropic', 'openai', 'ollama')),
          modelName    TEXT,
          wallpaperPath TEXT,
          displayConfig TEXT,
          systemPrompt TEXT    NOT NULL,
          createdAt    INTEGER NOT NULL,
          updatedAt    INTEGER NOT NULL
        );
        INSERT INTO Presets_new SELECT presetId, name, characterId, modelType, modelName, wallpaperPath, displayConfig, systemPrompt, createdAt, updatedAt FROM Presets;
        DROP TABLE Presets;
        ALTER TABLE Presets_new RENAME TO Presets;
      `)
      db.pragma('user_version = 8')
    })
    migrateV8()
    console.log('[DB] Migration v8: Presets.modelType/modelName now nullable (no override falls back to global modelProvider config)')
  }

  if (current < 9) {
    db.exec(`ALTER TABLE Presets ADD COLUMN addressForms TEXT`)
    db.pragma('user_version = 9')
    console.log('[DB] Migration v9: added addressForms to Presets')
  }

  if (current < 10) {
    const migrateV10 = db.transaction(() => {
      db.exec(`
        CREATE TABLE Presets_new (
          presetId     TEXT    PRIMARY KEY,
          name         TEXT    NOT NULL,
          characterId  TEXT    NOT NULL,
          modelType    TEXT    CHECK(modelType IS NULL OR modelType IN ('anthropic', 'openai', 'ollama', 'deepseek')),
          modelName    TEXT,
          wallpaperPath TEXT,
          displayConfig TEXT,
          systemPrompt TEXT    NOT NULL,
          createdAt    INTEGER NOT NULL,
          updatedAt    INTEGER NOT NULL,
          addressForms TEXT
        );
        INSERT INTO Presets_new SELECT presetId, name, characterId, modelType, modelName, wallpaperPath, displayConfig, systemPrompt, createdAt, updatedAt, addressForms FROM Presets;
        DROP TABLE Presets;
        ALTER TABLE Presets_new RENAME TO Presets;
      `)
      db.pragma('user_version = 10')
    })
    migrateV10()
    console.log('[DB] Migration v10: Presets.modelType CHECK constraint now allows deepseek')
  }

  return { needsFtsBackfill }
}

function getLibsimplePath(): string {
  let dirName: string
  let libFileName: string
  if (process.platform === 'win32') {
    dirName = 'libsimple-windows-x64'
    libFileName = 'simple.dll'
  } else if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    dirName = `libsimple-osx-${arch}`
    libFileName = 'libsimple.dylib'
  } else {
    throw new Error(`libsimple 目前只支持 Windows / macOS，当前平台是 ${process.platform}，暂不支持`)
  }
  return path.resolve(process.cwd(), 'services/core/db/vendor', dirName, libFileName)
}

export function initDb(): { needsFtsBackfill: boolean } {
  sqliteVec.load(db)
  db.loadExtension(getLibsimplePath())
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