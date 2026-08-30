// 共享的"最近一次 AI 相关活动"追踪器（embedding + NER 共用同一个信号，见 TDD §3.1
// 进程与模型生命周期分离——两者由整理模式统一 unload）。EmbeddingProvider / NERProvider
// 在各自方法开始时调用 recordActivity()，orchestrator 的整理模式 tick 据此判断是否
// 已空闲超过 20 分钟、可以释放模型。进程内存状态，不持久化，重启后重置。
//
// 初始值取模块加载时的 Date.now()，而不是 0：刚启动的进程还没有真实 AI 活动，但也
// 绝不是"空闲了 20 分钟"——如果初始值是 0，orchestrator 里 getNow() - getLastActivityAt()
// 会被当成 Unix 纪元以来的毫秒数（远超 20 分钟阈值），导致每次进程刚启动就立刻触发一次
// 误判的 unload。"刚启动"应该和"刚有活动"一样重置空闲计时，而不是被当作"自古以来都空闲"。
let lastActivityAt = Date.now()

export function recordActivity(): void {
  lastActivityAt = Date.now()
}

export function getLastActivityAt(): number {
  return lastActivityAt
}
