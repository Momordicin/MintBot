import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { initDb, db } from '../db/index.js'
import { appendMessage, insertSummary, upsertMessageEmbedding, indexMessageFts, insertEntity } from '../session/queries.js'
import { forgetRoutes } from './forget.js'

initDb()

beforeEach(() => {
  db.exec(`
    DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;
    DELETE FROM message_embeddings; DELETE FROM message_fts; DELETE FROM MessageEntities;
  `)
})

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(forgetRoutes)
  return fastify
}

function addMessage(sessionId: string, content: string, createdAt: number): number {
  return appendMessage({
    sessionId, role: 'user', content, createdAt,
    embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
  })
}

// 构造确定性的 1024 维测试向量：仅在指定维度写入值，其余补零
function vec(dim: number, value: number): number[] {
  const v = new Array(1024).fill(0)
  v[dim] = value
  return v
}

describe('POST /forget/check', () => {
  it('sessionId 缺失时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'POST', url: '/forget/check', payload: { fromTime: 1000, toTime: 2000 } })
    expect(response.statusCode).toBe(400)
  })

  it('fromTime/toTime 缺失时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'POST', url: '/forget/check', payload: { sessionId: 's1' } })
    expect(response.statusCode).toBe(400)
  })

  it('fromTime/toTime 不是数字时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({
      method: 'POST', url: '/forget/check',
      payload: { sessionId: 's1', fromTime: 'abc', toTime: 2000 },
    })
    expect(response.statusCode).toBe(400)
  })

  it('fromTime > toTime 时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({
      method: 'POST', url: '/forget/check',
      payload: { sessionId: 's1', fromTime: 2000, toTime: 1000 },
    })
    expect(response.statusCode).toBe(400)
  })

  it('正常路径：返回受影响的消息 id 和摘要', async () => {
    const id1 = addMessage('s1', 'a', 1000)
    const summaryId = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: id1, toMessageId: id1 })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST', url: '/forget/check',
      payload: { sessionId: 's1', fromTime: 1000, toTime: 1000 },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.messageIds).toEqual([id1])
    expect(body.affectedSummaries.map((s: { id: number }) => s.id)).toEqual([summaryId])
  })
})

describe('POST /forget', () => {
  it('sessionId 缺失时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({
      method: 'POST', url: '/forget',
      payload: { fromTime: 1000, toTime: 2000, alsoDeleteAffectedSummaries: false },
    })
    expect(response.statusCode).toBe(400)
  })

  it('fromTime/toTime 缺失时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'POST', url: '/forget', payload: { sessionId: 's1' } })
    expect(response.statusCode).toBe(400)
  })

  it('fromTime/toTime 不是数字时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({
      method: 'POST', url: '/forget',
      payload: { sessionId: 's1', fromTime: 'abc', toTime: 2000, alsoDeleteAffectedSummaries: false },
    })
    expect(response.statusCode).toBe(400)
  })

  it('fromTime > toTime 时返回 400', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({
      method: 'POST', url: '/forget',
      payload: { sessionId: 's1', fromTime: 2000, toTime: 1000, alsoDeleteAffectedSummaries: false },
    })
    expect(response.statusCode).toBe(400)
  })

  it('无摘要重叠时正常删除成功', async () => {
    const id1 = addMessage('s1', 'a', 1000)
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST', url: '/forget',
      payload: { sessionId: 's1', fromTime: 1000, toTime: 1000, alsoDeleteAffectedSummaries: false },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.deletedMessages).toBe(1)

    const row = db.prepare(`SELECT * FROM Messages WHERE id = ?`).get(id1)
    expect(row).toBeUndefined()
  })

  it('有摘要重叠但未传确认标志时返回 409，响应体带上受影响摘要信息，五张表全部不受影响', async () => {
    const id1 = addMessage('s1', 'a', 1000)
    const summaryId = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: id1, toMessageId: id1 })
    upsertMessageEmbedding(id1, 's1', vec(0, 1))
    indexMessageFts(id1, 's1', 'a')
    insertEntity({ messageId: id1, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST', url: '/forget',
      payload: { sessionId: 's1', fromTime: 1000, toTime: 1000, alsoDeleteAffectedSummaries: false },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(409)
    expect(body.messageIds).toEqual([id1])
    expect(body.affectedSummaries.map((s: { id: number }) => s.id)).toEqual([summaryId])

    // 确认五张表都没有产生任何删除
    expect(db.prepare(`SELECT * FROM Messages WHERE id = ?`).get(id1)).not.toBeUndefined()
    expect(db.prepare(`SELECT * FROM Summaries WHERE id = ?`).get(summaryId)).not.toBeUndefined()
    expect(db.prepare(`SELECT * FROM message_embeddings WHERE message_id = ?`).get(id1)).not.toBeUndefined()
    expect(db.prepare(`SELECT * FROM message_fts WHERE message_id = ?`).get(id1)).not.toBeUndefined()
    expect(db.prepare(`SELECT * FROM MessageEntities WHERE messageId = ?`).get(id1)).not.toBeUndefined()
  })

  it('有摘要重叠且传了确认标志时，摘要和消息一起被删', async () => {
    const id1 = addMessage('s1', 'a', 1000)
    const summaryId = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: id1, toMessageId: id1 })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST', url: '/forget',
      payload: { sessionId: 's1', fromTime: 1000, toTime: 1000, alsoDeleteAffectedSummaries: true },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.deletedMessages).toBe(1)
    expect(body.deletedSummaries).toBe(1)

    expect(db.prepare(`SELECT * FROM Messages WHERE id = ?`).get(id1)).toBeUndefined()
    expect(db.prepare(`SELECT * FROM Summaries WHERE id = ?`).get(summaryId)).toBeUndefined()
  })
})
