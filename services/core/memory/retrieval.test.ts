import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db, initDb } from '../db/index.js'
import { appendMessage, insertEntity, indexMessageFts, upsertMessageEmbedding } from '../session/queries.js'
import * as queries from '../session/queries.js'
import { retrieveMemories, shouldTriggerRetrieval } from './retrieval.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'

initDb()

const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
beforeEach(() => {
  // FTS 断言要求本地模式（encryptSensitiveFields=false，本地默认）
  delete process.env.ENCRYPT_SENSITIVE_FIELDS
  db.exec(`
    DELETE FROM Messages; DELETE FROM message_embeddings; DELETE FROM message_fts; DELETE FROM MessageEntities;
  `)
})
afterEach(() => {
  process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
})

function addMessage(sessionId: string, content: string, createdAt = Date.now()): number {
  return appendMessage({
    sessionId, role: 'user', content, createdAt,
    embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
  })
}

// 确定性 1024 维 one-hot 假向量，index 0 与 index 1 分别代表"最相似"与"次相似"两个方向
function fakeEmbeddingProvider(queryVectorIndex = 0): EmbeddingProvider {
  return {
    async embed() {
      const v = new Array(1024).fill(0)
      v[queryVectorIndex] = 1
      return v
    },
    async embedBatch(texts: string[]) {
      return Promise.all(texts.map(() => this.embed('')))
    },
  }
}

function failingEmbeddingProvider(): EmbeddingProvider {
  return {
    async embed() {
      throw new Error('embed boom')
    },
    async embedBatch() {
      throw new Error('embed boom')
    },
  }
}

function oneHotVector(index: number): number[] {
  const v = new Array(1024).fill(0)
  v[index] = 1
  return v
}

describe('shouldTriggerRetrieval', () => {
  it('消息长度 > 50 时触发', () => {
    expect(shouldTriggerRetrieval('a'.repeat(51))).toBe(true)
  })

  it('含疑问句特征词时触发（？/吗/为什么等）', () => {
    expect(shouldTriggerRetrieval('你今天吃了吗？')).toBe(true)
    expect(shouldTriggerRetrieval('为什么会这样')).toBe(true)
  })

  it('含回忆类关键词时触发（记得/之前/上次/你说过）', () => {
    expect(shouldTriggerRetrieval('你还记得吗')).toBe(true) // 同时命中"吗"，但仅验证不误判为 false 即可
    expect(shouldTriggerRetrieval('我们上次聊到哪了')).toBe(true)
  })

  it('短且无特征的陈述句不触发', () => {
    expect(shouldTriggerRetrieval('好的')).toBe(false)
    expect(shouldTriggerRetrieval('今天天气不错')).toBe(false)
  })
})

describe('retrieveMemories — RRF 融合', () => {
  it('三路都命中时按融合分数降序排序：双路命中 > 单路命中(rank1) > 单路命中(rank2)', async () => {
    const sessionId = 's1'
    // msgX：向量 rank1（与查询向量完全相同）+ 实体 rank1
    const msgX = addMessage(sessionId, 'hello world', 1000)
    // msgY：仅 FTS rank1（唯一包含 "kiwi" 的消息）
    const msgY = addMessage(sessionId, 'kiwi fruit is tasty', 2000)
    // msgZ：仅向量 rank2（与查询向量方向不同）
    const msgZ = addMessage(sessionId, 'goodbye', 3000)

    upsertMessageEmbedding(msgX, sessionId, oneHotVector(0))
    upsertMessageEmbedding(msgZ, sessionId, oneHotVector(1))
    indexMessageFts(msgY, sessionId, 'kiwi fruit is tasty')
    insertEntity({ messageId: msgX, sessionId, type: 'other', value: 'kiwi', validFrom: 1000 })

    const results = await retrieveMemories(sessionId, 'kiwi', { embedding: fakeEmbeddingProvider(0) }, 3)

    expect(results.map(m => m.id)).toEqual([msgX, msgY, msgZ])
  })

  it('向量路失败时，FTS 路与实体路仍返回结果', async () => {
    const sessionId = 's1'
    const msgY = addMessage(sessionId, 'kiwi fruit is tasty', 2000)
    const msgEntity = addMessage(sessionId, 'unrelated content', 3000)
    indexMessageFts(msgY, sessionId, 'kiwi fruit is tasty')
    insertEntity({ messageId: msgEntity, sessionId, type: 'other', value: 'kiwi', validFrom: 1000 })

    const results = await retrieveMemories(sessionId, 'kiwi', { embedding: failingEmbeddingProvider() }, 3)

    const ids = results.map(m => m.id)
    expect(ids).toContain(msgY)
    expect(ids).toContain(msgEntity)
  })

  it('三路均无命中时返回空数组', async () => {
    const results = await retrieveMemories('s1', '完全不相关的查询', { embedding: fakeEmbeddingProvider(0) }, 3)
    expect(results).toEqual([])
  })

  it('传入 signal 时会原样转发给 embedding.embed，用于向下取消进行中的向量检索请求', async () => {
    let receivedSignal: AbortSignal | undefined
    const capturingEmbeddingProvider: EmbeddingProvider = {
      embed: async (_text: string, signal?: AbortSignal) => {
        receivedSignal = signal
        return oneHotVector(0)
      },
      embedBatch: async (texts: string[]) => texts.map(() => oneHotVector(0)),
    }
    const controller = new AbortController()

    await retrieveMemories('s1', 'kiwi', { embedding: capturingEmbeddingProvider }, 3, controller.signal)

    expect(receivedSignal).toBe(controller.signal)
  })

  it('融合排序有命中，但按 id 回查消息（getMessagesByIds）失败时返回空数组而不抛出', async () => {
    const sessionId = 's1'
    const msgEntity = addMessage(sessionId, 'unrelated content', 1000)
    insertEntity({ messageId: msgEntity, sessionId, type: 'other', value: 'kiwi', validFrom: 1000 })

    const spy = vi.spyOn(queries, 'getMessagesByIds').mockImplementation(() => {
      throw new Error('db boom')
    })

    try {
      const results = await retrieveMemories(sessionId, 'kiwi', { embedding: fakeEmbeddingProvider(0) }, 3)
      expect(results).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})
