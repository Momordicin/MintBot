// 共享的"最近一次 AI 相关活动"追踪器（embedding + NER 共用同一个信号，见 TDD §3.1
// 进程与模型生命周期分离——两者由整理模式统一 unload）。EmbeddingProvider / NERProvider
// 在各自方法开始时调用 recordActivity()，orchestrator 的整理模式 tick 据此判断是否
// 已空闲超过 20 分钟、可以释放模型。进程内存状态，不持久化，重启后重置为 0。

let lastActivityAt = 0

export function recordActivity(): void {
  lastActivityAt = Date.now()
}

export function getLastActivityAt(): number {
  return lastActivityAt
}
