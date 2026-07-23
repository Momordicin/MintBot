import { describe, it, expect, beforeEach } from 'vitest'
import { db, initDb } from '../db/index.js'
import { appendMessage, getPendingEmbeddingCount, getCurrentEntities } from '../session/queries.js'
import { runOrganizeModeTick, isInDefaultOrganizeWindow } from './orchestrator.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'
import type { NERProvider } from '../providers/NERProvider.js'
import type { EntityModelProvider } from './entityExtractor.js'

initDb()
beforeEach(() => {
  db.exec(`DELETE FROM Messages; DELETE FROM message_embeddings; DELETE FROM message_fts; DELETE FROM MessageEntities;`)
})

// 确定性假 embedding provider（与 embedQueue.test.ts 同款风格）
function fakeEmbedding(): EmbeddingProvider {
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
  }
}

function failingEmbedding(): EmbeddingProvider {
  return {
    async embed() { throw new Error('boom') },
    async embedBatch() { throw new Error('boom') },
  }
}

// 空结果假 NER / 假主模型（与 entityExtractor.test.ts 同款风格），只依赖规则层产出实体
function emptyNer(): NERProvider {
  return {
    async extract() { return [] },
    async extractBatch(texts: string[]) { return texts.map(() => []) },
  }
}

function emptyModel(): EntityModelProvider {
  return { async completeSync() { return '{"techTerms":[],"changes":[]}' } }
}

function addMessage(content: string, createdAt: number): number {
  return appendMessage({
    sessionId: 's1', role: 'user', content, createdAt,
    embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
  })
}

// 固定在低活跃时间窗口内（凌晨 2 点，本机时区）的测试基准时间
const NOW_IN_WINDOW = new Date(2024, 0, 1, 2, 0, 0).getTime()
// 固定在低活跃时间窗口外（下午 2 点）的测试基准时间
const NOW_OUT_OF_WINDOW = new Date(2024, 0, 1, 14, 0, 0).getTime()

const MIN = 60_000

