import { describe, it, expect } from 'vitest'
import { recordActivity, getLastActivityAt } from './aiActivity.js'

describe('aiActivity — 共享的最近 AI 活动追踪器', () => {
  it('recordActivity 之前，getLastActivityAt 反映模块加载时刻，而非 0（避免被当成"自古以来都空闲"）', () => {
    // 模块初始值取加载时的 Date.now()，不是 0：如果是 0，orchestrator 里
    // getNow() - getLastActivityAt() 会算成 Unix 纪元以来的毫秒数，远超 20 分钟空闲阈值，
    // 导致进程刚启动就被误判为空闲已久、立即触发 unload。
    // 模块加载时间点不在测试体内可控（import 已在测试运行前完成），因此用宽松断言：
    // 只要求它是一个"大于 0 且不晚于当前时间"的时间戳。
    expect(getLastActivityAt()).toBeGreaterThan(0)
    expect(getLastActivityAt()).toBeLessThanOrEqual(Date.now())
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
