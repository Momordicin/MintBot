import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db, initDb } from '../db/index.js'
import { appendMessage, getPendingEmbeddingCount, searchSimilarMessages, searchMessagesFts } from '../session/queries.js'
import { processEmbedQueue } from './embedQueue.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'

initDb()

const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
beforeEach(() => {
  // FTS 断言要求本地模式（encryptSensitiveFields=false，本地默认）
  delete process.env.ENCRYPT_SENSITIVE_FIELDS
  db.exec(`
    DELETE FROM Messages; DELETE FROM message_embeddings; DELETE FROM message_fts;
  `)
})
afterEach(() => {
  process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
})

// 确定性 BGE-M3 维度（1024）假向量：按输入顺序、每条向量在 index 维度写入固定值，方便断言召回
function fakeProvider(): EmbeddingProvider {
  return {
    async embed(text: string) {
      const [v] = await this.embedBatch([text])
      return v
    },
    async embedBatch(texts: string[]) {
      return texts.map((_, i) => {
        const v = new Array(1024).fill(0)
        v[i] = 1
        return v
      })
    },
    async unload() { return true },
  }
}

function failingProvider(): EmbeddingProvider {
  return {
    async embed() {
      throw new Error('boom')
    },
    async embedBatch() {
      throw new Error('boom')
    },
    async unload() { return true },
  }
}

function addPendingMessage(sessionId: string, content: string, createdAt: number): number {
  return appendMessage({
    sessionId, role: 'user', content, createdAt,
    embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
  })
}

describe('processEmbedQueue', () => {
  it('一批 pending 消息被 embedding + FTS 索引 + 标记完成，pending 数归零，可被向量/关键词召回', async () => {
    const id1 = addPendingMessage('s1', 'cat likes fish', 1000)
    const id2 = addPendingMessage('s1', 'dog likes bones', 2000)

    const result = await processEmbedQueue(fakeProvider())

    expect(result).toEqual({ processed: 2, remaining: 0 })
    expect(getPendingEmbeddingCount()).toBe(0)

    const vecResults = searchSimilarMessages(new Array(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0)), 1)
    expect(vecResults[0].messageId).toBe(id1)

    const ftsResults = searchMessagesFts('cat')
    expect(ftsResults).toHaveLength(1)
    expect(ftsResults[0].messageId).toBe(id1)

    void id2
  })

  it('batchSize 限制单批处理的消息数量，其余保持 pending', async () => {
    addPendingMessage('s1', 'msg 0', 1000)
    addPendingMessage('s1', 'msg 1', 2000)
    addPendingMessage('s1', 'msg 2', 3000)

    const result = await processEmbedQueue(fakeProvider(), 2)

    expect(result).toEqual({ processed: 2, remaining: 1 })
    expect(getPendingEmbeddingCount()).toBe(1)
  })

  it('队列为空时返回 {processed: 0, remaining: 0}，不调用 provider', async () => {
    const result = await processEmbedQueue(fakeProvider())
    expect(result).toEqual({ processed: 0, remaining: 0 })
  })

  it('provider.embedBatch 失败时不标记任何消息为 embedded，全部保持 pending 以便下次补偿', async () => {
    addPendingMessage('s1', 'msg 0', 1000)
    addPendingMessage('s1', 'msg 1', 2000)

    const result = await processEmbedQueue(failingProvider())

    expect(result).toEqual({ processed: 0, remaining: 2 })
    expect(getPendingEmbeddingCount()).toBe(2)
  })
})
