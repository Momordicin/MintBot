import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { eventsRoutes } from './events.js'
import { broadcastEvent, SERVER_GENERATION } from '../events/broadcast.js'
import fastifyCors from '@fastify/cors'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { RENDERER_ORIGIN, RENDERER_ORIGINS } from '../config/ports.js'

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

// SSE 长连接不会结束，inject() 会一直挂起：这里真实 listen 在临时端口上，用 http.request 读到响应头后
// 立即销毁 socket 并关闭服务。注册与 index.ts 相同的 @fastify/cors 配置，验证 CORS 头只由插件决定
async function buildCorsApp() {
  const fastify = Fastify()
  await fastify.register(fastifyCors, {
    origin: [...RENDERER_ORIGINS],
    methods: ['GET', 'HEAD', 'POST', 'PATCH'],
  })
  await fastify.register(eventsRoutes)
  return fastify
}

async function openEventStream(fastify: FastifyInstance, origin: string) {
  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const { port } = fastify.server.address() as AddressInfo
  try {
    return await new Promise<{ headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/events', headers: { Origin: origin } }, res => {
        resolve({ headers: res.headers })
        res.destroy()
      })
      req.on('error', reject)
      req.end()
    })
  } finally {
    fastify.server.closeAllConnections()
    await fastify.close()
  }
}

describe('GET /events', () => {
  it('SSE 响应头：Content-Type/Cache-Control/Connection 正确，CORS 头由 @fastify/cors 插件唯一决定', async () => {
    const fastify = await buildCorsApp()
    const { headers } = await openEventStream(fastify, RENDERER_ORIGIN)

    expect(headers['content-type']).toBe('text/event-stream')
    expect(headers['cache-control']).toBe('no-cache')
    expect(headers['connection']).toBe('keep-alive')
  })

  it.each(RENDERER_ORIGINS)('允许的 origin %s：Access-Control-Allow-Origin 回显自身，Vary 含 Origin', async origin => {
    const fastify = await buildCorsApp()
    const { headers } = await openEventStream(fastify, origin)

    expect(headers['access-control-allow-origin']).toBe(origin)
    expect(String(headers['vary'])).toMatch(/Origin/i)
  })

  it('不在白名单内的 origin：响应不带 Access-Control-Allow-Origin', async () => {
    const fastify = await buildCorsApp()
    const { headers } = await openEventStream(fastify, 'http://evil.example')

    expect(headers['access-control-allow-origin']).toBeUndefined()
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

  it('连接建立后立即发送 hello 帧，携带服务器代次（TDD §3.3「hello / heartbeat」）', async () => {
    const fastify = Fastify()
    await fastify.register(eventsRoutes)

    // 不能复用上面的 connect() 辅助函数：它在 handler 跑完之后才 spyOn(reply.raw, 'write')，
    // 而 hello 帧正是在 handler 内部、registerEventsClient 之后立即写出的，必须在 onRequest
    // 钩子里、handler 还没跑之前就把 spy 挂上去，否则这次写入根本不会被这个 spy 看到
    let capturedReply: FastifyReply | undefined
    let writeSpy: ReturnType<typeof vi.spyOn> | undefined
    const onRequestPromise = new Promise<void>(resolve => {
      fastify.addHook('onRequest', (_request, reply, done) => {
        capturedReply = reply
        writeSpy = vi.spyOn(reply.raw, 'write')
        resolve()
        done()
      })
    })

    const injectPromise = fastify.inject({ method: 'GET', url: '/events' })
    injectPromise.catch(() => {})

    await onRequestPromise
    await new Promise(resolve => setImmediate(resolve))

    expect(writeSpy).toHaveBeenCalledWith(
      `event: hello\ndata: ${JSON.stringify({ generation: SERVER_GENERATION })}\n\n`,
    )

    capturedReply!.raw.emit('close')
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
