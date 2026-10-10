// src/eventsWatchdog.ts — 渲染进程订阅 core GET /events 的 EventSource 封装，带存活看门狗
// 用法：createWatchdogEventSource({ url, listeners, onOpen }) 返回 { close }；ChatWindow、OverlayApp、WindowBehaviorPanel 使用
// 对应文件：shared/eventsLiveness.ts / services/core/routes/events.ts / services/core/events/broadcast.ts
import { EVENTS_CLIENT_TIMEOUT_MS } from '../shared/eventsLiveness.js'

export interface WatchdogEventSourceOptions {
  url: string
  listeners: Record<string, (event: MessageEvent) => void>
  onOpen: () => void
}

export interface WatchdogEventSource {
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
