// electron/main/coreProcess.test.ts — pollUntilReady 的就绪 / 超时 / 中止与 buildTaskkillArgs 的参数测试
//
// 用法：pnpm test
// 配套文件：electron/main/coreProcess.ts

import { describe, it, expect } from 'vitest'
import { buildTaskkillArgs, pollUntilReady } from './coreProcess'

function fakeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    },
  }
}

describe('buildTaskkillArgs', () => {
  it('带 /T /F 以连同子进程强制结束', () => {
    expect(buildTaskkillArgs(1234)).toEqual(['/pid', '1234', '/T', '/F'])
  })
})

describe('pollUntilReady', () => {
  it('探测成功即返回 true', async () => {
    const clock = fakeClock()
    let calls = 0
    const ready = await pollUntilReady(async () => ++calls >= 3, 60000, 500, clock)
    expect(ready).toBe(true)
    expect(calls).toBe(3)
  })

  it('超时仍未就绪返回 false', async () => {
    const clock = fakeClock()
    const ready = await pollUntilReady(async () => false, 2000, 500, clock)
    expect(ready).toBe(false)
    expect(clock.now()).toBe(2000)
  })

  it('shouldContinue 为假时立即停止探测', async () => {
    const clock = fakeClock()
    let calls = 0
    const ready = await pollUntilReady(async () => {
      calls++
      return false
    }, 60000, 500, { ...clock, shouldContinue: () => calls < 2 })
    expect(ready).toBe(false)
    expect(calls).toBe(2)
  })
})
