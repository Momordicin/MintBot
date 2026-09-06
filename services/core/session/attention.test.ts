import { describe, it, expect, beforeEach } from 'vitest'
import { db, initDb } from '../db/index.js'
import { appendMessage } from './queries.js'
import { recordAttention, getLastAttentionAt, markExplicitSleep, isExplicitSleep } from './attention.js'

initDb()

beforeEach(() => {
  db.exec(`DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets;`)
})

describe('session/attention', () => {
  it('没有历史消息、也没有搭理过时，getLastAttentionAt 返回 null', () => {
    expect(getLastAttentionAt('session-never-touched')).toBeNull()
  })

  it('内存无记录时，回退读该 session 最近一条消息的 createdAt 作为初值', () => {
    const sessionId = 'session-fallback'
    appendMessage({ sessionId, role: 'user', content: 'hi', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    appendMessage({ sessionId, role: 'assistant', content: 'hello', createdAt: 2000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })

    expect(getLastAttentionAt(sessionId)).toBe(2000)
  })

  it('recordAttention 之后，getLastAttentionAt 返回内存值（不再读 DB），且清除显式睡着标记', () => {
    const sessionId = 'session-recorded'
    appendMessage({ sessionId, role: 'user', content: 'hi', createdAt: 1000, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null })
    markExplicitSleep(sessionId)
    expect(isExplicitSleep(sessionId)).toBe(true)

    recordAttention(sessionId, 5000)

    expect(getLastAttentionAt(sessionId)).toBe(5000)
    expect(isExplicitSleep(sessionId)).toBe(false)
  })

  it('两个不同 session 的 lastAttentionAt/显式睡着标记互相独立', () => {
    recordAttention('session-a', 111)
    markExplicitSleep('session-b')

    expect(getLastAttentionAt('session-a')).toBe(111)
    expect(getLastAttentionAt('session-b')).toBeNull()
    expect(isExplicitSleep('session-a')).toBe(false)
    expect(isExplicitSleep('session-b')).toBe(true)
  })

  it('isExplicitSleep 默认返回 false', () => {
    expect(isExplicitSleep('session-untouched')).toBe(false)
  })
})
