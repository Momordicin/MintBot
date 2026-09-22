import type { FastifyInstance } from 'fastify'
import { requireCurrentState, addMessage } from '../session/index.js'
import { buildContext } from '../context/buildContext.js'
import { parseSelfEmotion, parseEmoteTag } from '../session/emotion.js'
import { selectEmoteFile } from '../characters/emotePool.js'
import { upsertEmotionState } from '../session/queries.js'
import { recordAttention, markExplicitSleep, isExplicitSleep } from '../session/attention.js'
import { broadcastEvent } from '../events/broadcast.js'
import { createModelProviderForPreset } from '../providers/ModelProvider.js'
import { getModelProviderConfig } from '../config/index.js'
import { isEmptyReply } from '../reply/interceptor.js'
import { detectSleepiness } from '../reply/sleepDetector.js'
import { parseJsonSalvage } from '../util/jsonSalvage.js'

let queueTail: Promise<void> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queueTail.then(task)
  queueTail = result.then(() => undefined, () => undefined) 
  return result 
}

export async function chatRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { message: string }
  }>('/chat', async (request, reply) => {

    const { message } = request.body
    if (!message?.trim()) {
      return reply.status(400).send({ error: 'message is required' })
    }

    let state
    try {
      state = requireCurrentState()
    } catch {
      return reply.status(503).send({ error: 'No active session' })
    }

    const sessionId = state.session.sessionId

    const abortController = new AbortController()
    reply.raw.once('close', () => abortController.abort())

    await enqueue(async () => {
      if (reply.raw.destroyed || reply.raw.writableEnded || abortController.signal.aborted) {
        return
      }

      let context
      try {
        context = await buildContext(message, { embedding: fastify.embeddingProvider, signal: abortController.signal })
      } catch (err) {
        if (reply.raw.destroyed || reply.raw.writableEnded || abortController.signal.aborted) {
          return
        }
        console.error('[Chat] buildContext failed:', err)
        return reply.status(500).send({ error: 'Failed to build context' })
      }

      if (reply.raw.destroyed || reply.raw.writableEnded || abortController.signal.aborted) {
        return
      }

      addMessage(sessionId, 'user', message, 'user')

      const modelProviderConfig = getModelProviderConfig()
      const modelProvider = createModelProviderForPreset(state.preset, modelProviderConfig)
      const modelType = state.preset.modelType ?? modelProviderConfig.type

      reply.raw.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
      reply.raw.setHeader('Content-Type', 'text/event-stream')
      reply.raw.setHeader('Cache-Control', 'no-cache')
      reply.raw.setHeader('Connection', 'keep-alive')
      reply.raw.flushHeaders()

      const send = (event: string, data: unknown) => {
        if (reply.raw.writableEnded || reply.raw.destroyed) return
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const streaming = fastify.streamingEnabled

      try {
        let fullReply = ''

        if (streaming) {
          for await (const chunk of modelProvider.complete(context, { maxTokens: modelProviderConfig.maxTokens, signal: abortController.signal, jsonMode: true })) {
            fullReply += chunk
          }
        } else {
          fullReply = await modelProvider.completeSync(context, { maxTokens: modelProviderConfig.maxTokens, signal: abortController.signal, jsonMode: true })
        }

        let replyText = fullReply

        const parsed = parseJsonSalvage(fullReply) as any
        replyText = parsed?.reply ?? fullReply

        if (isEmptyReply(replyText)) {
          console.error(
            `[Chat] Empty reply body (sessionId=${sessionId}, modelType=${modelType}): ` +
            JSON.stringify(fullReply.slice(0, 200))
          )
          send('system', { type: 'error', payload: { message: 'Model call failed' }, sessionId })
          return
        }

        const messageId = addMessage(sessionId, 'assistant', replyText, 'user')

        recordAttention(sessionId)

        if (detectSleepiness(replyText)) {
          markExplicitSleep(sessionId)
        }

        const emoteTag = parseEmoteTag(fullReply)
        const emoteFile = selectEmoteFile(emoteTag, state.manifest)

        send('message_done', {
          messageId: String(messageId),
          text: replyText,
          sessionId,
          ...(emoteFile ? { emote: emoteFile } : {}),
        })

        const selfEmotion = parseSelfEmotion(fullReply)
        const isSleep = selfEmotion?.label === 'sleep'
        if (selfEmotion && !isSleep) {
          try {
            upsertEmotionState(sessionId, { self: selfEmotion, perceived_user: null })
          } catch (err) {
            console.error('[Chat] Failed to persist emotion state:', err)
          }
        }

        const emotionPayload = {
          sessionId,
          explicitSleep: isExplicitSleep(sessionId),
          ...(isSleep ? {} : { self: selfEmotion, perceived_user: null }),
        }

        send('emotion', emotionPayload)

        broadcastEvent('emotion', emotionPayload)

      } catch (err) {
        console.error('[Chat] Error:', err)
        send('system', { type: 'error', payload: { message: 'Model call failed' }, sessionId })
      } finally {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          reply.raw.end()
        }
      }
    })
  })
}