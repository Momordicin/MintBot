// services/core/routes/wallpaperGuard.test.ts — presets.ts 的 vitest 壁纸目录守卫与生产默认路径测试
//
// 用法：pnpm test
// 配套文件：services/core/routes/presets.ts

import { describe, it, expect, afterEach, vi } from 'vitest'
import path from 'path'

vi.mock('dotenv', () => ({ default: { config: vi.fn() }, config: vi.fn() }))

describe('壁纸目录测试环境守卫', () => {
  const originalWallpaperPath = process.env.WALLPAPER_PATH
  const originalVitest = process.env.VITEST

  afterEach(() => {
    if (originalWallpaperPath === undefined) delete process.env.WALLPAPER_PATH
    else process.env.WALLPAPER_PATH = originalWallpaperPath
    if (originalVitest === undefined) delete process.env.VITEST
    else process.env.VITEST = originalVitest
    vi.resetModules()
  })

  it('vitest 下 WALLPAPER_PATH 未指向临时目录时拒绝加载', async () => {
    delete process.env.WALLPAPER_PATH
    vi.resetModules()

    await expect(import('./presets.js')).rejects.toThrow(/refusing WALLPAPER_PATH/)
  })

  it('非 vitest 且未设置 WALLPAPER_PATH 时默认指向 data/wallpapers', async () => {
    delete process.env.WALLPAPER_PATH
    delete process.env.VITEST
    vi.resetModules()

    try {
      const { WALLPAPER_DIR } = await import('./presets.js')
      expect(WALLPAPER_DIR).toBe(path.resolve(process.cwd(), 'data/wallpapers'))
    } finally {
      process.env.VITEST = originalVitest
    }
  })
})
