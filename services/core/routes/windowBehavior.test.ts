import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { windowBehaviorRoutes } from './windowBehavior.js'

// routes/windowBehavior.ts 只负责路由层的校验 + 广播，实际的读写职责在 config/index.ts——
// mock 掉整个 config 模块和 broadcast 模块，测试聚焦于本文件自己的行为（校验规则、
// 成功路径广播），不依赖真实 config.json，同 routes/config.test.ts 的既有模式
const {
  getWindowBehaviorConfigMock,
  updateWindowBehaviorConfigMock,
  broadcastEventMock,
} = vi.hoisted(() => ({
  getWindowBehaviorConfigMock: vi.fn(),
  updateWindowBehaviorConfigMock: vi.fn(),
  broadcastEventMock: vi.fn(),
}))

vi.mock('../config/index.js', () => ({
  getWindowBehaviorConfig: getWindowBehaviorConfigMock,
  updateWindowBehaviorConfig: updateWindowBehaviorConfigMock,
}))

vi.mock('../events/broadcast.js', () => ({
  broadcastEvent: broadcastEventMock,
}))

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(windowBehaviorRoutes)
  return fastify
}

beforeEach(() => {
  getWindowBehaviorConfigMock.mockReset()
  updateWindowBehaviorConfigMock.mockReset()
  broadcastEventMock.mockReset()
})

describe('GET /config/window-behavior', () => {
  it('返回 getWindowBehaviorConfig() 的原样结果', async () => {
    getWindowBehaviorConfigMock.mockReturnValue({ pinMode: 'off', fullscreenWhitelist: [], blacklist: [] })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/window-behavior' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body).toEqual({ pinMode: 'off', fullscreenWhitelist: [], blacklist: [] })
  })
})

describe('PATCH /config/window-behavior — 校验', () => {
  it('pinMode 不是合法枚举值时返回 400，不调用 updateWindowBehaviorConfig', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { pinMode: 'not-a-real-mode' },
    })

    expect(response.statusCode).toBe(400)
    expect(updateWindowBehaviorConfigMock).not.toHaveBeenCalled()
    expect(broadcastEventMock).not.toHaveBeenCalled()
  })

  it('fullscreenWhitelist 含非字符串元素时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { fullscreenWhitelist: ['chrome.exe', 123] },
    })

    expect(response.statusCode).toBe(400)
    expect(updateWindowBehaviorConfigMock).not.toHaveBeenCalled()
  })

  it('fullscreenWhitelist 不是数组时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { fullscreenWhitelist: 'chrome.exe' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('blacklist 含非字符串元素时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { blacklist: [null] },
    })

    expect(response.statusCode).toBe(400)
    expect(updateWindowBehaviorConfigMock).not.toHaveBeenCalled()
  })
})

describe('PATCH /config/window-behavior — 成功路径', () => {
  it('校验通过后调用 updateWindowBehaviorConfig，并广播 window-behavior-changed', async () => {
    updateWindowBehaviorConfigMock.mockReturnValue({ pinMode: 'dodge-fullscreen', fullscreenWhitelist: [], blacklist: [] })
    getWindowBehaviorConfigMock.mockReturnValue({ pinMode: 'dodge-fullscreen', fullscreenWhitelist: [], blacklist: [] })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { pinMode: 'dodge-fullscreen' },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(updateWindowBehaviorConfigMock).toHaveBeenCalledWith({ pinMode: 'dodge-fullscreen' })
    expect(body).toEqual({ pinMode: 'dodge-fullscreen', fullscreenWhitelist: [], blacklist: [] })
    expect(broadcastEventMock).toHaveBeenCalledWith('window-behavior-changed', { pinMode: 'dodge-fullscreen', fullscreenWhitelist: [], blacklist: [] })
  })

  it('广播时机在 updateWindowBehaviorConfig 之后调用 getWindowBehaviorConfig 取值', async () => {
    updateWindowBehaviorConfigMock.mockReturnValue({ pinMode: 'off', fullscreenWhitelist: ['chrome.exe'], blacklist: [] })
    getWindowBehaviorConfigMock.mockReturnValue({ pinMode: 'off', fullscreenWhitelist: ['chrome.exe'], blacklist: [] })
    const fastify = await buildTestApp()

    await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { fullscreenWhitelist: ['chrome.exe'] },
    })

    const updateOrder = updateWindowBehaviorConfigMock.mock.invocationCallOrder[0]
    const broadcastOrder = broadcastEventMock.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(broadcastOrder)
  })
})
