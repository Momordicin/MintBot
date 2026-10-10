// shared/windowBehavior.ts
// 用途：窗口行为配置的跨进程契约——配置形状与带版本的快照（WindowBehaviorSnapshot），以及消费方
//   统一的"是否接受这份快照"规则 isNewerSnapshot
// 用法：services/core 的配置层与 /config/window-behavior 路由、Electron 主进程（windowBehavior.ts、
//   coreEventsConsumer.ts、index.ts 托盘）、设置窗口（src/settings/WindowBehaviorPanel.tsx）都从这里 import
// 对应方：services/core/config/index.ts 负责递增 revision，services/core/routes/windowBehavior.ts 负责组装快照
export type ChatPinMode = 'always' | 'smart' | 'off'
export type AppRuleEffect = 'allow' | 'soft' | 'hard'

export interface AppRule {
  exeName: string
  effect: AppRuleEffect
}

export interface WindowBehaviorConfig {
  chatPinMode: ChatPinMode
  petAvoidanceEnabled: boolean
  petClickThrough: boolean
  petCollapsed: boolean
  appRules: AppRule[]
}

export interface WindowBehaviorSnapshot {
  generation: string
  revision: number
  config: WindowBehaviorConfig
}

export function isNewerSnapshot(prev: WindowBehaviorSnapshot | null, next: WindowBehaviorSnapshot): boolean {
  if (prev === null) return true
  if (prev.generation !== next.generation) return true
  return next.revision > prev.revision
}
