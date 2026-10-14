import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db, initDb, checkpointTruncate } from './index.js'

describe('DB 迁移 (runMigrations)', () => {
  it('迁移链跑完后 user_version 为 12', () => {
    initDb()
    expect(db.pragma('user_version', { simple: true })).toBe(12)
  })

  it('PresetApiKeys 表按 v12 定义存在（主键 presetId + provider，provider 受 CHECK 约束，fromEnv 默认 0）', () => {
    initDb()
    const columns = db.pragma('table_info(PresetApiKeys)') as { name: string; notnull: number; dflt_value: string | null; pk: number }[]
    expect(columns.map(c => c.name)).toEqual(['presetId', 'provider', 'apiKey', 'fromEnv'])
    expect(columns.filter(c => c.pk > 0).map(c => c.name)).toEqual(['presetId', 'provider'])
    expect(columns.find(c => c.name === 'fromEnv')?.dflt_value).toBe('0')

    db.exec(`DELETE FROM PresetApiKeys`)
    db.prepare(`INSERT INTO PresetApiKeys (presetId, provider) VALUES ('p1', 'openai')`).run()
    expect(db.prepare(`SELECT apiKey, fromEnv FROM PresetApiKeys WHERE presetId = 'p1'`).get()).toEqual({ apiKey: null, fromEnv: 0 })
    expect(() => db.prepare(`INSERT INTO PresetApiKeys (presetId, provider) VALUES ('p1', 'ollama')`).run()).toThrow()
    db.exec(`DELETE FROM PresetApiKeys`)
  })

  it('Presets 表带 displayConfig 列（migration v7）', () => {
    initDb()
    const columns = db.pragma('table_info(Presets)') as { name: string }[]
    expect(columns.map(c => c.name)).toContain('displayConfig')
  })

  it('Presets 表带 wallpaperPath 列（migration v1，回归防护）', () => {
    initDb()
    const columns = db.pragma('table_info(Presets)') as { name: string }[]
    expect(columns.map(c => c.name)).toContain('wallpaperPath')
  })

  it('Presets 表带 addressForms 列（migration v9）', () => {
    initDb()
    const columns = db.pragma('table_info(Presets)') as { name: string }[]
    expect(columns.map(c => c.name)).toContain('addressForms')
  })
})

// migration v9：既有行（迁移前从未写过 addressForms 的旧行）新增列后为 NULL，
// 读时应等价于空数组（session/queries.ts 的 parseAddressForms），不抛错、不告警
describe('DB 迁移 v9 (Presets.addressForms)', () => {
  beforeEach(() => {
    initDb()
    db.exec(`DELETE FROM Presets`)
  })

  it('既有 preset 行迁移后 addressForms 列为 NULL', () => {
    db.prepare(`
      INSERT INTO Presets (presetId, name, characterId, modelType, modelName, systemPrompt, createdAt, updatedAt)
      VALUES ('p1', '角色一', 'char-001', 'ollama', 'qwen3', '你是角色一', 0, 0)
    `).run()

    const row = db.prepare(`SELECT addressForms FROM Presets WHERE presetId = ?`).get('p1') as { addressForms: string | null }
    expect(row.addressForms).toBeNull()
  })

  it('新写入的 addressForms 值能正常落盘读回（未加密模式下为明文 JSON）', () => {
    db.exec(`DELETE FROM Presets`)
    db.prepare(`
      INSERT INTO Presets (presetId, name, characterId, modelType, modelName, systemPrompt, addressForms, createdAt, updatedAt)
      VALUES ('p2', '角色二', 'char-002', 'ollama', 'qwen3', '你是角色二', ?, 0, 0)
    `).run(JSON.stringify(['小明', '笨蛋']))

    const row = db.prepare(`SELECT addressForms FROM Presets WHERE presetId = ?`).get('p2') as { addressForms: string | null }
    expect(JSON.parse(row.addressForms!)).toEqual(['小明', '笨蛋'])
  })
})

