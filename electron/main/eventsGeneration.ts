// electron/main/eventsGeneration.ts — core /events 的 generation 重启判定，并转出事件流心跳相关常量
// 用法：hasServerRestarted(上次见到的 generation, 本次 generation) 供 coreEventsConsumer 判断；index.ts 用 EVENTS_CLIENT_TIMEOUT_MS 做断流看门狗；HEARTBEAT_INTERVAL_MS 与其一并从 shared/eventsLiveness.ts 转出
// 对应文件：shared/eventsLiveness.ts / electron/main/coreEventsConsumer.ts / electron/main/index.ts / electron/main/eventsGeneration.test.ts

import { HEARTBEAT_INTERVAL_MS, EVENTS_CLIENT_TIMEOUT_MS } from '../../shared/eventsLiveness.js'

export { HEARTBEAT_INTERVAL_MS, EVENTS_CLIENT_TIMEOUT_MS }

export function hasServerRestarted(lastSeenGeneration: string | null, incomingGeneration: string): boolean {
  return lastSeenGeneration !== null && lastSeenGeneration !== incomingGeneration
}
