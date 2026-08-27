import { describe, it, expect, beforeEach } from 'vitest'
import { db, initDb } from '../db/index.js'
import {
  appendMessage, insertSummary, getMessagesByIds, getSummaries,
  insertEntity, getCurrentEntities, upsertMessageEmbedding, searchSimilarMessages,
  indexMessageFts, searchMessagesFts,
} from '../session/queries.js'
import { checkForgetImpact, forgetTimeRange, ForgetConflictError } from './forget.js'

initDb()

beforeEach(() => {
  db.exec(`
    DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;
    DELETE FROM message_embeddings; DELETE FROM message_fts; DELETE FROM MessageEntities;
  `)
})

// 构造确定性的 1024 维测试向量：仅在指定维度写入值，其余补零
function vec(dim: number, value: number): number[] {
  const v = new Array(1024).fill(0)
  v[dim] = value
  return v
}

function addMessage(sessionId: string, content: string, createdAt: number): number {
  return appendMessage({
    sessionId, role: 'user', content, createdAt,
    embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
  })
}

describe('checkForgetImpact', () => {
  it('无重叠时返回消息 id 但 affectedSummaries 为空', () => {
    const id1 = addMessage('s1', 'a', 1000)
    const id2 = addMessage('s1', 'b', 2000)

    const impact = checkForgetImpact('s1', 1000, 2000)

    expect(impact.messageIds).toEqual([id1, id2])
    expect(impact.affectedSummaries).toEqual([])
  })

  it('有重叠（单条摘要）时返回该摘要', () => {
    const id1 = addMessage('s1', 'a', 1000)
    const id2 = addMessage('s1', 'b', 2000)
    const summaryId = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: id1, toMessageId: id2 })

    const impact = checkForgetImpact('s1', 1000, 2000)

    expect(impact.affectedSummaries.map(s => s.id)).toEqual([summaryId])
  })

  it('有重叠（多条摘要）时全部返回', () => {
    const id1 = addMessage('s1', 'a', 1000)
    const id2 = addMessage('s1', 'b', 2000)
    const id3 = addMessage('s1', 'c', 3000)
    const summaryId1 = insertSummary({ sessionId: 's1', content: '摘要1', fromMessageId: id1, toMessageId: id2 })
    const summaryId2 = insertSummary({ sessionId: 's1', content: '摘要2', fromMessageId: id2, toMessageId: id3 })

    const impact = checkForgetImpact('s1', 1000, 3000)

    expect(impact.affectedSummaries.map(s => s.id).sort()).toEqual([summaryId1, summaryId2].sort())
  })

  it('时间段内无消息时返回空结果', () => {
    const impact = checkForgetImpact('s1', 1000, 2000)
    expect(impact).toEqual({ messageIds: [], affectedSummaries: [] })
  })

  it('调用后不做任何删除，原数据仍在', () => {
    const id1 = addMessage('s1', 'a', 1000)
    const summaryId = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: id1, toMessageId: id1 })

    checkForgetImpact('s1', 1000, 1000)

    expect(getMessagesByIds([id1])).toHaveLength(1)
    expect(getSummaries('s1').map(s => s.id)).toEqual([summaryId])
  })
})

describe('forgetTimeRange', () => {
  it('无重叠时直接成功删除', () => {
    const id1 = addMessage('s1', 'a', 1000)

    const result = forgetTimeRange('s1', 1000, 1000, { alsoDeleteAffectedSummaries: false })

    expect(result.deletedMessages).toBe(1)
    expect(getMessagesByIds([id1])).toEqual([])
  })

  it('有重叠且 alsoDeleteAffectedSummaries: false 时抛 ForgetConflictError（带 impact），且五张表全部不受影响', () => {
    const id1 = addMessage('s1', 'a', 1000)
    const summaryId = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: id1, toMessageId: id1 })
    upsertMessageEmbedding(id1, 's1', vec(0, 1))
    indexMessageFts(id1, 's1', 'a')
    insertEntity({ messageId: id1, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })

    let caught: unknown
    try {
      forgetTimeRange('s1', 1000, 1000, { alsoDeleteAffectedSummaries: false })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ForgetConflictError)
    expect((caught as ForgetConflictError).impact.affectedSummaries.map(s => s.id)).toEqual([summaryId])

    expect(getMessagesByIds([id1])).toHaveLength(1)
    expect(getSummaries('s1').map(s => s.id)).toEqual([summaryId])
    expect(searchSimilarMessages(vec(0, 1), 5, 's1').map(r => r.messageId)).toEqual([id1])
    expect(searchMessagesFts('a', 's1')).toHaveLength(1)
    expect(getCurrentEntities('s1')).toHaveLength(1)
  })

  it('有重叠且 alsoDeleteAffectedSummaries: true 时摘要和消息一起被删', () => {
    const id1 = addMessage('s1', 'a', 1000)
    insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: id1, toMessageId: id1 })

    const result = forgetTimeRange('s1', 1000, 1000, { alsoDeleteAffectedSummaries: true })

    expect(result.deletedMessages).toBe(1)
    expect(result.deletedSummaries).toBe(1)
    expect(getMessagesByIds([id1])).toEqual([])
    expect(getSummaries('s1')).toEqual([])
  })

  it('时间段内无消息时返回全 0，不抛错', () => {
    const result = forgetTimeRange('s1', 1000, 2000, { alsoDeleteAffectedSummaries: false })
    expect(result).toEqual({ deletedMessages: 0, deletedEntities: 0, deletedSummaries: 0, deletedEmbeddings: 0, deletedFts: 0 })
  })
})
