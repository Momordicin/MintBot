// electron/main/reconnectBackoff.ts — 主进程重连 core 事件流时的退避间隔
// 用法：nextReconnectDelayMs(上次间隔) 返回下次间隔（翻倍，封顶 RECONNECT_BACKOFF_CAP_MS）；起始值为 RECONNECT_BACKOFF_FLOOR_MS
// 对应文件：electron/main/index.ts（subscribeToCoreEvents）/ electron/main/reconnectBackoff.test.ts

export const RECONNECT_BACKOFF_FLOOR_MS = 1000

export const RECONNECT_BACKOFF_CAP_MS = 30000

export function nextReconnectDelayMs(previousDelayMs: number): number {
  return Math.min(previousDelayMs * 2, RECONNECT_BACKOFF_CAP_MS)
}
