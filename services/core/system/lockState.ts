// services/core/system/lockState.ts — 记录系统锁屏开始时间，换算当前已锁屏分钟数
// 用法：recordSystemEvent(type) 由 POST /internal/system-event 调用；getLockScreenMinutes(now) 由 memory/orchestrator.ts 读取，未锁屏返回 0
// 形状：进程内存单个 lockStartedAt（毫秒时间戳 | null）
// 对应文件：services/core/routes/internal.ts / services/core/memory/orchestrator.ts / services/core/system/lockState.test.ts
let lockStartedAt: number | null = null

export function recordSystemEvent(type: 'lock-screen' | 'unlock-screen', at: number = Date.now()): void {
  if (type === 'lock-screen') lockStartedAt = at
  else if (type === 'unlock-screen') lockStartedAt = null
}

export function getLockScreenMinutes(now: number = Date.now()): number {
  return lockStartedAt === null ? 0 : (now - lockStartedAt) / 60_000
}
