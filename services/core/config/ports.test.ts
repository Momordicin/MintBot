// services/core/config/ports.test.ts — ports.ts 的端口解析、env 覆盖与非法值回落测试
//
// 用法：pnpm test
// 配套文件：services/core/config/ports.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('dotenv', () => ({ default: { config: vi.fn() }, config: vi.fn() }))

const ENV_KEYS = ['CORE_PORT', 'AI_PORT', 'VITE_PORT'] as const

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  vi.resetModules()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('ports.ts', () => {
  it('env 变量缺失时使用默认端口', async () => {
    const { CORE_PORT, AI_PORT, RENDERER_PORT, CORE_URL, AI_URL, RENDERER_ORIGIN, RENDERER_ORIGINS } = await import('./ports.js')

    expect(CORE_PORT).toBe(18300)
    expect(AI_PORT).toBe(18765)
    expect(RENDERER_PORT).toBe(18173)
    expect(CORE_URL).toBe('http://127.0.0.1:18300')
    expect(AI_URL).toBe('http://localhost:18765')
    expect(RENDERER_ORIGIN).toBe('http://localhost:18173')
    expect(RENDERER_ORIGINS).toEqual(['http://localhost:18173', 'http://127.0.0.1:18173'])
  })

  it('env 变量存在时覆盖默认端口', async () => {
    process.env.CORE_PORT = '19000'
    process.env.AI_PORT = '19001'
    process.env.VITE_PORT = '19002'

    const { CORE_PORT, AI_PORT, RENDERER_PORT, CORE_URL, AI_URL } = await import('./ports.js')

    expect(CORE_PORT).toBe(19000)
    expect(AI_PORT).toBe(19001)
    expect(RENDERER_PORT).toBe(19002)
    expect(CORE_URL).toBe('http://127.0.0.1:19000')
    expect(AI_URL).toBe('http://localhost:19001')
  })

  it('非法端口值回落到默认值，并各 warn 一次', async () => {
    process.env.CORE_PORT = 'not-a-port'
    process.env.AI_PORT = '-1'
    process.env.VITE_PORT = '0'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CORE_PORT, AI_PORT, RENDERER_PORT } = await import('./ports.js')

    expect(CORE_PORT).toBe(18300)
    expect(AI_PORT).toBe(18765)
    expect(RENDERER_PORT).toBe(18173)
    expect(warnSpy).toHaveBeenCalledTimes(3)

    warnSpy.mockRestore()
  })
})
