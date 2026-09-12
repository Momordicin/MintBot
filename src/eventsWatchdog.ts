import { EVENTS_CLIENT_TIMEOUT_MS } from '../shared/eventsLiveness.js'

// GET /events 渲染进程侧的存活看门狗（docs/MintBot_TDD.md §3.3「存活契约」，对称
// electron/main/index.ts connectToCoreEvents 里的同名机制）。
//
// ⚠️ 反转记录：这之前渲染进程完全不消费 hello/heartbeat 帧，只依赖原生 EventSource 在底层
// 连接真正报错时才重连——这被记成"已接受的并行缺口"。这个决定已被推翻，理由不是风险评估
// 变了（同机 loopback 场景下这个缺口能覆盖的真实故障窗口本来就窄），而是契约一致性：服务端
// 声明了"每 HEARTBEAT_INTERVAL_MS 发一次心跳，专门用来分辨'安静但健康'与'已经僵死'"这条
// 存活契约之后，不应该只有主进程一个消费方遵守它。见 shared/eventsLiveness.ts 顶部注释。
//
// 语义与主进程完全同款："任意一帧（不区分具体 event 名）都重置一次定时器，
// EVENTS_CLIENT_TIMEOUT_MS（3 倍心跳间隔）内什么都没收到才判定连接已死"——判死后主动
// close() 掉旧连接、再 new 一个新的。close() 之后 readyState 变为 CLOSED，WHATWG 规范
// 原文："the user agent will not attempt to reconnect"：浏览器内建的自动重连在这里被
// 主动掐断，不会与看门狗重建出来的这一条新连接并存/打架。
//
// 两个渲染进程窗口（ChatWindow.tsx/OverlayApp.tsx）除了各自的领域事件监听器
// （preset-switched/emotion）与 onOpen 收敛回调不同，其余的连接创建/监听器挂载/看门狗重建
// 全部一致——统一收拢成这一个工厂：调用方只需要声明"关心哪些事件、连接建立时做什么"，
// "重建时忘了重新挂某个监听器"这类问题因此从"需要小心"变成结构上不可能发生（重建复用同一个
// connect()，不是在两处分别手写一遍）
export interface WatchdogEventSourceOptions {
  url: string
  // 领域事件监听器：调用方自己的业务处理（如 preset-switched/emotion）——每次新建连接
  // （含首次连接与看门狗触发的重建）都会被自动重新挂载，调用方不需要关心这件事
  listeners: Record<string, (event: MessageEvent) => void>
  // 连接建立时（首次连接、EventSource 自身的自动重连、看门狗触发的重建，三者都算）都要调用
  // 一次的收敛回调，直接挂在 onopen 上
  onOpen: () => void
}

export interface WatchdogEventSource {
  // 卸载时调用一次：停掉看门狗定时器、关闭当前这一条连接（不论它是首次建立的还是看门狗已经
  // 重建过若干次之后的最新一条）。调用之后这个实例上不会再有任何回调触发——close() 本身是
  // 同步生效的，且下面的 closed 标记会挡住任何已经排队、但还没触发的看门狗回调
  close: () => void
}

export function createWatchdogEventSource(options: WatchdogEventSourceOptions): WatchdogEventSource {
  let source: EventSource
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  function rearm(): void {
    if (closed) return
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(rebuild, EVENTS_CLIENT_TIMEOUT_MS)
  }

  function connect(): void {
    source = new EventSource(options.url)
    // hello/heartbeat 只负责重置看门狗，不做任何收敛——收敛只在 onopen 里发生一次
    // （TDD §3.3「服务器代次与状态收敛」：收敛按连接建立触发，不按帧内容触发，同一条不变式
    // 也是主进程 coreEventsConsumer.ts 的 onConnected()/onChunk() 结构要保证的那件事）
    source.addEventListener('hello', rearm)
    source.addEventListener('heartbeat', rearm)
    for (const [event, handler] of Object.entries(options.listeners)) {
      source.addEventListener(event, (e: Event) => {
        rearm()
        handler(e as MessageEvent)
      })
    }
    source.onopen = () => {
      rearm()
      options.onOpen()
    }
    // 连接刚建立本身也算"收到了活动"，立即上一次弦——不能让"新连接建立后、第一帧真正到达前"
    // 这段间隙被误判为已经僵死（与主进程 connectToCoreEvents 拿到 reader 后立即 armWatchdog()
    // 同一个理由）
    rearm()
  }

  function rebuild(): void {
    if (closed) return
    source.close()
    connect()
  }

  connect()

  return {
    close(): void {
      closed = true
      if (watchdogTimer !== undefined) clearTimeout(watchdogTimer)
      source.close()
    },
  }
}
