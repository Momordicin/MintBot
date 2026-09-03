import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { initDb, db } from '../db/index.js'
import { appendMessage, insertEntity, insertSummary } from '../session/queries.js'
import { memoryRoutes } from './memory.js'

// GET /embedding-queue-status 读取当前激活 session 来附带 activePreset* 字段——mock 成受控的
// vi.fn()，每个用例自己设置返回值（默认 null，代表"无激活 session"）
const { getCurrentStateMock } = vi.hoisted(() => ({ getCurrentStateMock: vi.fn(() => null as { session: { sessionId: string } } | null) }))
vi.mock('../session/index.js', () => ({ getCurrentState: getCurrentStateMock }))

initDb()

beforeEach(() => {
  db.exec(`
    DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;
    DELETE FROM message_embeddings; DELETE FROM message_fts; DELETE FROM MessageEntities;
    DELETE FROM EmotionStates;
  `)
  getCurrentStateMock.mockReset()
  getCurrentStateMock.mockReturnValue(null)
})

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(memoryRoutes)
  return fastify
}

describe('GET /entities', () => {
  it('sessionId 缺失时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/entities' })
    expect(response.statusCode).toBe(400)
  })

  it('type 不在合法枚举内时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/entities?sessionId=s1&type=invalid' })
    expect(response.statusCode).toBe(400)
  })

  it('正常请求按 type 过滤并分页，返回最近 limit 条', async () => {
    insertEntity({ messageId: 1, sessionId: 's1', type: 'preference', value: '偏好0', validFrom: 1000 })
    insertEntity({ messageId: 2, sessionId: 's1', type: 'preference', value: '偏好1', validFrom: 1000 })
    insertEntity({ messageId: 3, sessionId: 's1', type: 'person', value: '人物0', validFrom: 1000 })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/entities?sessionId=s1&type=preference&limit=1' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.entities.map((e: { value: string }) => e.value)).toEqual(['偏好1'])
    expect(body.hasMore).toBe(true)
  })

  it('beforeId 翻到最早一页时 hasMore 为 false', async () => {
    const ids = [
      insertEntity({ messageId: 1, sessionId: 's1', type: 'preference', value: '偏好0', validFrom: 1000 }),
      insertEntity({ messageId: 2, sessionId: 's1', type: 'preference', value: '偏好1', validFrom: 1000 }),
      insertEntity({ messageId: 3, sessionId: 's1', type: 'preference', value: '偏好2', validFrom: 1000 }),
    ]
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'GET',
      url: `/entities?sessionId=s1&limit=2&beforeId=${ids[2]}`,
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.entities.map((e: { value: string }) => e.value)).toEqual(['偏好0', '偏好1'])
    expect(body.hasMore).toBe(false)
  })
})

describe('GET /summaries', () => {
  it('sessionId 缺失时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/summaries' })
    expect(response.statusCode).toBe(400)
  })

  it('正常请求返回该 session 的摘要列表', async () => {
    insertSummary({ sessionId: 's1', content: '摘要内容', fromMessageId: 1, toMessageId: 2 })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/summaries?sessionId=s1' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0].content).toBe('摘要内容')
  })
})

describe('GET /embedding-queue-status', () => {
  it('返回全局 pending 统计，不需要 sessionId', async () => {
    appendMessage({
      sessionId: 's1', role: 'user', content: '待处理消息', createdAt: Date.now(),
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/embedding-queue-status' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.pendingCount).toBe(1)
    expect(typeof body.oldestPendingAge).toBe('number')
    expect(typeof body.activeConversation).toBe('boolean')
  })

  it('无激活 session 时，三个 activePreset* 字段为 null', async () => {
    getCurrentStateMock.mockReturnValue(null)
    appendMessage({
      sessionId: 's1', role: 'user', content: '待处理消息', createdAt: Date.now(),
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/embedding-queue-status' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.activePresetPendingCount).toBeNull()
    expect(body.activePresetOldestPendingAge).toBeNull()
    expect(body.pendingAheadOfActivePreset).toBeNull()
  })

  it('有激活 session 时，返回当前角色自己的待处理数与排在它前面的全局数量', async () => {
    getCurrentStateMock.mockReturnValue({ session: { sessionId: 's1' } })
    // s2 的消息更早（排在 s1 前面），s1 自己有 1 条待处理消息
    appendMessage({
      sessionId: 's2', role: 'user', content: '更早的待处理消息', createdAt: 1000,
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    appendMessage({
      sessionId: 's1', role: 'user', content: '当前角色的待处理消息', createdAt: 2000,
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/embedding-queue-status' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.activePresetPendingCount).toBe(1)
    expect(typeof body.activePresetOldestPendingAge).toBe('number')
    expect(body.pendingAheadOfActivePreset).toBe(1)
  })
})
