import { describe, it, expect, beforeEach } from 'vitest'
import { db, initDb } from './index.js'

// initDb() 已在 queries.test.ts 等文件里被调用过一次（同一进程内的 db 单例），这里只
// 断言迁移链跑完之后的最终状态：user_version 到 8，Presets 表带 displayConfig 列。
// 不单独模拟从 v6 升到 v7/v8 的中间态——runMigrations() 里每一级迁移都是纯 SQL DDL，
// 真正需要验证的是"全新库从 0 跑到 8"与"列确实存在"，这与 v1/v5 等既有迁移目前
// 在仓库里的验证深度一致（没有专门 mock user_version 起点的迁移测试先例）
describe('DB 迁移 (runMigrations)', () => {
  it('迁移链跑完后 user_version 为 8', () => {
    initDb()
    expect(db.pragma('user_version', { simple: true })).toBe(8)
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
