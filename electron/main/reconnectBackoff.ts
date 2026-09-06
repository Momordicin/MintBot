// GET /events 长连接重连退避的纯计算部分（buzzing-frolicking-eich.md 子任务④，见
// electron/main/index.ts subscribeToCoreEvents 顶部注释）。单独抽出这个文件的唯一
// 理由是它不 import 'electron'，可以被 vitest 直接测——index.ts 本身依赖 electron
// 运行时（BrowserWindow/app/...），没有 mock 的情况下没法在 vitest（node 环境）里
// 加载，不值得为了测这一小段纯函数去搭一套 electron mock

// 起始退避（连续失败重连的第一次等待）：核心服务冷启动/短暂重启（如 tsx watch 保存
// 触发的重载）通常在 1s 内就能重新接受连接，退避下限设成这个量级，保证这类场景几乎
// 感觉不到断线
export const RECONNECT_BACKOFF_FLOOR_MS = 1000

// 封顶退避：核心服务长时间不可用时（比如手动停掉了 core 进程），不能让重试间隔无限
// 拉长到分钟级——用户重新拉起核心服务后，主进程应该在合理时间内感知到并恢复置顶/
// 图标同步，30s 是"不至于变成重试风暴"与"核心服务恢复后不要等太久"之间的折中
export const RECONNECT_BACKOFF_CAP_MS = 30000

// 每次连接尝试失败后，用当前退避值算出下一次该等待多久：翻倍增长，封顶在
// RECONNECT_BACKOFF_CAP_MS。连接成功过之后退避会被调用方重置回 RECONNECT_BACKOFF_FLOOR_MS
// （不由这个函数负责，见 index.ts subscribeToCoreEvents），这里只管"失败之后怎么涨"
export function nextReconnectDelayMs(previousDelayMs: number): number {
  return Math.min(previousDelayMs * 2, RECONNECT_BACKOFF_CAP_MS)
}
