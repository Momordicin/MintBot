import { describe, it, expect, beforeEach, vi } from 'vitest'

// 独立 config 模块内部依赖 fs.readFileSync 读取 config.json、chokidar 监听文件变化——
// mock 掉这两个依赖，测试结果不受本机真实 config.json 内容影响，也不需要真实写文件。
// mock 函数本身用 vi.hoisted 声明，保证 vi.resetModules() 重新导入被测模块时，mock 引用
// 不会跟着失效（模块注册表被清空重建，但 hoisted 的这几个 vi.fn() 实例本身还是同一个）。
const { readFileSyncMock, watchMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  watchMock: vi.fn(),
}))
vi.mock('fs', () => ({ default: { readFileSync: readFileSyncMock } }))
vi.mock('chokidar', () => ({ default: { watch: watchMock } }))

const DEFAULT_MEMORY_CONFIG = {
  recentTrackMaxMessages: 50,
  recentTrackMaxMinutes: 30,
  organizeWindowStartHour: 22,
  organizeWindowEndHour: 8,
  summaryTrigger: {
    pendingCountThreshold: 100,
    oldestPendingAgeMinutes: 120,
    messageCountThreshold: 50,
    lockScreenMinutes: 60,
  },
  contextBudget: {
    total: 8000,
    systemPrompt: 1000,
    summary: 1500,
    rag: 2000,
    recentMessages: 3000,
    responseReserve: 500,
  },
}

function fullValidConfig(memoryOverrides: Record<string, unknown> = {}) {
  return {
    modelProvider: { type: 'ollama', ollamaBaseUrl: 'http://localhost:11434' },
    memory: {
      recentTrackMaxMessages: 80,
      recentTrackMaxMinutes: 45,
      organizeWindowStartHour: 23,
      organizeWindowEndHour: 7,
      summaryTrigger: {
        pendingCountThreshold: 150,
        oldestPendingAgeMinutes: 90,
        messageCountThreshold: 40,
        lockScreenMinutes: 30,
      },
      contextBudget: {
        total: 9000,
        systemPrompt: 900,
        summary: 1600,
        rag: 2100,
        recentMessages: 3400,
        responseReserve: 600,
      },
      ...memoryOverrides,
    },
  }
}

// 每个用例开始前重置模块注册表：config/index.ts 模块级的 loaded/currentMemoryConfig 等
// 可变状态不应该跨用例泄漏，每个用例都从"从未加载过"的干净状态开始
beforeEach(() => {
  vi.resetModules()
  readFileSyncMock.mockReset()
  watchMock.mockReset()
  watchMock.mockReturnValue({ on: vi.fn() })
})

describe('config/index — 有效完整配置', () => {
  it('加载完整合法的 config.json 时，各字段按原样使用', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify(fullValidConfig()))
    const { startConfigWatcher, getMemoryConfig, getModelProviderConfig } = await import('./index.js')

    startConfigWatcher()

    expect(getMemoryConfig()).toEqual({
      recentTrackMaxMessages: 80,
      recentTrackMaxMinutes: 45,
      organizeWindowStartHour: 23,
      organizeWindowEndHour: 7,
      summaryTrigger: {
        pendingCountThreshold: 150,
        oldestPendingAgeMinutes: 90,
        messageCountThreshold: 40,
        lockScreenMinutes: 30,
      },
      contextBudget: {
        total: 9000,
        systemPrompt: 900,
        summary: 1600,
        rag: 2100,
        recentMessages: 3400,
        responseReserve: 600,
      },
    })
    expect(getModelProviderConfig()).toEqual({ type: 'ollama', ollamaBaseUrl: 'http://localhost:11434' })
  })
})

