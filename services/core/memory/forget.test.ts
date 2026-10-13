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

function addAssistant(sessionId: string, content: string, createdAt: number): number {
  return appendMessage({
    sessionId, role: 'assistant', content, createdAt,
    embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
  })
}

describe('按问题为准的范围选择', () => {
  it('问题在范围内则连同回复一起删，回复在范围内而问题不在则保留', () => {
    const q1 = addMessage('s1', 'q1', 1000)
    const a1 = addAssistant('s1', 'a1', 3000)
    const q2 = addMessage('s1', 'q2', 2000)
    const a2 = addAssistant('s1', 'a2', 5000)
    const q3 = addMessage('s1', 'q3', 4000)
    const a3 = addAssistant('s1', 'a3', 6000)

    const result = forgetTimeRange('s1', 1000, 3000, { alsoDeleteAffectedSummaries: false })

    expect(result.deletedMessages).toBe(4)
    expect(getMessagesByIds([q1, a1, q2, a2])).toEqual([])
    expect(getMessagesByIds([q3, a3]).map(m => m.id)).toEqual([q3, a3])
  })

  it('范围只覆盖回复时什么都不删', () => {
    const q1 = addMessage('s1', 'q1', 1000)
    const a1 = addAssistant('s1', 'a1', 3000)

    const impact = checkForgetImpact('s1', 2500, 3500)
    const result = forgetTimeRange('s1', 2500, 3500, { alsoDeleteAffectedSummaries: false })

    expect(impact.messageIds).toEqual([])
    expect(result.deletedMessages).toBe(0)
    expect(getMessagesByIds([q1, a1])).toHaveLength(2)
  })

  it('没有回复的问题（后面紧跟另一个问题）只删它自己', () => {
    const q1 = addMessage('s1', 'q1', 1000)
    const q2 = addMessage('s1', 'q2', 2000)
    const a2 = addAssistant('s1', 'a2', 3000)

    const result = forgetTimeRange('s1', 1000, 1000, { alsoDeleteAffectedSummaries: false })

    expect(result.deletedMessages).toBe(1)
    expect(getMessagesByIds([q1])).toEqual([])
    expect(getMessagesByIds([q2, a2])).toHaveLength(2)
  })

  it('最后一个问题没有任何后续消息时只删它自己', () => {
    const q1 = addMessage('s1', 'q1', 1000)

    expect(checkForgetImpact('s1', 1000, 1000).messageIds).toEqual([q1])
  })

  it('不会把别的会话的消息当作回复', () => {
    const q1 = addMessage('s1', 'q1', 1000)
    const other = addAssistant('s2', 'x', 1500)
    const a1 = addAssistant('s1', 'a1', 2000)

    expect(checkForgetImpact('s1', 1000, 1000).messageIds).toEqual([q1, a1])
    expect(getMessagesByIds([other])).toHaveLength(1)
  })

  it('预览的消息数等于实际删除的条数', () => {
    addMessage('s1', 'q1', 1000)
    addAssistant('s1', 'a1', 3000)
    addMessage('s1', 'q2', 2000)
    addAssistant('s1', 'a2', 5000)
    addMessage('s1', 'q3', 4000)
    addAssistant('s1', 'a3', 6000)

    const impact = checkForgetImpact('s1', 1000, 3000)
    const result = forgetTimeRange('s1', 1000, 3000, { alsoDeleteAffectedSummaries: false })

    expect(impact.messageIds).toHaveLength(4)
    expect(result.deletedMessages).toBe(impact.messageIds.length)
  })

  it('重叠摘要按被删消息 id 的最小值和最大值判断', () => {
    addMessage('s1', 'q1', 1000)
    addAssistant('s1', 'a1', 1500)
    const q2 = addMessage('s1', 'q2', 2000)
    const a2 = addAssistant('s1', 'a2', 2500)
    const summaryId = insertSummary({ sessionId: 's1', content: '摘要', fromMessageId: a2, toMessageId: a2 + 1 })

    const impact = checkForgetImpact('s1', 2000, 2000)

    expect(impact.messageIds).toEqual([q2, a2])
    expect(impact.affectedSummaries.map(s => s.id)).toEqual([summaryId])
  })
})
