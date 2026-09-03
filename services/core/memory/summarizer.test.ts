import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db, initDb } from '../db/index.js'
import { decrypt } from '../db/crypto.js'
import { appendMessage } from '../session/queries.js'
import { shouldTriggerSummary, generateSummary, type SummaryModelProvider } from './summarizer.js'

// lockScreenMinutes / messageCountThreshold 现在来自独立 config 模块，mock 成与迁移前硬编码
// 常量完全一致的值（60 / 50），保证本文件已有的真值表断言继续成立
vi.mock('../config/index.js', () => ({
  getMemoryConfig: () => ({
    recentTrackMaxMessages: 50,
    recentTrackMaxMinutes: 30,
    organizeWindowStartHour: 22,
    organizeWindowEndHour: 8,
    summaryTrigger: { pendingCountThreshold: 100, oldestPendingAgeMinutes: 120, messageCountThreshold: 50, lockScreenMinutes: 60, minMessagesForLockTrigger: 4 },
    contextBudget: { total: 8000, systemPrompt: 1000, summary: 1500, rag: 2000, recentMessages: 3000, responseReserve: 500 },
  }),
}))

initDb()
beforeEach(() => {
  db.exec(`DELETE FROM Messages; DELETE FROM Summaries;`)
})

function addMessage(sessionId: string, content: string, createdAt: number): number {
  return appendMessage({
    sessionId, role: 'user', content, createdAt,
    embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
  })
}

function modelReturning(text: string): SummaryModelProvider {
  return { async completeSync() { return text } }
}

function throwingModel(): SummaryModelProvider {
  return { async completeSync() { throw new Error('model boom') } }
}

describe('shouldTriggerSummary — 组合规则真值表', () => {
  it('低活跃时段 且 锁屏时长 > 60min 且消息数达到下限（4） → true', () => {
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 4, lockScreenMinutes: 61, isLowActivityWindow: true })).toBe(true)
  })

  it('低活跃时段 但 锁屏时长未超过 60min → false', () => {
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 4, lockScreenMinutes: 60, isLowActivityWindow: true })).toBe(false)
  })

  it('锁屏时长超过 60min 但不在低活跃时段 → false（AND 条件不满足）', () => {
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 4, lockScreenMinutes: 120, isLowActivityWindow: false })).toBe(false)
  })

  it('消息数 > 50 时无条件触发（OR 条件）', () => {
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 51, lockScreenMinutes: 0, isLowActivityWindow: false })).toBe(true)
  })

  it('消息数恰好等于 50 时不触发', () => {
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 50, lockScreenMinutes: 0, isLowActivityWindow: false })).toBe(false)
  })

  it('三个条件都不满足时不触发', () => {
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 10, lockScreenMinutes: 10, isLowActivityWindow: false })).toBe(false)
  })
})

describe('shouldTriggerSummary — 锁屏分支的消息数下限（minMessagesForLockTrigger）', () => {
  it('锁屏 + 低活跃时段条件都满足，但消息数低于下限（3 < 4）时不触发', () => {
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 3, lockScreenMinutes: 61, isLowActivityWindow: true })).toBe(false)
  })

  it('锁屏 + 低活跃时段条件都满足，消息数恰好达到下限（4）时触发', () => {
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 4, lockScreenMinutes: 61, isLowActivityWindow: true })).toBe(true)
  })

  it('锁屏 + 低活跃时段条件都满足，消息数超过下限时触发', () => {
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 10, lockScreenMinutes: 61, isLowActivityWindow: true })).toBe(true)
  })

  it('messageCount > 50 分支不受下限影响：消息数为 0 时该分支本身就不触发（下限只影响锁屏分支）', () => {
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 0, lockScreenMinutes: 0, isLowActivityWindow: false })).toBe(false)
    expect(shouldTriggerSummary({ messageCountSinceLastSummary: 51, lockScreenMinutes: 0, isLowActivityWindow: false })).toBe(true)
  })
})

describe('generateSummary', () => {
  it('正常生成摘要并落库，待摘要消息全部标记 summarized', async () => {
    const sessionId = 's1'
    const id1 = addMessage(sessionId, '我喜欢猫', 1000)
    const id2 = addMessage(sessionId, '我在阿里巴巴工作', 2000)

    const result = await generateSummary(sessionId, { model: modelReturning('用户喜欢猫，在阿里巴巴工作') })

    expect(result).toEqual({ summaryId: expect.any(Number), fromMessageId: id1, toMessageId: id2 })

    // content 落盘前需 encrypt()（TDD §3.6 加密字段范围含摘要），decrypt 回来后应等于原文；
    // decrypt() 在 encryptSensitiveFields=false 时是直通 no-op，两种模式下断言都成立
    const summaryRow = db.prepare(`SELECT * FROM Summaries WHERE id = ?`).get(result!.summaryId) as any
    expect(decrypt(summaryRow.content)).toBe('用户喜欢猫，在阿里巴巴工作')
    expect(summaryRow.fromMessageId).toBe(id1)
    expect(summaryRow.toMessageId).toBe(id2)

    const messages = db.prepare(`SELECT * FROM Messages WHERE sessionId = ?`).all(sessionId) as any[]
    expect(messages.every(m => m.summarized === 1)).toBe(true)
  })

  it('encryptSensitiveFields=true 时落盘 content 非明文，decrypt 后可正确还原', async () => {
    const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
    process.env.ENCRYPT_SENSITIVE_FIELDS = 'true'
    try {
      const sessionId = 's2'
      addMessage(sessionId, '我喜欢猫', 1000)

      const result = await generateSummary(sessionId, { model: modelReturning('摘要正文') })

      const summaryRow = db.prepare(`SELECT * FROM Summaries WHERE id = ?`).get(result!.summaryId) as any
      expect(summaryRow.content).not.toBe('摘要正文')
      expect(decrypt(summaryRow.content)).toBe('摘要正文')
    } finally {
      process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
    }
  })

  it('maxMessages 限制单批处理的待摘要消息数量，其余保持 summarized=0 留待下次', async () => {
    const sessionId = 's3'
    const id1 = addMessage(sessionId, 'msg0', 1000)
    const id2 = addMessage(sessionId, 'msg1', 2000)
    addMessage(sessionId, 'msg2', 3000)

    const result = await generateSummary(sessionId, { model: modelReturning('摘要') }, 2)

    expect(result).toEqual({ summaryId: expect.any(Number), fromMessageId: id1, toMessageId: id2 })

    const messages = db.prepare(`SELECT * FROM Messages WHERE sessionId = ? ORDER BY id`).all(sessionId) as any[]
    expect(messages.map(m => m.summarized)).toEqual([1, 1, 0])
  })

  it('没有待摘要消息时返回 null，不调用 model', async () => {
    const result = await generateSummary('s1', { model: throwingModel() })
    expect(result).toBeNull()
  })

  it('model 调用失败时向上抛出错误，不标记任何消息为 summarized', async () => {
    const sessionId = 's1'
    addMessage(sessionId, '我喜欢猫', 1000)

    await expect(generateSummary(sessionId, { model: throwingModel() })).rejects.toThrow('model boom')

    const messages = db.prepare(`SELECT * FROM Messages WHERE sessionId = ?`).all(sessionId) as any[]
    expect(messages.every(m => m.summarized === 0)).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) as count FROM Summaries`).get() as any).toEqual({ count: 0 })
  })
})
