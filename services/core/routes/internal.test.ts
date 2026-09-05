import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { internalRoutes } from './internal.js'
import { recordSystemEvent, getLockScreenMinutes } from '../system/lockState.js'
import { initDb, db } from '../db/index.js'
import { upsertPreset, upsertEmotionState } from '../session/queries.js'
import { loadSession } from '../session/index.js'

// lock-screen/unlock-screen 不再广播 emotion 事件（TDD §3.3：POST /internal/system-event
// 仅保留锁屏时长计时的职责）。这里只关心 internal.ts 是否触发了 broadcastEvent，不关心
// broadcast.ts 自己的注册表/写入机制
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

  // internal.ts 现在完全不读 session 状态（getCurrentState 分支随 emotion 广播一并删除），
  // 因此"有没有激活 session"对它已无差别——这条与下一条只是从两种前置状态各验一次
  // 「不广播」，不再像此前那样依赖"必须排在所有 loadSession() 调用之前"的执行顺序
  it('没有激活 session 时，lock-screen/unlock-screen 都不广播，也不报错', async () => {
    const fastify = await buildTestApp()

    const lockResponse = await fastify.inject({ method: 'POST', url: '/internal/system-event', payload: { type: 'lock-screen' } })
    const unlockResponse = await fastify.inject({ method: 'POST', url: '/internal/system-event', payload: { type: 'unlock-screen' } })

    expect(lockResponse.statusCode).toBe(200)
    expect(unlockResponse.statusCode).toBe(200)
    expect(broadcastEvent).not.toHaveBeenCalled()
  })

  it('有激活 session 时，lock-screen/unlock-screen 均不产生任何 SSE 广播（立绘不因锁屏切换）', async () => {
    upsertPreset({
      presetId: 'p1', name: '角色一', characterId: 'char-001',
      modelType: 'ollama', modelName: 'qwen3', systemPrompt: '你是角色一',
    })
    const { session } = loadSession('p1')
    upsertEmotionState(session.sessionId, { self: { label: 'happy', intensity: 0.8 }, perceived_user: null })

    const fastify = await buildTestApp()
    await fastify.inject({ method: 'POST', url: '/internal/system-event', payload: { type: 'lock-screen' } })
    await fastify.inject({ method: 'POST', url: '/internal/system-event', payload: { type: 'unlock-screen' } })

    expect(broadcastEvent).not.toHaveBeenCalled()
  })
})
