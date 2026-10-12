import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { windowBehaviorRoutes } from './windowBehavior.js'
import { ConfigFileUnreadableError, CONFIG_FILE_UNREADABLE_MESSAGE } from '../config/configFileError.js'

// mock 掉 config 与 broadcast 模块，只测路由本身；校验逻辑会读 VALID_* 常量，mock 里必须一并导出
const {
  getWindowBehaviorConfigMock,
  getWindowBehaviorRevisionMock,
  updateWindowBehaviorConfigMock,
  broadcastEventMock,
} = vi.hoisted(() => ({
  getWindowBehaviorConfigMock: vi.fn(),
  getWindowBehaviorRevisionMock: vi.fn(),
  updateWindowBehaviorConfigMock: vi.fn(),
  broadcastEventMock: vi.fn(),
}))

vi.mock('../config/index.js', () => ({
  getWindowBehaviorConfig: getWindowBehaviorConfigMock,
  getWindowBehaviorRevision: getWindowBehaviorRevisionMock,
  updateWindowBehaviorConfig: updateWindowBehaviorConfigMock,
  VALID_CHAT_PIN_MODES: ['always', 'smart', 'off'],
  VALID_APP_RULE_EFFECTS: ['allow', 'soft', 'hard'],
}))

vi.mock('../events/broadcast.js', () => ({
  broadcastEvent: broadcastEventMock,
  SERVER_GENERATION: 'test-generation',
}))

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(windowBehaviorRoutes)
  return fastify
}

const SAMPLE_CONFIG = {
  chatPinMode: 'smart',
  petAvoidanceEnabled: true,
  petClickThrough: false,
  petCollapsed: false,
  appRules: [{ exeName: 'game.exe', effect: 'hard' }],
}

let revision = 1

function snapshotOf(config: unknown, atRevision: number) {
  return { generation: 'test-generation', revision: atRevision, config }
}

beforeEach(() => {
  revision = 1
  getWindowBehaviorRevisionMock.mockReset()
  getWindowBehaviorRevisionMock.mockImplementation(() => revision)
  getWindowBehaviorConfigMock.mockReset()
  updateWindowBehaviorConfigMock.mockReset()
  broadcastEventMock.mockReset()
})

describe('GET /config/window-behavior', () => {
  it('返回携带 generation 与 revision 的快照', async () => {
    getWindowBehaviorConfigMock.mockReturnValue(SAMPLE_CONFIG)
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/window-behavior' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body).toEqual(snapshotOf(SAMPLE_CONFIG, 1))
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

  // 'off' 新旧枚举都有，所以用只属于旧枚举的值
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

  it.each(['petClickThrough', 'petCollapsed'])('%s 不是布尔值时返回 400', async field => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { [field]: 'yes' },
    })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toContain(field)
    expect(updateWindowBehaviorConfigMock).not.toHaveBeenCalled()
  })

  it.each(['petClickThrough', 'petCollapsed'])('%s: true 是合法值，原样传给配置层', async field => {
    const enabled = { ...SAMPLE_CONFIG, [field]: true }
    updateWindowBehaviorConfigMock.mockReturnValue(enabled)
    getWindowBehaviorConfigMock.mockReturnValue(enabled)
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { [field]: true },
    })

    expect(response.statusCode).toBe(200)
    expect(updateWindowBehaviorConfigMock).toHaveBeenCalledWith({ [field]: true })
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
  it('内容变化时调用 updateWindowBehaviorConfig，并广播 window-behavior-changed 快照', async () => {
    updateWindowBehaviorConfigMock.mockImplementation(() => {
      revision = 2
      return SAMPLE_CONFIG
    })
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
    expect(body).toEqual(snapshotOf(SAMPLE_CONFIG, 2))
    expect(broadcastEventMock).toHaveBeenCalledTimes(1)
    expect(broadcastEventMock).toHaveBeenCalledWith('window-behavior-changed', snapshotOf(SAMPLE_CONFIG, 2))
  })

  it('内容未变化时不广播，响应仍是当前快照', async () => {
    updateWindowBehaviorConfigMock.mockReturnValue(SAMPLE_CONFIG)
    getWindowBehaviorConfigMock.mockReturnValue(SAMPLE_CONFIG)
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { chatPinMode: 'smart' },
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual(snapshotOf(SAMPLE_CONFIG, 1))
    expect(broadcastEventMock).not.toHaveBeenCalled()
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

  it('广播发生在 updateWindowBehaviorConfig 之后', async () => {
    updateWindowBehaviorConfigMock.mockImplementation(() => {
      revision = 2
      return SAMPLE_CONFIG
    })
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

describe('PATCH /config/window-behavior — config.json 无法读取', () => {
  it('写入抛出 ConfigFileUnreadableError 时返回 500，error 为中文提示，不广播', async () => {
    updateWindowBehaviorConfigMock.mockImplementation(() => {
      throw new ConfigFileUnreadableError('Unexpected token')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { petAvoidanceEnabled: false },
    })
    errorSpy.mockRestore()

    expect(response.statusCode).toBe(500)
    expect(JSON.parse(response.payload)).toEqual({ error: CONFIG_FILE_UNREADABLE_MESSAGE })
    expect(broadcastEventMock).not.toHaveBeenCalled()
  })

  it('其他错误照常向外抛出，不使用 config.json 的提示文字', async () => {
    updateWindowBehaviorConfigMock.mockImplementation(() => {
      throw new Error('unexpected')
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/window-behavior',
      payload: { petAvoidanceEnabled: false },
    })

    expect(response.statusCode).toBe(500)
    expect(JSON.parse(response.payload).error).not.toBe(CONFIG_FILE_UNREADABLE_MESSAGE)
  })
})
