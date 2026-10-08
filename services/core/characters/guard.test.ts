// services/core/characters/guard.test.ts — manifest.ts 的 vitest 素材目录守卫与生产默认路径测试
//
// 用法：pnpm test
// 配套文件：services/core/characters/manifest.ts

import { describe, it, expect, afterEach, vi } from 'vitest'
import path from 'path'

vi.mock('dotenv', () => ({ default: { config: vi.fn() }, config: vi.fn() }))

describe('素材目录测试环境守卫', () => {
  const originalAssetPath = process.env.ASSET_PATH
  const originalVitest = process.env.VITEST

  afterEach(() => {
    if (originalAssetPath === undefined) delete process.env.ASSET_PATH
    else process.env.ASSET_PATH = originalAssetPath
    if (originalVitest === undefined) delete process.env.VITEST
    else process.env.VITEST = originalVitest
    vi.resetModules()
  })

  it('vitest 下 ASSET_PATH 未指向临时目录时拒绝加载', async () => {
    process.env.ASSET_PATH = './assets'
    vi.resetModules()

    await expect(import('./manifest.js')).rejects.toThrow(/refusing ASSET_PATH/)
  })

  it('非 vitest 且未设置 ASSET_PATH 时默认指向 assets', async () => {
    delete process.env.ASSET_PATH
    delete process.env.VITEST
    vi.resetModules()

    try {
      const { ASSET_ROOT } = await import('./manifest.js')
      expect(ASSET_ROOT).toBe(path.resolve(process.cwd(), 'assets'))
    } finally {
      process.env.VITEST = originalVitest
    }
  })
})
