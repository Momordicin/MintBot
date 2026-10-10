// services/core/providers/aiActivity.ts — 进程内记录"最近一次调用 AI 服务"的时间戳（模块级变量，初值为加载时刻）
// 用法：EmbeddingProvider / NERProvider 每次调用前 recordActivity()；orchestrator 的整理 tick 读 getLastActivityAt() 判断 AI 服务是否已空闲、可卸载模型
// 对应文件：services/core/providers/EmbeddingProvider.ts / services/core/providers/NERProvider.ts / services/core/memory/orchestrator.ts / services/core/providers/aiActivity.test.ts
let lastActivityAt = Date.now()

export function recordActivity(): void {
  lastActivityAt = Date.now()
}

export function getLastActivityAt(): number {
  return lastActivityAt
}
