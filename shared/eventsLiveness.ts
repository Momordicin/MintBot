// GET /events 存活契约的两个常量（docs/MintBot_TDD.md §3.3「存活契约」）。三个消费方——
// services/core 的心跳发送方（events/broadcast.ts）、Electron 主进程的看门狗
// （electron/main/eventsGeneration.ts）、两个渲染进程窗口的看门狗（src/eventsWatchdog.ts，
// 供 ChatWindow.tsx/OverlayApp.tsx 使用）——现在都从这一份定义派生，不再各自维护一份字面值。
//
// ⚠️ 这是本次改动之前遗留的一处真实数字漂移风险，现在关掉：HEARTBEAT_INTERVAL_MS 曾经在
// services/core/events/broadcast.ts 与 electron/main/eventsGeneration.ts 里各自独立写一遍
// 15000（注释里也明确写着"两侧各自独立定义、不互相 import……改动服务端那个常数时需要记得
// 同步改这里"），渲染进程此前甚至完全不参与这套数值——因为它们此前根本不看门狗，见下方
// EVENTS_CLIENT_TIMEOUT_MS 的注释。三层各自维护同一个字面量本来就只是"运行时契约，类型系统
// 保证不了"的权宜之计；现在统一收拢到这一个文件，三层都是货真价实的 import，不再是三份
// 靠人记住要一起改的独立字面量
export const HEARTBEAT_INTERVAL_MS = 15000

// 客户端判定连接死亡的超时阈值：固定 3 倍心跳间隔——允许连续漏两次心跳还不判死，第三次也
// 没等到才真正认为连接已经僵死。由 HEARTBEAT_INTERVAL_MS 派生而不是独立写死 45000，避免
// 两个数字各自维护、日后改一个忘了改另一个而漂移
export const EVENTS_CLIENT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3

// ⚠️ 反转记录：渲染进程此前被记作"已接受的并行缺口"（docs/MintBot_TDD.md §3.3 曾经的
// 「已接受的并行缺口：渲染进程没有对应主进程看门狗的存活自检」一节），理由是同机 loopback
// 场景下这个缺口能覆盖的真实故障窗口极窄，加两份看门狗计时器的维护成本不划算。这个决定
// 已被推翻——不是因为风险评估变了（本机 loopback 的风险确实还是低），而是因为契约一致性：
// 服务端声明了"每 HEARTBEAT_INTERVAL_MS 发一次心跳，专门用来让客户端分辨'安静但健康'与
// '已经僵死'"这条存活契约之后，三个消费方里有两个（两个渲染进程窗口）完全无视这条心跳、
// 只依赖 EventSource 在底层连接真正报错时才自动重连，是"声明了契约、却只有一部分消费方
// 遵守"的不一致状态，不应该长期保留。见 src/eventsWatchdog.ts
