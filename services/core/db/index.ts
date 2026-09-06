import DatabaseConstructor, { Database } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec'
import path from 'path'
import fs from 'fs'
import * as dotenv from 'dotenv'
import { getEncryptSensitiveFields } from '../config/security.js'


dotenv.config({ quiet: true })
 
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

  if (current < 8) {
    // modelType/modelName 是建表语句里的 NOT NULL（modelType 还带 CHECK），SQLite 不支持
    // ALTER TABLE 摘除约束，只能走标准的"建新表 + 搬数据 + 删旧表 + 改名"重建流程（比
    // v1/v7 的 ALTER TABLE ADD COLUMN 重得多），整个迁移块包在 db.transaction() 里保证
    // 原子性，避免中途崩溃丢数据。目的：支持"每 preset 可选自定义对话模型，未自定义则
    // 跟随全局 modelProvider 配置"（设置页模型配置功能）。已有 5 个种子 preset 的
    // modelType/modelName 保持原值不变（视为"已经自定义"），不重置为 null——不引入任何
    // 隐式行为变化
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
    // 角色对用户的称呼候选集（加密 JSON 数组），与 wallpaperPath/displayConfig 同样的
    // 简单 ALTER TABLE ADD COLUMN（可空、无约束，不需要 v8 那种整表重建），见
    // docs/MintBot_TDD.md §3.2.2「Presets.addressForms」
    db.exec(`ALTER TABLE Presets ADD COLUMN addressForms TEXT`)
    db.pragma('user_version = 9')
    console.log('[DB] Migration v9: added addressForms to Presets')
  }

  if (current < 10) {
    // modelType 的 CHECK 约束需要加入 'deepseek'，SQLite 不支持 ALTER TABLE 修改 CHECK
    // 约束，只能走 v8 先例的"建新表 + 搬数据 + 删旧表 + 改名"重建流程。新表需要包含
    // 当前全部 11 列（addressForms 是 v9 用 ALTER TABLE 追加在末尾的，实际列顺序见下方
    // INSERT INTO ... SELECT 的显式列名）。目的：支持把 DeepSeek 提升为一等公民
    // model provider 类型（而非此前的"走 openai 类型 + 自定义 baseUrl"）
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

// simple 分词器扩展（libsimple，wangfenjin/simple v0.7.1 预编译版，见 vendor/ 下按平台命名的
// 目录）按平台选择动态库文件名，跟 scripts/setup-vendor.ts 里 getPlatformTarget() 的映射表
// 一一对应，两处各自独立维护（映射表足够小，不值得为了避免重复引入跨文件依赖），改动时两处
// 都要看一眼。不支持的平台在这里直接抛清楚的错误，而不是让 db.loadExtension() 抛一个难以
// 理解的原生错误。
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
  // message_fts 建表用到 tokenize='simple'，必须在任何 FTS5 相关的建表语句之前加载。用相对于
  // process.cwd() 的项目根目录路径而非 __dirname：tsc 编译不会把 vendor/ 下的非 .ts 资源复制到
  // out/ 目录，用项目根目录相对路径可以保证 tsx 直接跑源码（tsx watch services/core/index.ts）
  // 和编译后跑 out/（pm2 start ecosystem.config.cjs）都能找到同一份 vendor 文件，两种启动方式
  // 的工作目录都是项目根目录。
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