describe('runOrganizeModeTick', () => {
  it('满足所有触发条件（oldestPendingAge>120min, 无活跃对话, 在时间窗口内）时执行 embedding + 实体抽取', async () => {
    addMessage('我喜欢猫', NOW_IN_WINDOW - 130 * MIN)
    addMessage('我的老板是王总', NOW_IN_WINDOW - 129 * MIN)
    addMessage('我在阿里巴巴工作', NOW_IN_WINDOW - 128 * MIN)

    const result = await runOrganizeModeTick(
      { embedding: fakeEmbedding(), ner: emptyNer(), model: emptyModel() },
      200,
      () => NOW_IN_WINDOW
    )

    expect(result).toEqual({
      triggered: true,
      batches: 1,
      totalProcessed: 3,
      totalEntitiesInserted: 3,
      totalEntitiesClosed: 0,
    })
    expect(getPendingEmbeddingCount()).toBe(0)

    const entities = getCurrentEntities('s1')
    expect(entities).toHaveLength(3)
    expect(entities.find(e => e.type === 'preference')?.value).toBe('喜欢猫')
  })

  it('activeConversation=true（5 分钟内有消息）时不触发，即使 pendingCount 很高', async () => {
    for (let i = 0; i < 101; i++) {
      addMessage(`旧消息${i}`, NOW_IN_WINDOW - 200 * MIN + i)
    }
    // 最近一条消息在 1 分钟内 → activeConversation = true
    addMessage('刚发的消息', NOW_IN_WINDOW - 1 * MIN)

    const result = await runOrganizeModeTick(
      { embedding: fakeEmbedding(), ner: emptyNer(), model: emptyModel() },
      200,
      () => NOW_IN_WINDOW
    )

    expect(result).toEqual({ triggered: false, batches: 0, totalProcessed: 0, totalEntitiesInserted: 0, totalEntitiesClosed: 0 })
    expect(getPendingEmbeddingCount()).toBe(102)
  })

  it('不在低活跃时间窗口内时不触发，即使 pendingCount 很高且无活跃对话', async () => {
    for (let i = 0; i < 101; i++) {
      addMessage(`旧消息${i}`, NOW_OUT_OF_WINDOW - 200 * MIN + i)
    }

    const result = await runOrganizeModeTick(
      { embedding: fakeEmbedding(), ner: emptyNer(), model: emptyModel() },
      200,
      () => NOW_OUT_OF_WINDOW
    )

    expect(result).toEqual({ triggered: false, batches: 0, totalProcessed: 0, totalEntitiesInserted: 0, totalEntitiesClosed: 0 })
    expect(getPendingEmbeddingCount()).toBe(101)
  })

  it('pendingCount 和 oldestPendingAge 都不满足阈值时不触发', async () => {
    for (let i = 0; i < 5; i++) {
      addMessage(`消息${i}`, NOW_IN_WINDOW - 10 * MIN + i)
    }

    const result = await runOrganizeModeTick(
      { embedding: fakeEmbedding(), ner: emptyNer(), model: emptyModel() },
      200,
      () => NOW_IN_WINDOW
    )

    expect(result).toEqual({ triggered: false, batches: 0, totalProcessed: 0, totalEntitiesInserted: 0, totalEntitiesClosed: 0 })
    expect(getPendingEmbeddingCount()).toBe(5)
  })

  it('多批循环：每批处理完重新评估条件，pendingCount 跌破阈值后立即停止，不跑多余的批次', async () => {
    // 60 条很旧的消息（>120min），保证前几批处理时 oldestPendingAge 条件持续满足
    for (let i = 0; i < 60; i++) {
      addMessage(`旧消息${i}`, NOW_IN_WINDOW - 200 * MIN + i)
    }
    // 100 条较新的消息（~10min，> 5min 活跃对话窗口，但 < 120min），处理到这批时应触发停止条件
    for (let i = 0; i < 100; i++) {
      addMessage(`较新消息${i}`, NOW_IN_WINDOW - 10 * MIN + i)
    }

    const result = await runOrganizeModeTick(
      { embedding: fakeEmbedding(), ner: emptyNer(), model: emptyModel() },
      50,
      () => NOW_IN_WINDOW
    )

    // 第 1 批处理完剩余 110（>100，继续）；第 2 批处理完剩余 60（不再 >100，且最旧剩余消息 <120min，停止）
    expect(result.batches).toBe(2)
    expect(result.totalProcessed).toBe(100)
    expect(getPendingEmbeddingCount()).toBe(60)
  })

  it('extractEntities 执行期间新插入的消息不会被同一批次的 processEmbedQueue 一并标记为 embedded（批次不被污染）', async () => {
    addMessage('我喜欢猫', NOW_IN_WINDOW - 130 * MIN)
    addMessage('我的老板是王总', NOW_IN_WINDOW - 129 * MIN)
    addMessage('我在阿里巴巴工作', NOW_IN_WINDOW - 128 * MIN)

    let sneakedId = -1
    // 模拟 extractEntities 内部 NER 网络调用耗时期间，用户中途发了一条新消息；
    // 由于 processEmbedQueue 现在直接复用 orchestrator 已经查好的同一批 batch（而不是自己
    // 重新查询 pending 消息），这条新消息不应该被这次 tick 的 embedding 处理
    const nerThatSneaksInAMessage: NERProvider = {
      async extract() { return [] },
      async extractBatch(texts: string[]) {
        sneakedId = addMessage('用户中途插入的新消息', NOW_IN_WINDOW - 1 * MIN)
        return texts.map(() => [])
      },
    }

    const result = await runOrganizeModeTick(
      { embedding: fakeEmbedding(), ner: nerThatSneaksInAMessage, model: emptyModel() },
      200,
      () => NOW_IN_WINDOW
    )

    expect(result.batches).toBe(1)
    expect(result.totalProcessed).toBe(3)
    expect(sneakedId).toBeGreaterThan(0)
    // 中途插入的消息应保持 pending，留给下一批 / 下一次 tick 处理，而不是被误标记为 embedded
    expect(getPendingEmbeddingCount()).toBe(1)
  })

  it('时间在批次之间跨出低活跃窗口时，下一次评估应使用最新时间重新判断并停止（getNow 按迭代重新取值，而非冻结）', async () => {
    // 150 条很旧的消息（远超 120min），保证如果时间窗口没有真的跨出，第 2 批本该正常触发
    for (let i = 0; i < 150; i++) {
      addMessage(`旧消息${i}`, NOW_IN_WINDOW - 300 * MIN + i)
    }

    let calls = 0
    const getNow = () => {
      calls++
      // 第 1 次评估（批次 1 开始前）仍在窗口内；从第 2 次评估起跳到窗口外，
      // 模拟这次 tick 处理批次 1 耗时较长、真实时钟已经推进出了低活跃窗口
      return calls === 1 ? NOW_IN_WINDOW : NOW_OUT_OF_WINDOW
    }

    const result = await runOrganizeModeTick(
      { embedding: fakeEmbedding(), ner: emptyNer(), model: emptyModel() },
      50,
      getNow
    )

    expect(result.batches).toBe(1)
    expect(result.totalProcessed).toBe(50)
    expect(getPendingEmbeddingCount()).toBe(100)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('embedBatch 持续失败时，处理完这一批失败批次后立即停止（不会在同一 tick 内无限重试）', async () => {
    addMessage('我喜欢猫', NOW_IN_WINDOW - 130 * MIN)
    addMessage('我的老板是王总', NOW_IN_WINDOW - 129 * MIN)

    const result = await runOrganizeModeTick(
      { embedding: failingEmbedding(), ner: emptyNer(), model: emptyModel() },
      200,
      () => NOW_IN_WINDOW
    )

    expect(result).toEqual({
      triggered: true,
      batches: 1,
      totalProcessed: 0,
      totalEntitiesInserted: 2,
      totalEntitiesClosed: 0,
    })
    // embedding 失败，消息保持 pending，留待下次整理模式运行时重试
    expect(getPendingEmbeddingCount()).toBe(2)
  })
})

describe('isInDefaultOrganizeWindow', () => {
  it('22:00:00 属于窗口内（窗口起点）', () => {
    expect(isInDefaultOrganizeWindow(new Date(2024, 0, 1, 22, 0, 0).getTime())).toBe(true)
  })

  it('21:59:59 不属于窗口（起点之前）', () => {
    expect(isInDefaultOrganizeWindow(new Date(2024, 0, 1, 21, 59, 59).getTime())).toBe(false)
  })

  it('07:59:59 属于窗口内（窗口终点之前）', () => {
    expect(isInDefaultOrganizeWindow(new Date(2024, 0, 1, 7, 59, 59).getTime())).toBe(true)
  })

  it('08:00:00 不属于窗口（终点，窗口不含终点）', () => {
    expect(isInDefaultOrganizeWindow(new Date(2024, 0, 1, 8, 0, 0).getTime())).toBe(false)
  })

  it('00:00:00 属于窗口内（跨午夜）', () => {
    expect(isInDefaultOrganizeWindow(new Date(2024, 0, 1, 0, 0, 0).getTime())).toBe(true)
  })

  it('14:00:00 不属于窗口（日间）', () => {
    expect(isInDefaultOrganizeWindow(new Date(2024, 0, 1, 14, 0, 0).getTime())).toBe(false)
  })
})
