// GET /events 状态收敛模型的纯计算部分（TDD §3.3「hello / heartbeat」，见 index.ts
// connectToCoreEvents 里的 hello/heartbeat 分支）。单独抽出这个文件的理由跟
// reconnectBackoff.ts 一样：不 import 'electron'，可以被 vitest 直接测——index.ts 本身
// 依赖 electron 运行时（BrowserWindow/app/...），没有 mock 的情况下没法在 vitest（node
// 环境）里加载，不值得为了测这一小段纯函数去搭一套 electron mock

import { HEARTBEAT_INTERVAL_MS, EVENTS_CLIENT_TIMEOUT_MS } from '../../shared/eventsLiveness.js'

// 心跳间隔、客户端判定连接死亡的超时阈值（3 倍心跳间隔）：数值本身定义在
// shared/eventsLiveness.ts，这里重新导出供 index.ts 使用。⚠️ 此前这两个常数是本文件与
// services/core/events/broadcast.ts 各自独立维护的一份字面量（注释里写着"两侧各自独立
// 定义、不互相 import……改动服务端那个常数时需要记得同步改这里"）——这次改动把它们收拢到
// shared/eventsLiveness.ts，三层（services/core、electron/main、两个渲染进程窗口）现在都是
// 货真价实的 import，不再各自维护一份、靠人记住要一起改。EVENTS_CLIENT_TIMEOUT_MS 仍然只是
// 派生值，不允许在任何一层独立写死
export { HEARTBEAT_INTERVAL_MS, EVENTS_CLIENT_TIMEOUT_MS }

// ⚠️ 这个函数曾经的用途、以及为什么改掉：原名 shouldConverge，曾被用作"是否触发一次全量
// 收敛"的网关——generation 不变就跳过收敛。Review 中发现这是个设计错误：generation 只能
// 回答"核心服务进程是否重启过"，回答不了"这条连接断线期间是否错过了一次广播"——这是两种
// 不同的过期成因，网关只覆盖了第一种。具体的洞：核心服务本身没重启（generation 不变），
// 只是这条 SSE 连接自己短暂掉线又重连，期间用户在设置窗口切换了置顶模式/改了白名单黑名单，
// broadcastEvent 广播出的 window-behavior-changed 帧恰好发生在断线期间——SSE 没有重放，
// 服务端也不缓冲，这一帧永远收不到。重连后 generation 没变 ⇒ 网关判定"不需要收敛" ⇒
// electron/main/windowBehavior.ts 的 cachedConfig 从此停在旧值，直到应用重启或下一次真的
// 发生同类广播（可能很久都不发生）——期间没有任何自我纠正的机会。现在收敛已经改成"每次
// 连接建立（含每一次重连）都无条件跑一次"（见 index.ts connectToCoreEvents 里 didConnect
// 之后紧跟的 converge() 调用），这个函数不再决定是否收敛，只保留下来做诊断：判断核心服务
// 是否换过一个新进程，仅用于打一行日志辅助排障，因此改名为 hasServerRestarted 以准确反映
// 它现在唯一剩下的含义
//
// 语义：从未见过任何 generation（lastSeenGeneration 为 null，本进程冷启动后第一次看到）
// 不算"重启"——没有"上一次"可比较，只是第一次观测，返回 false；只有"确实见过一个
// generation，而这次看到的不一样"才算重启，返回 true
export function hasServerRestarted(lastSeenGeneration: string | null, incomingGeneration: string): boolean {
  return lastSeenGeneration !== null && lastSeenGeneration !== incomingGeneration
}
