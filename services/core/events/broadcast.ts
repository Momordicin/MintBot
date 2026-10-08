import type { FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { HEARTBEAT_INTERVAL_MS } from '../../../shared/eventsLiveness.js'

const clients = new Set<FastifyReply>()

export const SERVER_GENERATION = randomUUID()

export { HEARTBEAT_INTERVAL_MS }

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

function startHeartbeatIfNeeded(): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    broadcastEvent('heartbeat', { generation: SERVER_GENERATION })
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref()
}

function stopHeartbeatIfIdle(): void {
  if (clients.size > 0) return
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

export function registerEventsClient(reply: FastifyReply): void {
  clients.add(reply)
  reply.raw.on('close', () => {
    clients.delete(reply)
    stopHeartbeatIfIdle()
  })
  startHeartbeatIfNeeded()
}

function formatFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function sendHello(reply: FastifyReply): void {
  if (reply.raw.writableEnded || reply.raw.destroyed) return
  try {
    reply.raw.write(formatFrame('hello', { generation: SERVER_GENERATION }))
  } catch (err) {
    console.error('[Events] Failed to write hello frame to a new client:', err)
  }
}

export function broadcastEvent(event: string, data: unknown): void {
  const payload = formatFrame(event, data)
  for (const reply of clients) {
    if (reply.raw.writableEnded || reply.raw.destroyed) {
      clients.delete(reply)
      stopHeartbeatIfIdle()
      continue
    }
    try {
      reply.raw.write(payload)
    } catch (err) {
      console.error('[Events] Failed to write to a broadcast client, dropping it:', err)
      clients.delete(reply)
      stopHeartbeatIfIdle()
    }
  }
}