describe('DB 彻底删除（secure_delete / migration v11 / checkpointTruncate）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('连接的 PRAGMA secure_delete 为 1', () => {
    initDb()
    expect(db.pragma('secure_delete', { simple: true })).toBe(1)
  })

  it('message_fts 的 secure-delete 配置为 1', () => {
    initDb()
    const row = db.prepare(`SELECT v FROM message_fts_config WHERE k = 'secure-delete'`).get() as { v: number } | undefined
    expect(row?.v).toBe(1)
  })

  it('checkpointTruncate 在 busy 非 0 时只 console.warn、不抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(db, 'pragma').mockReturnValue([{ busy: 1, log: 5, checkpointed: 2 }])

    expect(() => checkpointTruncate('[Test]')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('[Test]')
  })

  it('checkpointTruncate 未能截断（log > checkpointed）时只 console.warn、不抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(db, 'pragma').mockReturnValue([{ busy: 0, log: 5, checkpointed: 2 }])

    expect(() => checkpointTruncate('[Test]')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('checkpointTruncate 的 pragma 抛错时只 console.warn、不抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(db, 'pragma').mockImplementation(() => { throw new Error('locked') })

    expect(() => checkpointTruncate('[Test]')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('checkpointTruncate 成功（busy=0、log=0）或非 WAL 连接（log=-1）时不告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pragma = vi.spyOn(db, 'pragma')
    pragma.mockReturnValueOnce([{ busy: 0, log: 0, checkpointed: 0 }])
    pragma.mockReturnValueOnce([{ busy: 0, log: -1, checkpointed: -1 }])

    checkpointTruncate('[Test]')
    checkpointTruncate('[Test]')
    expect(warn).not.toHaveBeenCalled()
  })
})

// migration v8：Presets.modelType/modelName 从 NOT NULL 转为可空（建新表 + 搬数据 +
// 删旧表 + 改名重建），验证已有数据不受影响、新的 null 值被允许、非法值仍被 CHECK 拒绝
describe('DB 迁移 v8 (Presets.modelType/modelName 可空)', () => {
  beforeEach(() => {
    initDb()
    db.exec(`DELETE FROM Presets`)
  })

  it('已有 preset 行迁移后保持原有的 modelType/modelName 值不变', () => {
    db.prepare(`
      INSERT INTO Presets (presetId, name, characterId, modelType, modelName, systemPrompt, createdAt, updatedAt)
      VALUES ('p1', '角色一', 'char-001', 'ollama', 'qwen3', '你是角色一', 0, 0)
    `).run()

    const row = db.prepare(`SELECT * FROM Presets WHERE presetId = ?`).get('p1') as { modelType: string; modelName: string }
    expect(row.modelType).toBe('ollama')
    expect(row.modelName).toBe('qwen3')
  })

  it('新建 preset 允许 modelType/modelName 为 null（未自定义，跟随全局配置）', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO Presets (presetId, name, characterId, modelType, modelName, systemPrompt, createdAt, updatedAt)
        VALUES ('p2', '角色二', 'char-002', NULL, NULL, '你是角色二', 0, 0)
      `).run()
    }).not.toThrow()

    const row = db.prepare(`SELECT * FROM Presets WHERE presetId = ?`).get('p2') as { modelType: string | null; modelName: string | null }
    expect(row.modelType).toBeNull()
    expect(row.modelName).toBeNull()
  })

  it('非 null 的非法 modelType 值仍被 CHECK 约束拒绝', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO Presets (presetId, name, characterId, modelType, modelName, systemPrompt, createdAt, updatedAt)
        VALUES ('p3', '角色三', 'char-003', 'not-a-real-type', 'model', '你是角色三', 0, 0)
      `).run()
    }).toThrow()
  })
})

// migration v10：Presets.modelType 的 CHECK 约束加入 'deepseek'（建新表 + 搬数据 +
// 删旧表 + 改名重建，同 v8 先例），验证 v10 之前会被拒绝的 deepseek 值现在能插入成功，
// 且既有列（addressForms/displayConfig/wallpaperPath）在重建后仍然存在、旧行数据未丢失
describe('DB 迁移 v10 (Presets.modelType 支持 deepseek)', () => {
  beforeEach(() => {
    initDb()
    db.exec(`DELETE FROM Presets`)
  })

  it('modelType = deepseek 的行能插入成功（v10 之前会被 CHECK 拒绝）', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO Presets (presetId, name, characterId, modelType, modelName, systemPrompt, createdAt, updatedAt)
        VALUES ('p1', '角色一', 'char-001', 'deepseek', 'deepseek-v4-flash', '你是角色一', 0, 0)
      `).run()
    }).not.toThrow()

    const row = db.prepare(`SELECT * FROM Presets WHERE presetId = ?`).get('p1') as { modelType: string; modelName: string }
    expect(row.modelType).toBe('deepseek')
    expect(row.modelName).toBe('deepseek-v4-flash')
  })

  it('重建后既有列（addressForms/displayConfig/wallpaperPath）仍然存在，旧行数据未丢失', () => {
    db.prepare(`
      INSERT INTO Presets (presetId, name, characterId, modelType, modelName, wallpaperPath, displayConfig, systemPrompt, addressForms, createdAt, updatedAt)
      VALUES ('p2', '角色二', 'char-002', 'ollama', 'qwen3', 'p2-bg.jpg', '{"chatBgRgb":[1,2,3],"chatBgOpacity":0.5}', '你是角色二', ?, 0, 0)
    `).run(JSON.stringify(['小明']))

    const columns = db.pragma('table_info(Presets)') as { name: string }[]
    const columnNames = columns.map(c => c.name)
    expect(columnNames).toContain('addressForms')
    expect(columnNames).toContain('displayConfig')
    expect(columnNames).toContain('wallpaperPath')

    const row = db.prepare(`SELECT * FROM Presets WHERE presetId = ?`).get('p2') as {
      wallpaperPath: string
      displayConfig: string
      addressForms: string
    }
    expect(row.wallpaperPath).toBe('p2-bg.jpg')
    expect(JSON.parse(row.displayConfig)).toEqual({ chatBgRgb: [1, 2, 3], chatBgOpacity: 0.5 })
    expect(JSON.parse(row.addressForms)).toEqual(['小明'])
  })
})
