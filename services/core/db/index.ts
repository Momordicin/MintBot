import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import * as dotenv from 'dotenv'

dotenv.config()

const DB_PATH = process.env.DB_PATH ?? './data/db.sqlite'

// 确保 data 目录存在
const dbDir = path.dirname(DB_PATH)
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}

export const db = new Database(DB_PATH)

// 开启 WAL 模式（提升并发读写性能）
db.pragma('journal_mode = WAL')

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS Presets (
      presetId    TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      characterId TEXT    NOT NULL,
      modelType   TEXT    NOT NULL CHECK(modelType IN ('anthropic', 'openai', 'ollama')),
      modelName   TEXT    NOT NULL,
      systemPrompt TEXT   NOT NULL,
      createdAt   INTEGER NOT NULL,
      updatedAt   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Sessions (
      sessionId      TEXT    PRIMARY KEY,
      presetId       TEXT    NOT NULL,
      presetSnapshot TEXT    NOT NULL,
      characterId    TEXT    NOT NULL,
      title          TEXT,
      createdAt      INTEGER NOT NULL,
      lastActiveAt   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId     TEXT    NOT NULL,
      role          TEXT    NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
      content       TEXT    NOT NULL,
      createdAt     INTEGER NOT NULL,
      embedded      INTEGER NOT NULL DEFAULT 0,
      summarized    INTEGER NOT NULL DEFAULT 0,
      visibleToUser INTEGER NOT NULL DEFAULT 1,
      trigger       TEXT    CHECK(trigger IN ('user', 'scheduler', 'emotion', 'admin')),
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

  console.log('[DB] Initialized')
}