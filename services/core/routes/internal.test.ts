import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { internalRoutes } from './internal.js'
import { recordSystemEvent, getLockScreenMinutes } from '../system/lockState.js'
import { initDb, db } from '../db/index.js'
import { upsertPreset, upsertEmotionState } from '../session/queries.js'
import { loadSession } from '../session/index.js'

// lock-screen/unlock-screen 广播 emotion 事件（悬浮窗静息模式，Phase 3 收尾）：跟
// chat.test.ts 同款 partial mock，只关心 internal.ts 是否调用了 broadcastEvent、
// payload 是否正确，不关心 broadcast.ts 自己的注册表/写入机制
vi.mock('../events/broadcast.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../events/broadcast.js')>()
  return { ...actual, broadcastEvent: vi.fn() }
})

import { broadcastEvent } from '../events/broadcast.js'

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(internalRoutes)
  return fastify
}

initDb()

beforeEach(() => {
  db.exec(`
    DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets;
    DELETE FROM EmotionStates;
  `)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /internal/system-event', () => {
  it('type=lock-screen 合法调用后 getLockScreenMinutes 状态确实改变', async () => {
    recordSystemEvent('unlock-screen')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/internal/system-event',
      payload: { type: 'lock-screen' },
    })

    expect(response.statusCode).toBe(200)
    expect(getLockScreenMinutes(Date.now() + 10 * 60_000)).toBeCloseTo(10, 1)
  })

  it('type=unlock-screen 合法调用后 getLockScreenMinutes 回到 0', async () => {
    recordSystemEvent('lock-screen', Date.now() - 60_000)
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/internal/system-event',
      payload: { type: 'unlock-screen' },
    })

    expect(response.statusCode).toBe(200)
    expect(getLockScreenMinutes()).toBe(0)
  })

  it('非法 type 返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/internal/system-event',
      payload: { type: 'foo' },
    })

    expect(response.statusCode).toBe(400)
  })

  // 注意顺序：session/index.ts 的 current 是模块级单例，一旦某个测试调用过 loadSession()
  // 就不会在测试之间自动重置——这条"没有激活 session"必须排在本文件所有 loadSession() 调用
  // 之前，才能真正验证到 getCurrentState() 返回 null 的分支
  it('没有激活 session 时，lock-screen/unlock-screen 都不广播，也不报错', async () => {
    const fastify = await buildTestApp()

    const lockResponse = await fastify.inject({ method: 'POST', url: '/internal/system-event', payload: { type: 'lock-screen' } })
    const unlockResponse = await fastify.inject({ method: 'POST', url: '/internal/system-event', payload: { type: 'unlock-screen' } })

    expect(lockResponse.statusCode).toBe(200)
    expect(unlockResponse.statusCode).toBe(200)
    expect(broadcastEvent).not.toHaveBeenCalled()
  })

  it('有激活 session 时，lock-screen 广播 sleep 情绪且不落库', async () => {
    upsertPreset({
      presetId: 'p1', name: '角色一', characterId: 'char-001',
      modelType: 'ollama', modelName: 'qwen3', systemPrompt: '你是角色一',
    })
    const { session } = loadSession('p1')
    upsertEmotionState(session.sessionId, { self: { label: 'happy', intensity: 0.8 }, perceived_user: null })

    const fastify = await buildTestApp()
    await fastify.inject({ method: 'POST', url: '/internal/system-event', payload: { type: 'lock-screen' } })

    expect(broadcastEvent).toHaveBeenCalledWith('emotion', { self: { label: 'sleep', intensity: 1 }, perceived_user: null })

    // 广播是 sleep，但持久化的情绪状态必须还是锁屏前的真实值——lock-screen 不应该调用
    // upsertEmotionState 覆盖它
    const { getEmotionState } = await import('../session/queries.js')
    expect(getEmotionState(session.sessionId)).toEqual({ self: { label: 'happy', intensity: 0.8 }, perceived_user: null })
  })

  it('有激活 session 时，unlock-screen 广播锁屏前持久化的真实情绪', async () => {
    upsertPreset({
      presetId: 'p1', name: '角色一', characterId: 'char-001',
      modelType: 'ollama', modelName: 'qwen3', systemPrompt: '你是角色一',
    })
    const { session } = loadSession('p1')
    upsertEmotionState(session.sessionId, { self: { label: 'shy', intensity: 0.5 }, perceived_user: null })

    const fastify = await buildTestApp()
    await fastify.inject({ method: 'POST', url: '/internal/system-event', payload: { type: 'unlock-screen' } })

    expect(broadcastEvent).toHaveBeenCalledWith('emotion', { self: { label: 'shy', intensity: 0.5 }, perceived_user: null })
  })

  it('有激活 session 但从未记录过情绪时，unlock-screen 广播 self: null（渲染层走 fallback）', async () => {
    upsertPreset({
      presetId: 'p1', name: '角色一', characterId: 'char-001',
      modelType: 'ollama', modelName: 'qwen3', systemPrompt: '你是角色一',
    })
    loadSession('p1')

    const fastify = await buildTestApp()
    await fastify.inject({ method: 'POST', url: '/internal/system-event', payload: { type: 'unlock-screen' } })

    expect(broadcastEvent).toHaveBeenCalledWith('emotion', { self: null, perceived_user: null })
  })
})
