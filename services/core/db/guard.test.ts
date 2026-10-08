import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

describe('DB 测试环境守卫', () => {
  const originalDbPath = process.env.DB_PATH

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.DB_PATH
    else process.env.DB_PATH = originalDbPath
    vi.resetModules()
  })

  it('vitest 下 DB_PATH 不是 :memory: 时拒绝打开且不创建文件', async () => {
    const tmpPath = path.join(os.tmpdir(), `mintbot-guard-${randomUUID()}.sqlite`)
    process.env.DB_PATH = tmpPath
    vi.resetModules()

    await expect(import('./index.js')).rejects.toThrow(/refusing to open/)
    expect(fs.existsSync(tmpPath)).toBe(false)
  })
})
