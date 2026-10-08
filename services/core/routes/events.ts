import type { FastifyInstance } from 'fastify'
import type { OutgoingHttpHeaders } from 'node:http'
import { registerEventsClient, sendHello } from '../events/broadcast.js'

export async function eventsRoutes(fastify: FastifyInstance) {
  fastify.get('/events', async (_request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    reply.raw.flushHeaders()

    registerEventsClient(reply)
    sendHello(reply)
  })
}
