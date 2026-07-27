import { describe, it, expect } from 'vitest'
import { recordActivity, getLastActivityAt } from './aiActivity.js'

describe('aiActivity — 共享的最近 AI 活动追踪器', () => {
  it('recordActivity 之前，getLastActivityAt 反映之前记录的值（模块初始为 0）', () => {
    // 本文件独立运行时（vitest 每个测试文件独立模块实例）尚未调用过 recordActivity，
    // 默认应为 0（"从未记录过活动"）
    expect(getLastActivityAt()).toBe(0)
  })

  it('recordActivity 之后，getLastActivityAt 返回接近当前时间的时间戳', () => {
    const before = Date.now()
    recordActivity()
    const after = Date.now()

    const recorded = getLastActivityAt()
    expect(recorded).toBeGreaterThanOrEqual(before)
    expect(recorded).toBeLessThanOrEqual(after)
  })

  it('多次调用 recordActivity 会更新为最新的时间戳', async () => {
    recordActivity()
    const first = getLastActivityAt()

    await new Promise(resolve => setTimeout(resolve, 5))
    recordActivity()
    const second = getLastActivityAt()

    expect(second).toBeGreaterThan(first)
  })
})