describe('config/index — 缺失/类型错误字段回退默认值', () => {
  it('config.json 不存在（读取抛错）时，全部字段回退默认值并打印警告', async () => {
    readFileSyncMock.mockImplementation(() => { throw new Error('ENOENT') })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startConfigWatcher, getMemoryConfig } = await import('./index.js')

    startConfigWatcher()

    expect(getMemoryConfig()).toEqual(DEFAULT_MEMORY_CONFIG)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('memory.recentTrackMaxMessages 类型错误时，该字段回退默认值 50，其余字段不受影响', async () => {
    const config = fullValidConfig({ recentTrackMaxMessages: 'not-a-number' })
    readFileSyncMock.mockReturnValue(JSON.stringify(config))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startConfigWatcher, getMemoryConfig } = await import('./index.js')

    startConfigWatcher()

    expect(getMemoryConfig().recentTrackMaxMessages).toBe(50)
    expect(getMemoryConfig().recentTrackMaxMinutes).toBe(45)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('memory.summaryTrigger.pendingCountThreshold 缺失时，仅该子字段回退默认值 100', async () => {
    const config = fullValidConfig()
    delete (config.memory.summaryTrigger as Record<string, unknown>).pendingCountThreshold
    readFileSyncMock.mockReturnValue(JSON.stringify(config))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startConfigWatcher, getMemoryConfig } = await import('./index.js')

    startConfigWatcher()

    expect(getMemoryConfig().summaryTrigger.pendingCountThreshold).toBe(100)
    expect(getMemoryConfig().summaryTrigger.oldestPendingAgeMinutes).toBe(90)
  })

  it('memory 整个字段缺失时，MemoryConfig 全部回退默认值', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ modelProvider: { type: 'ollama' } }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startConfigWatcher, getMemoryConfig } = await import('./index.js')

    startConfigWatcher()

    expect(getMemoryConfig()).toEqual(DEFAULT_MEMORY_CONFIG)
  })
})

describe('config/index — 部分配置与默认值合并', () => {
  it('只设置部分字段的 config.json，未设置的字段使用默认值，已设置的字段生效', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      modelProvider: { type: 'ollama' },
      memory: {
        recentTrackMaxMessages: 200,
        contextBudget: { rag: 5000 },
      },
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startConfigWatcher, getMemoryConfig } = await import('./index.js')

    startConfigWatcher()

    const memoryConfig = getMemoryConfig()
    expect(memoryConfig.recentTrackMaxMessages).toBe(200)
    expect(memoryConfig.recentTrackMaxMinutes).toBe(30)
    expect(memoryConfig.contextBudget.rag).toBe(5000)
    expect(memoryConfig.contextBudget.summary).toBe(1500)
    expect(memoryConfig.summaryTrigger).toEqual(DEFAULT_MEMORY_CONFIG.summaryTrigger)
  })
})

describe('config/index — 热更新', () => {
  it('文件变化时重新加载，getMemoryConfig 反映新值，onReload 回调被调用', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify(fullValidConfig()))
    const onMock = vi.fn()
    watchMock.mockReturnValue({ on: onMock })
    const { startConfigWatcher, getMemoryConfig } = await import('./index.js')

    const onReload = vi.fn()
    startConfigWatcher(onReload)
    expect(getMemoryConfig().recentTrackMaxMessages).toBe(80)

    // 捕获 chokidar.watch(...).on('change', cb) 注册的回调，模拟文件变化事件
    const changeCallback = onMock.mock.calls.find(call => call[0] === 'change')?.[1]
    expect(changeCallback).toBeTypeOf('function')

    readFileSyncMock.mockReturnValue(JSON.stringify(fullValidConfig({ recentTrackMaxMessages: 999 })))
    changeCallback()

    expect(getMemoryConfig().recentTrackMaxMessages).toBe(999)
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('重新加载时解析失败，保留上一次的有效配置，不回退默认值', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify(fullValidConfig()))
    const onMock = vi.fn()
    watchMock.mockReturnValue({ on: onMock })
    const { startConfigWatcher, getMemoryConfig } = await import('./index.js')

    startConfigWatcher()
    expect(getMemoryConfig().recentTrackMaxMessages).toBe(80)

    const changeCallback = onMock.mock.calls.find(call => call[0] === 'change')?.[1]
    readFileSyncMock.mockImplementation(() => { throw new Error('mid-write, temporarily unreadable') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    changeCallback()

    expect(getMemoryConfig().recentTrackMaxMessages).toBe(80)
  })
})

