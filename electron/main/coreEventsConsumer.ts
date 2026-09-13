// GET /events 的帧解析/分发 + 连接建立时"收敛恰好一次"的编排（TDD §3.3「hello / heartbeat」、
// 「服务器代次与状态收敛」）。从 index.ts 的 connectToCoreEvents 里抽出来的唯一理由是这部分
// 不需要真实 Electron 运行时（不 import 'electron'），可以被 vitest 直接测——理由同
// reconnectBackoff.ts/eventsGeneration.ts，但这是本仓库第一个把"主进程 wiring"本身而不是纯
// 计算辅助函数抽成可测模块的先例：之所以值得为这一块单独破例，是因为这里保护的是两处真实
// 出过（或差点出过）的回归——① converge() 被重新按 generation 网关起来（已经犯过一次、
// review 中发现设计错误撤回，见 eventsGeneration.ts 顶部注释）；② converge() 被错挂到
// hello/heartbeat 分支上，从"每次连接一次"变成"每 15 秒一次"——且此前有过 sanity check
// 证实这两种回归都不会让现有测试套件变红，需要专门的测试钉住。
//
// 边界为什么切在这里，不再往下：fetch 调用本身、AbortController + 看门狗定时器、reader 循环、
// 断线重连退避循环，这几块离开真实的网络/Electron 运行时没法有意义地测（mock 出来的"测试"
// 只是在验证 mock 本身），因此继续留在 index.ts；但"收敛只在连接建立时触发一次、不会被帧
// 内容误触发"这条不变式必须被测试覆盖，而它此前恰好横跨在 index.ts 里 fetch/reader 循环与
// 帧处理逻辑的中间，导致整体都没法测。这里把"连接建立"与"逐帧处理"各自的编排收拢成
// onConnected()/onChunk() 两个方法：调用方（index.ts）只负责在合适的时机各调一次/多次，
// 不再需要知道 converge() 具体挂在哪一步。
//
// 状态生命周期：调用方应当只创建一个实例，贯穿整个 subscribeToCoreEvents 重连循环（不是
// 每次连接尝试各建一个）。lastSeenCoreGeneration 需要跨重连持久化——它记录的是"曾经见过的
// 核心服务代次"，用于诊断"是否换过一个新进程"，这个判断本身就需要跨连接记忆；而 buffer
// 需要在 onConnected() 里显式清空——上一条连接如果在帧中途断线，遗留的半帧数据属于那条已经
// 作废的连接，绝不能被拼进下一条连接的字节流里，否则会产生错位的假帧。

import { hasServerRestarted } from './eventsGeneration'

// 主进程本地类型：跟 index.ts/windowBehavior.ts 同样的独立定义约定（各自维护一份，不互相
// import），理由见 index.ts 顶部 WindowBehaviorConfig 处的注释。
//
// Stage 4（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"配置模型拆分"一节）：pinMode 拆成
// chatPinMode/petAvoidanceEnabled 两个独立概念，fullscreenWhitelist/blacklist 合并成一张
// 每应用一条规则的 appRules 表，见 windowBehavior.ts/displayStateMap.ts 同名类型定义处的注释
export interface WindowBehaviorConfig {
  chatPinMode: 'always' | 'smart' | 'off'
  petAvoidanceEnabled: boolean
  appRules: Array<{ exeName: string; effect: 'allow' | 'soft' | 'hard' }>
}

export interface CoreEventsConsumerHandlers {
  // 连接建立时（含每一次重连）需要无条件跑一次的收敛动作——注入而非在本模块里直接实现，
  // 因为它的具体内容（读 GET /state、GET /config/window-behavior、刷新图标/托盘菜单）
  // 全部依赖 Electron 运行时，见 index.ts 的 converge()
  converge: () => void
  onPresetSwitched: () => void
  onWindowBehaviorChanged: (config: WindowBehaviorConfig) => void
  log: {
    // 核心服务代次变化的诊断日志——纯粹的排障信息，不触发任何行为（generation 不再是
    // 收敛的网关，见 eventsGeneration.ts 顶部注释）
    generationChanged: () => void
    helloHeartbeatParseError: (err: unknown) => void
    windowBehaviorParseError: (err: unknown) => void
  }
}

export interface CoreEventsConsumer {
  // 每次连接建立（含每一次重连）调用一次：清空跨连接残留的半帧缓冲，并无条件触发一次收敛。
  // 不依赖也不判断 generation——见上方模块头注释「①②」两处历史回归
  onConnected: () => void
  // 每收到一段解码后的文本就调用一次：内部按 '\n\n' 拆帧，凑齐一整帧才分发，帧内容可以
  // 跨多次 onChunk 调用拼接（SSE 帧与 TCP/HTTP chunk 边界本来就不对齐）
  onChunk: (text: string) => void
}

export function createCoreEventsConsumer(handlers: CoreEventsConsumerHandlers): CoreEventsConsumer {
  let buffer = ''
  let lastSeenCoreGeneration: string | null = null

  function dispatchFrame(frame: string): void {
    // 按行精确匹配 event 字段，不用整帧 substring 搜索——避免未来事件名共享前缀（如假设的
    // preset-switched-ack）或 data 载荷文本恰好包含这段字符串时误判
    const lines = frame.split('\n')
    if (lines.some(line => line === 'event: hello' || line === 'event: heartbeat')) {
      const dataLine = lines.find(line => line.startsWith('data: '))
      if (dataLine) {
        try {
          const { generation } = JSON.parse(dataLine.slice('data: '.length)) as { generation: string }
          // 纯诊断：generation 不再是收敛的触发条件（收敛已经在 onConnected() 里无条件跑过
          // 一次），这里只在核心服务确实换过一个新进程时打一行日志，帮助排查"为什么置顶
          // 策略/图标看起来被重置了"这类问题——真正的收敛不依赖这条日志
          if (hasServerRestarted(lastSeenCoreGeneration, generation)) {
            handlers.log.generationChanged()
          }
          lastSeenCoreGeneration = generation
        } catch (err) {
          handlers.log.helloHeartbeatParseError(err)
        }
      }
    }
    if (lines.some(line => line === 'event: preset-switched')) {
      handlers.onPresetSwitched()
    }
    if (lines.some(line => line === 'event: window-behavior-changed')) {
      const dataLine = lines.find(line => line.startsWith('data: '))
      if (dataLine) {
        try {
          handlers.onWindowBehaviorChanged(JSON.parse(dataLine.slice('data: '.length)) as WindowBehaviorConfig)
        } catch (err) {
          handlers.log.windowBehaviorParseError(err)
        }
      }
    }
  }

  return {
    onConnected(): void {
      // 上一条连接的残留半帧作废，见模块头注释
      buffer = ''
      // 故意不挂在 hello/heartbeat 分支上——hello 只在连接刚建立时来一次没问题，但
      // heartbeat 每 HEARTBEAT_INTERVAL_MS（15s）就会重发一次，挂在那个分支上会变成
      // 每 15 秒收敛一次，而不是每次连接一次。同样不依赖 generation 是否变化——见
      // eventsGeneration.ts 顶部注释「二次反转记录」
      handlers.converge()
    },
    onChunk(text: string): void {
      buffer += text
      let frameEnd = buffer.indexOf('\n\n')
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd)
        buffer = buffer.slice(frameEnd + 2)
        dispatchFrame(frame)
        frameEnd = buffer.indexOf('\n\n')
      }
    }
  }
}
