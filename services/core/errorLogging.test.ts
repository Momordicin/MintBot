import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Writable } from 'stream'
import { logServerErrors } from './errorLogging.js'

type LogLine = { level: number; msg?: string; method?: string; url?: string; err?: { message?: string } }

function buildApp(withHandler: boolean) {
  const lines: LogLine[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const text of chunk.toString().split('\n')) {
        if (text.trim()) lines.push(JSON.parse(text))
      }
      cb()
    },
  })
  const fastify = Fastify({ logger: { level: 'info', stream }, disableRequestLogging: true })
  if (withHandler) logServerErrors(fastify)
  return { fastify, errorLogs: () => lines.filter(l => l.level >= 50) }
}

function addRoutes(fastify: FastifyInstance) {
  fastify.get('/boom', async () => {
    throw new Error('boom message')
  })
  fastify.get('/unavailable', async () => {
    throw Object.assign(new Error('unavailable message'), { statusCode: 503 })
  })
  fastify.get('/bad', async () => {
    throw Object.assign(new Error('bad message'), { statusCode: 400 })
  })
  fastify.get('/coded-then-unavailable', async (_request, reply) => {
    reply.code(404)
    throw Object.assign(new Error('coded unavailable message'), { statusCode: 503 })
  })
  fastify.get('/ok-coded-then-mixed', async (_request, reply) => {
    reply.code(200)
    throw Object.assign(new Error('mixed status message'), { status: 503, statusCode: 400 })
  })
  fastify.post('/validated', { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } }, async () => ({ ok: true }))
  fastify.register(async child => {
    child.get('/child-boom', async () => {
      throw new Error('child boom message')
    })
  })
}

describe('logServerErrors', () => {
  it('普通 Error 返回 500，响应与未安装处理器时一致，并记录一条含 method/url/message 的 error 日志', async () => {
    const withHandler = buildApp(true)
    const without = buildApp(false)
    addRoutes(withHandler.fastify)
    addRoutes(without.fastify)

    const a = await withHandler.fastify.inject({ method: 'GET', url: '/boom' })
    const b = await without.fastify.inject({ method: 'GET', url: '/boom' })

    expect(a.statusCode).toBe(500)
    expect(a.body).toBe(b.body)
    const { date: _dateA, ...headersA } = a.headers
    const { date: _dateB, ...headersB } = b.headers
    expect(headersA).toEqual(headersB)
    expect(without.errorLogs()).toHaveLength(0)
    const logs = withHandler.errorLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0].method).toBe('GET')
    expect(logs[0].url).toBe('/boom')
    expect(logs[0].err?.message).toBe('boom message')
  })

  it('带 statusCode 503 的错误返回 503 并记录', async () => {
    const { fastify, errorLogs } = buildApp(true)
    addRoutes(fastify)

    const res = await fastify.inject({ method: 'GET', url: '/unavailable' })

    expect(res.statusCode).toBe(503)
    expect(errorLogs()).toHaveLength(1)
    expect(errorLogs()[0].err?.message).toBe('unavailable message')
  })

  it('先设 404 再抛带 statusCode 503 的错误：返回 503 与未安装处理器时一致，并记录', async () => {
    const withHandler = buildApp(true)
    const without = buildApp(false)
    addRoutes(withHandler.fastify)
    addRoutes(without.fastify)

    const a = await withHandler.fastify.inject({ method: 'GET', url: '/coded-then-unavailable' })
    const b = await without.fastify.inject({ method: 'GET', url: '/coded-then-unavailable' })

    expect(b.statusCode).toBe(503)
    expect(a.statusCode).toBe(503)
    expect(a.body).toBe(b.body)
    expect(withHandler.errorLogs()).toHaveLength(1)
    expect(withHandler.errorLogs()[0].err?.message).toBe('coded unavailable message')
  })

  it('先设 200 再抛同时带 status 503 与 statusCode 400 的错误：按实际返回的 503 记录', async () => {
    const withHandler = buildApp(true)
    const without = buildApp(false)
    addRoutes(withHandler.fastify)
    addRoutes(without.fastify)

    const a = await withHandler.fastify.inject({ method: 'GET', url: '/ok-coded-then-mixed' })
    const b = await without.fastify.inject({ method: 'GET', url: '/ok-coded-then-mixed' })

    expect(b.statusCode).toBe(503)
    expect(a.statusCode).toBe(503)
    expect(a.body).toBe(b.body)
    expect(withHandler.errorLogs()).toHaveLength(1)
    expect(withHandler.errorLogs()[0].err?.message).toBe('mixed status message')
  })

  it('带 statusCode 400 的错误与 body schema 校验 400 的响应不变且不记录 error 日志', async () => {
    const withHandler = buildApp(true)
    const without = buildApp(false)
    addRoutes(withHandler.fastify)
    addRoutes(without.fastify)

    const badA = await withHandler.fastify.inject({ method: 'GET', url: '/bad' })
    const badB = await without.fastify.inject({ method: 'GET', url: '/bad' })
    const valA = await withHandler.fastify.inject({ method: 'POST', url: '/validated', payload: {} })
    const valB = await without.fastify.inject({ method: 'POST', url: '/validated', payload: {} })

    expect(badA.statusCode).toBe(400)
    expect(badA.body).toBe(badB.body)
    expect(valA.statusCode).toBe(400)
    expect(valA.body).toBe(valB.body)
    expect(withHandler.errorLogs()).toHaveLength(0)
  })

  it('通过 register 注册的子插件内抛错的路由同样被记录', async () => {
    const { fastify, errorLogs } = buildApp(true)
    addRoutes(fastify)

    const res = await fastify.inject({ method: 'GET', url: '/child-boom' })

    expect(res.statusCode).toBe(500)
    expect(errorLogs()).toHaveLength(1)
    expect(errorLogs()[0].err?.message).toBe('child boom message')
  })
})
