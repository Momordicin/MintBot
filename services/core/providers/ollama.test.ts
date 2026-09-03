import { describe, it, expect, afterEach, vi } from 'vitest'
import { listOllamaModels } from './ollama.js'

// listOllamaModels 是 GET /models（CharacterPanel.tsx §2 模型名下拉框）的数据源，
// 与 isOllamaRunning 同款降级风格测试：只验证成功解析 + 各类失败都降级为空数组，不抛错
describe('listOllamaModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('成功时解析 .models[].name，返回模型名数组', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3' }, { name: 'llama3' }] }),
    }))

    const result = await listOllamaModels('http://localhost:11434')

    expect(result).toEqual(['qwen3', 'llama3'])
  })

  it('响应 ok=false 时返回空数组', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))

    const result = await listOllamaModels('http://localhost:11434')

    expect(result).toEqual([])
  })

  it('响应体里 models 不是数组时返回空数组，不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: 'not-an-array' }),
    }))

    const result = await listOllamaModels('http://localhost:11434')

    expect(result).toEqual([])
  })

  it('fetch 抛出（Ollama 未运行）时返回空数组，不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const result = await listOllamaModels('http://localhost:11434')

    expect(result).toEqual([])
  })

  it('models 数组里混入形状不对的条目时，忽略该条目而不是整体失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3' }, { notName: 'oops' }, null] }),
    }))

    const result = await listOllamaModels('http://localhost:11434')

    expect(result).toEqual(['qwen3'])
  })
})
