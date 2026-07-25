import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { internalRoutes } from './internal.js'
import { recordSystemEvent, getLockScreenMinutes } from '../system/lockState.js'

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(internalRoutes)
  return fastify
}

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
})
