import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { initDb, db } from '../db/index.js'
import { appendMessage } from '../session/queries.js'
import { messageRoutes } from './messages.js'

initDb()

beforeEach(() => {
  db.exec(`
    DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;
    DELETE FROM message_embeddings; DELETE FROM message_fts; DELETE FROM MessageEntities;
    DELETE FROM EmotionStates;
  `)
})

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(messageRoutes)
  return fastify
}

function seedMessages(sessionId: string, count: number): number[] {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    ids.push(appendMessage({
      sessionId, role: 'user', content: `消息${i}`, createdAt: i * 1000,
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    }))
  }
  return ids
}

describe('GET /messages', () => {
  it('sessionId 缺失时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/messages' })
    expect(response.statusCode).toBe(400)
  })

  it('sessionId 为空字符串时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/messages?sessionId=' })
    expect(response.statusCode).toBe(400)
  })

  it('beforeId 非法值时返回 400', async () => {
    seedMessages('s1', 3)
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/messages?sessionId=s1&beforeId=abc' })
    expect(response.statusCode).toBe(400)
  })

  it('正常分页：返回最近 limit 条，hasMore 为 true', async () => {
    seedMessages('s1', 5)
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/messages?sessionId=s1&limit=3' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(['消息2', '消息3', '消息4'])
    expect(body.hasMore).toBe(true)
  })

  it('用 beforeId 翻到最早一页时 hasMore 变为 false', async () => {
    const ids = seedMessages('s1', 5)
    const fastify = await buildTestApp()
    const response = await fastify.inject({
      method: 'GET',
      url: `/messages?sessionId=s1&limit=3&beforeId=${ids[2]}`,
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(['消息0', '消息1'])
    expect(body.hasMore).toBe(false)
  })

  it('跨 session 隔离，不返回其它 session 的消息', async () => {
    seedMessages('s1', 3)
    seedMessages('s2', 3)
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/messages?sessionId=s1&limit=10' })
    const body = JSON.parse(response.payload)

    expect(body.messages).toHaveLength(3)
    expect(body.messages.every((m: { sessionId: string }) => m.sessionId === 's1')).toBe(true)
  })

  it('limit 超出范围时被裁剪而不是报错', async () => {
    seedMessages('s1', 3)
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/messages?sessionId=s1&limit=99999' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.messages).toHaveLength(3)
  })

  it('limit 为空字符串时按未传处理，使用默认值而不是 0', async () => {
    seedMessages('s1', 3)
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/messages?sessionId=s1&limit=' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.messages).toHaveLength(3)
  })

  it('beforeId 为空字符串时按未传处理，返回最新一页而不是空游标', async () => {
    seedMessages('s1', 3)
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/messages?sessionId=s1&beforeId=' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(['消息0', '消息1', '消息2'])
  })

  it('beforeId 为非整数时返回 400', async () => {
    seedMessages('s1', 3)
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/messages?sessionId=s1&beforeId=1.5' })
    expect(response.statusCode).toBe(400)
  })
})
