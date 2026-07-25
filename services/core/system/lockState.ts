// 锁屏状态跟踪（TDD §3.2 主进程→核心服务系统事件通知 + §3.8 摘要触发规则的 lockScreenMinutes 输入）。
// 状态只保存在进程内存中，不持久化到 DB——核心服务重启后锁屏计时器重置属于可接受的边界情况。
let lockStartedAt: number | null = null

// at 默认 Date.now()，测试可传入受控时间戳，无需 mock Date.now()
export function recordSystemEvent(type: 'lock-screen' | 'unlock-screen', at: number = Date.now()): void {
  if (type === 'lock-screen') lockStartedAt = at
  else if (type === 'unlock-screen') lockStartedAt = null
}

// now 默认 Date.now()，测试可传入受控时间戳
export function getLockScreenMinutes(now: number = Date.now()): number {
  return lockStartedAt === null ? 0 : (now - lockStartedAt) / 60_000
}
