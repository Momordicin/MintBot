import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { windowBehaviorRoutes } from './windowBehavior.js'

// routes/windowBehavior.ts 只负责路由层的校验 + 广播，实际的读写职责在 config/index.ts——
// mock 掉整个 config 模块和 broadcast 模块，测试聚焦于本文件自己的行为（校验规则、
// 成功路径广播），不依赖真实 config.json，同 routes/config.test.ts 的既有模式。
//
// 两个枚举常量也要一并从 mock 里导出：路由的校验逻辑直接读它们，mock 漏掉会让
// `VALID_*.includes(...)` 在 undefined 上抛错，把本该是 400 的用例变成 500
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
  VALID_CHAT_PIN_MODES: ['always', 'smart', 'off'],
  VALID_APP_RULE_EFFECTS: ['allow', 'soft', 'hard'],
}))

vi.mock('../events/broadcast.js', () => ({
  broadcastEvent: broadcastEventMock,
}))

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(windowBehaviorRoutes)
  return fastify
}

const SAMPLE_CONFIG = {
  chatPinMode: 'smart',
  petAvoidanceEnabled: true,
  appRules: [{ exeName: 'game.exe', effect: 'hard' }],
}

beforeEach(() => {
  getWindowBehaviorConfigMock.mockReset()
  updateWindowBehaviorConfigMock.mockReset()
  broadcastEventMock.mockReset()
})

describe('GET /config/window-behavior', () => {
  it('返回 getWindowBehaviorConfig() 的原样结果', async () => {
    getWindowBehaviorConfigMock.mockReturnValue(SAMPLE_CONFIG)
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/window-behavior' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body).toEqual(SAMPLE_CONFIG)
  })
})

describe('PATCH /config/window-behavior — 校验', () => {
  it('chatPinMode 不是合法枚举值时返回 400，不调用 updateWindowBehaviorConfig', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { chatPinMode: 'not-a-real-mode' },
    })

    expect(response.statusCode).toBe(400)
    expect(updateWindowBehaviorConfigMock).not.toHaveBeenCalled()
    expect(broadcastEventMock).not.toHaveBeenCalled()
  })

  // 旧的 pinMode 三个取值（off / dodge-fullscreen / always-on-top）在新枚举里全部不合法。
  // 'off' 是两套枚举里唯一同名的值，因此不能用它来验证"旧值被拒"——这里挑一个只属于旧枚举的
  it("旧枚举值 'dodge-fullscreen' 不再被接受，返回 400", async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { chatPinMode: 'dodge-fullscreen' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('petAvoidanceEnabled 不是布尔值时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { petAvoidanceEnabled: 'yes' },
    })

    expect(response.statusCode).toBe(400)
    expect(updateWindowBehaviorConfigMock).not.toHaveBeenCalled()
  })

  it('appRules 不是数组时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { appRules: 'chrome.exe' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('appRules 条目缺 exeName / exeName 为空串时返回 400', async () => {
    const fastify = await buildTestApp()

    const missing = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { appRules: [{ effect: 'soft' }] },
    })
    expect(missing.statusCode).toBe(400)

    const empty = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { appRules: [{ exeName: '', effect: 'soft' }] },
    })
    expect(empty.statusCode).toBe(400)

    expect(updateWindowBehaviorConfigMock).not.toHaveBeenCalled()
  })

  it('appRules 条目的 effect 不是合法枚举值时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { appRules: [{ exeName: 'game.exe', effect: 'hide' }] },
    })

    expect(response.statusCode).toBe(400)
    expect(updateWindowBehaviorConfigMock).not.toHaveBeenCalled()
  })

  it('一条非法条目让整个请求被拒，前面的合法条目不会被部分写入', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: {
        appRules: [
          { exeName: 'ok.exe', effect: 'soft' },
          { exeName: 'bad.exe', effect: 'nope' },
        ],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(updateWindowBehaviorConfigMock).not.toHaveBeenCalled()
  })

  it('空的 appRules 数组是合法的——它表示"删光了所有规则"，不是缺字段', async () => {
    updateWindowBehaviorConfigMock.mockReturnValue({ ...SAMPLE_CONFIG, appRules: [] })
    getWindowBehaviorConfigMock.mockReturnValue({ ...SAMPLE_CONFIG, appRules: [] })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { appRules: [] },
    })

    expect(response.statusCode).toBe(200)
    expect(updateWindowBehaviorConfigMock).toHaveBeenCalledWith({ appRules: [] })
  })
})

describe('PATCH /config/window-behavior — 成功路径', () => {
  it('校验通过后调用 updateWindowBehaviorConfig，并广播 window-behavior-changed', async () => {
    updateWindowBehaviorConfigMock.mockReturnValue(SAMPLE_CONFIG)
    getWindowBehaviorConfigMock.mockReturnValue(SAMPLE_CONFIG)
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { chatPinMode: 'smart' },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(updateWindowBehaviorConfigMock).toHaveBeenCalledWith({ chatPinMode: 'smart' })
    expect(body).toEqual(SAMPLE_CONFIG)
    expect(broadcastEventMock).toHaveBeenCalledWith('window-behavior-changed', SAMPLE_CONFIG)
  })

  it('petAvoidanceEnabled: false 是合法值，不被当成"字段缺失"跳过校验后又被丢掉', async () => {
    const disabled = { ...SAMPLE_CONFIG, petAvoidanceEnabled: false }
    updateWindowBehaviorConfigMock.mockReturnValue(disabled)
    getWindowBehaviorConfigMock.mockReturnValue(disabled)
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { petAvoidanceEnabled: false },
    })

    expect(response.statusCode).toBe(200)
    expect(updateWindowBehaviorConfigMock).toHaveBeenCalledWith({ petAvoidanceEnabled: false })
  })

  it('广播时机在 updateWindowBehaviorConfig 之后调用 getWindowBehaviorConfig 取值', async () => {
    updateWindowBehaviorConfigMock.mockReturnValue(SAMPLE_CONFIG)
    getWindowBehaviorConfigMock.mockReturnValue(SAMPLE_CONFIG)
    const fastify = await buildTestApp()

    await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { appRules: [{ exeName: 'game.exe', effect: 'hard' }] },
    })

    const updateOrder = updateWindowBehaviorConfigMock.mock.invocationCallOrder[0]
    const broadcastOrder = broadcastEventMock.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(broadcastOrder)
  })
})
