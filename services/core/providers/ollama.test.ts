import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { listOllamaModels, shouldEnsureOllama, getOllamaBaseUrl } from './ollama.js'

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

describe('shouldEnsureOllama', () => {
  it.each([
    ['ollama', 'anthropic', false, true],
    ['anthropic', 'ollama', false, true],
    ['anthropic', 'openai', true, true],
    ['ollama', 'ollama', false, true],
    ['anthropic', 'openai', false, false],
    ['deepseek', 'anthropic', false, false],
  ])('对话 %s / 后台 %s / 预设使用 ollama=%s 时返回 %s', (chatType, backgroundType, anyPreset, expected) => {
    expect(shouldEnsureOllama(chatType, backgroundType, anyPreset)).toBe(expected)
  })
})

describe('getOllamaBaseUrl', () => {
  it.each([
    [undefined],
    [''],
  ])('地址为 %j 时使用默认地址', baseUrl => {
    expect(getOllamaBaseUrl(baseUrl)).toBe('http://localhost:11434')
  })

  it('地址非空时原样使用', () => {
    expect(getOllamaBaseUrl('http://192.168.1.5:11434')).toBe('http://192.168.1.5:11434')
  })
})

describe('ensureOllama', () => {
  const spawnMock = vi.fn()
  let up = false

  class FakeProcess extends EventEmitter {
    exitCode: number | null = null
    signalCode: string | null = null
    kill = vi.fn()
  }

  function stubFetch() {
    const fetchMock = vi.fn().mockImplementation(async () => ({ ok: up }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  async function loadModule() {
    vi.resetModules()
    vi.doMock('child_process', () => ({ spawn: spawnMock }))
    return import('./ollama.js')
  }

  beforeEach(() => {
    up = false
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => {
      up = true
      return new FakeProcess()
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.doUnmock('child_process')
  })

  it('并发调用共享同一次启动，只 spawn 一次', async () => {
    stubFetch()
    const { ensureOllama, stopOllamaIfManaged } = await loadModule()

    const results = await Promise.all([ensureOllama(), ensureOllama(), ensureOllama()])

    expect(results).toEqual([true, true, true])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    await stopOllamaIfManaged()
  })

  it('MintBot 持有存活进程且 Ollama 有响应时直接返回 true，不再 spawn，仍由 MintBot 管理', async () => {
    stubFetch()
    const processHandle = new FakeProcess()
    spawnMock.mockImplementation(() => {
      up = true
      return processHandle
    })
    const { ensureOllama, stopOllamaIfManaged } = await loadModule()
    await ensureOllama()

    const second = await ensureOllama()

    expect(second).toBe(true)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    await stopOllamaIfManaged()
    expect(processHandle.kill).toHaveBeenCalledTimes(1)
  })

  it('MintBot 持有存活进程但暂无响应时重新等待而不再 spawn，等到就绪返回 true', async () => {
    vi.useFakeTimers()
    stubFetch()
    spawnMock.mockImplementation(() => new FakeProcess())
    const { ensureOllama, stopOllamaIfManaged } = await loadModule()
    const first = ensureOllama()
    await vi.advanceTimersByTimeAsync(31000)
    expect(await first).toBe(false)

    const second = ensureOllama()
    await vi.advanceTimersByTimeAsync(5000)
    up = true
    await vi.advanceTimersByTimeAsync(2000)

    expect(await second).toBe(true)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    await stopOllamaIfManaged()
  })

  it('MintBot 持有存活进程但始终无响应时等待超时后返回 false，不 spawn 第二个进程', async () => {
    vi.useFakeTimers()
    stubFetch()
    spawnMock.mockImplementation(() => new FakeProcess())
    const { ensureOllama } = await loadModule()
    const first = ensureOllama()
    await vi.advanceTimersByTimeAsync(31000)
    await first

    const second = ensureOllama()
    await vi.advanceTimersByTimeAsync(31000)

    expect(await second).toBe(false)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('MintBot 启动的进程已退出后再次调用会重新 spawn', async () => {
    stubFetch()
    const first = new FakeProcess()
    const second = new FakeProcess()
    spawnMock
      .mockImplementationOnce(() => {
        up = true
        return first
      })
      .mockImplementationOnce(() => {
        up = true
        return second
      })
    const { ensureOllama, stopOllamaIfManaged } = await loadModule()
    await ensureOllama()
    first.exitCode = 1
    up = false

    const result = await ensureOllama()

    expect(result).toBe(true)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    await stopOllamaIfManaged()
    expect(second.kill).toHaveBeenCalledTimes(1)
  })

  it('外部已运行的 Ollama 不 spawn，也不由 MintBot 管理', async () => {
    stubFetch()
    const owned = new FakeProcess()
    spawnMock.mockImplementationOnce(() => {
      up = true
      return owned
    })
    const { ensureOllama, stopOllamaIfManaged } = await loadModule()
    await ensureOllama()
    owned.exitCode = 0

    const result = await ensureOllama()
    await stopOllamaIfManaged()

    expect(result).toBe(true)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(owned.kill).not.toHaveBeenCalled()
  })

  it('spawn 抛错时返回 false', async () => {
    stubFetch()
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const { ensureOllama } = await loadModule()

    expect(await ensureOllama()).toBe(false)
  })

  it('子进程触发 error 时立即返回 false，不等满 30 秒', async () => {
    vi.useFakeTimers()
    stubFetch()
    spawnMock.mockImplementation(() => {
      const processHandle = new FakeProcess()
      void Promise.resolve().then(() => processHandle.emit('error', new Error('ENOENT')))
      return processHandle
    })
    const { ensureOllama } = await loadModule()

    expect(await ensureOllama()).toBe(false)
  })

  it('子进程触发 error 后，下一次调用会重新 spawn', async () => {
    vi.useFakeTimers()
    stubFetch()
    spawnMock.mockImplementation(() => {
      const processHandle = new FakeProcess()
      void Promise.resolve().then(() => processHandle.emit('error', new Error('ENOENT')))
      return processHandle
    })
    const { ensureOllama } = await loadModule()

    expect(await ensureOllama()).toBe(false)
    expect(await ensureOllama()).toBe(false)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('子进程在就绪前退出时立即返回 false，不等满 30 秒', async () => {
    vi.useFakeTimers()
    stubFetch()
    spawnMock.mockImplementation(() => {
      const processHandle = new FakeProcess()
      void Promise.resolve().then(() => processHandle.emit('exit', 1, null))
      return processHandle
    })
    const { ensureOllama } = await loadModule()

    expect(await ensureOllama()).toBe(false)
  })

  it('一次启动结束后清除共享状态，下一次调用会重新探测', async () => {
    up = true
    const fetchMock = stubFetch()
    const { ensureOllama } = await loadModule()

    await ensureOllama()
    await ensureOllama()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
