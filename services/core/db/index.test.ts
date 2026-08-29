import { describe, it, expect } from 'vitest'
import { db, initDb } from './index.js'

// initDb() 已在 queries.test.ts 等文件里被调用过一次（同一进程内的 db 单例），这里只
// 断言迁移链跑完之后的最终状态：user_version 到 7，Presets 表带 displayConfig 列。
// 不单独模拟从 v6 升到 v7 的中间态——runMigrations() 里每一级迁移都是纯 SQL DDL，
// 真正需要验证的是"全新库从 0 跑到 7"与"列确实存在"，这与 v1/v5 等既有迁移目前
// 在仓库里的验证深度一致（没有专门 mock user_version 起点的迁移测试先例）
describe('DB 迁移 (runMigrations)', () => {
  it('迁移链跑完后 user_version 为 7', () => {
    initDb()
    expect(db.pragma('user_version', { simple: true })).toBe(7)
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
