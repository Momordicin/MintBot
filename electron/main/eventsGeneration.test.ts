import { describe, it, expect } from 'vitest'
import { hasServerRestarted, HEARTBEAT_INTERVAL_MS, EVENTS_CLIENT_TIMEOUT_MS } from './eventsGeneration'

describe('hasServerRestarted', () => {
  it('冷启动（从未见过任何 generation）不算重启——只是第一次观测，不该被诊断为"服务重启过"', () => {
    expect(hasServerRestarted(null, 'gen-a')).toBe(false)
  })

  it('generation 变化（核心服务确实换过一个新进程）应判定为重启', () => {
    expect(hasServerRestarted('gen-a', 'gen-b')).toBe(true)
  })

  it('generation 与上次相同（同一个核心服务进程，只是这条连接自己重连了一次）不算重启', () => {
    expect(hasServerRestarted('gen-a', 'gen-a')).toBe(false)
  })
})

describe('EVENTS_CLIENT_TIMEOUT_MS', () => {
  it('派生自心跳间隔的 3 倍，不是独立写死的常量', () => {
    expect(EVENTS_CLIENT_TIMEOUT_MS).toBe(HEARTBEAT_INTERVAL_MS * 3)
  })
})
