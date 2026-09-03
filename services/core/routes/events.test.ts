import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { eventsRoutes } from './events.js'
import { broadcastEvent } from '../events/broadcast.js'

// GET /events 是一条不会主动结束的长连接：fastify.inject() 的返回 promise 只有在响应
// end() 之后才 resolve，这里跟 chat.test.ts 里"模拟客户端断连"的测试用同一手法——用
// onRequest 钩子拿到 handler 内部同一个 reply 引用，不等 inject() 本身 settle，
// 测试收尾时手动 emit('close') 让它以"客户端断开"的方式了结，避免遗留悬挂的 promise
async function connect(fastify: FastifyInstance) {
  let capturedReply: FastifyReply | undefined
  let onRequestDone: () => void
  const onRequestPromise = new Promise<void>(resolve => { onRequestDone = resolve })
  fastify.addHook('onRequest', (_request, reply, done) => {
    capturedReply = reply
    onRequestDone()
    done()
  })

  const injectPromise = fastify.inject({ method: 'GET', url: '/events' })
  injectPromise.catch(() => {})

  await onRequestPromise
  // 等 handler 本身跑完 setHeader/flushHeaders/registerEventsClient（onRequest 钩子先于
  // 路由 handler 执行）
  await new Promise(resolve => setImmediate(resolve))

  return { reply: capturedReply!, injectPromise }
}

describe('GET /events', () => {
  it('设置与 chat.ts 一致的 SSE 响应头', async () => {
    const fastify = Fastify()
    await fastify.register(eventsRoutes)

    const { reply, injectPromise } = await connect(fastify)

    expect(reply.raw.getHeader('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(reply.raw.getHeader('Content-Type')).toBe('text/event-stream')
    expect(reply.raw.getHeader('Cache-Control')).toBe('no-cache')
    expect(reply.raw.getHeader('Connection')).toBe('keep-alive')

    reply.raw.emit('close')
    await injectPromise.catch(() => {})
  })

  it('连接建立后注册为广播客户端：broadcastEvent 触发的写入会到达这条连接', async () => {
    const fastify = Fastify()
    await fastify.register(eventsRoutes)

    const { reply, injectPromise } = await connect(fastify)
    const writeSpy = vi.spyOn(reply.raw, 'write')

    broadcastEvent('emotion', { self: { label: 'happy', intensity: 0.5 }, perceived_user: null })

    expect(writeSpy).toHaveBeenCalledWith(
      `event: emotion\ndata: ${JSON.stringify({ self: { label: 'happy', intensity: 0.5 }, perceived_user: null })}\n\n`,
    )

    reply.raw.emit('close')
    await injectPromise.catch(() => {})
  })

  it('客户端断开（close）后从广播注册表移除，不再收到后续广播', async () => {
    const fastify = Fastify()
    await fastify.register(eventsRoutes)

    const { reply, injectPromise } = await connect(fastify)
    const writeSpy = vi.spyOn(reply.raw, 'write')

    reply.raw.emit('close')
    await injectPromise.catch(() => {})

    broadcastEvent('emotion', { self: null, perceived_user: null })
    expect(writeSpy).not.toHaveBeenCalled()
  })
})