describe('config/index — getModelProviderConfig', () => {
  it('modelProvider 缺失时抛出错误', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ memory: {} }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startConfigWatcher, getModelProviderConfig } = await import('./index.js')

    startConfigWatcher()

    expect(() => getModelProviderConfig()).toThrow()
  })
})

describe('config/index — getBackgroundModelProviderConfig', () => {
  it('配置了 backgroundModelProvider 时返回它自己', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      modelProvider: { type: 'ollama', ollamaBaseUrl: 'http://localhost:11434' },
      backgroundModelProvider: { type: 'anthropic', anthropicApiKey: 'sk-bg', modelName: 'claude-strong' },
    }))
    const { startConfigWatcher, getBackgroundModelProviderConfig } = await import('./index.js')

    startConfigWatcher()

    expect(getBackgroundModelProviderConfig()).toEqual({
      type: 'anthropic',
      anthropicApiKey: 'sk-bg',
      modelName: 'claude-strong',
    })
  })

  it('未配置 backgroundModelProvider 时 fallback 到 getModelProviderConfig()，且不 warn', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      modelProvider: { type: 'ollama', ollamaBaseUrl: 'http://localhost:11434' },
    }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startConfigWatcher, getBackgroundModelProviderConfig, getModelProviderConfig } = await import('./index.js')

    startConfigWatcher()

    expect(getBackgroundModelProviderConfig()).toEqual(getModelProviderConfig())
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('backgroundModelProvider'))
  })

  it('backgroundModelProvider 类型错误（非对象）时同样 fallback，不报错、不 warn', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      modelProvider: { type: 'ollama', ollamaBaseUrl: 'http://localhost:11434' },
      backgroundModelProvider: 'not-an-object',
    }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startConfigWatcher, getBackgroundModelProviderConfig, getModelProviderConfig } = await import('./index.js')

    startConfigWatcher()

    expect(() => getBackgroundModelProviderConfig()).not.toThrow()
    expect(getBackgroundModelProviderConfig()).toEqual(getModelProviderConfig())
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('backgroundModelProvider'))
  })

  it('modelProvider 和 backgroundModelProvider 都缺失时，fallback 链路仍然抛出和 getModelProviderConfig 一样的错误', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ memory: {} }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startConfigWatcher, getBackgroundModelProviderConfig } = await import('./index.js')

    startConfigWatcher()

    expect(() => getBackgroundModelProviderConfig()).toThrow()
  })

  it('热更新场景：先配置了 backgroundModelProvider，后续 config.json 里删掉该字段，重新加载后正确回退到主模型配置，不保留旧实例的值', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      modelProvider: { type: 'ollama', ollamaBaseUrl: 'http://localhost:11434' },
      backgroundModelProvider: { type: 'anthropic', anthropicApiKey: 'sk-bg', modelName: 'claude-strong' },
    }))
    const onMock = vi.fn()
    watchMock.mockReturnValue({ on: onMock })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startConfigWatcher, getBackgroundModelProviderConfig, getModelProviderConfig } = await import('./index.js')

    startConfigWatcher()
    expect(getBackgroundModelProviderConfig()).toEqual({ type: 'anthropic', anthropicApiKey: 'sk-bg', modelName: 'claude-strong' })

    const changeCallback = onMock.mock.calls.find(call => call[0] === 'change')?.[1]
    readFileSyncMock.mockReturnValue(JSON.stringify({
      modelProvider: { type: 'ollama', ollamaBaseUrl: 'http://localhost:11434' },
    }))
    changeCallback()

    expect(getBackgroundModelProviderConfig()).toEqual(getModelProviderConfig())
  })
})
