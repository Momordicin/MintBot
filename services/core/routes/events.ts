import type { FastifyInstance } from 'fastify'
import { registerEventsClient, sendHello } from '../events/broadcast.js'

export async function eventsRoutes(fastify: FastifyInstance) {
  fastify.get('/events', async (_request, reply) => {
    reply.raw.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    registerEventsClient(reply)
    sendHello(reply)
  })
}
