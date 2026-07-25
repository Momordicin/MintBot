import { describe, it, expect } from 'vitest'
import { parseSelfEmotion } from './emotion.js'

describe('parseSelfEmotion', () => {
  it('合法输入：解析出 self 情绪', () => {
    const raw = JSON.stringify({
      reply: '今天怎么样？',
      emotion: { self: { label: 'curious', intensity: 0.7 }, perceived_user: null },
    })
    expect(parseSelfEmotion(raw)).toEqual({ label: 'curious', intensity: 0.7 })
  })

  it('非 JSON：返回 null', () => {
    expect(parseSelfEmotion('不是 JSON 的普通回复')).toBeNull()
  })

  it('缺少 emotion 字段：返回 null', () => {
    expect(parseSelfEmotion(JSON.stringify({ reply: '你好' }))).toBeNull()
  })

  it('emotion.self 缺失：返回 null', () => {
    expect(parseSelfEmotion(JSON.stringify({ reply: '你好', emotion: {} }))).toBeNull()
  })

  it('label 为空字符串：返回 null', () => {
    const raw = JSON.stringify({ reply: '你好', emotion: { self: { label: '', intensity: 0.5 } } })
    expect(parseSelfEmotion(raw)).toBeNull()
  })

  it('intensity 超出 0-1 范围：返回 null', () => {
    const raw = JSON.stringify({ reply: '你好', emotion: { self: { label: 'happy', intensity: 1.5 } } })
    expect(parseSelfEmotion(raw)).toBeNull()

    const raw2 = JSON.stringify({ reply: '你好', emotion: { self: { label: 'happy', intensity: -0.1 } } })
    expect(parseSelfEmotion(raw2)).toBeNull()
  })

  it('intensity 非 number：返回 null', () => {
    const raw = JSON.stringify({ reply: '你好', emotion: { self: { label: 'happy', intensity: '0.7' } } })
    expect(parseSelfEmotion(raw)).toBeNull()
  })
})
