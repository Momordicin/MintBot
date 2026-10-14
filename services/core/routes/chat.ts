// services/core/routes/chat.ts — 一轮聊天：建上下文、调模型，经 SSE 把回复交给发起请求的窗口
// 用法：core/index.ts 注册 chatRoutes；POST /chat { message }
// 对应文件：src/chat/ChatWindow.tsx / services/core/context/buildContext.ts / services/core/routes/chat.test.ts
import type { FastifyInstance } from 'fastify'
import type { OutgoingHttpHeaders } from 'node:http'
import { requireCurrentState } from '../session/index.js'
import { buildContext } from '../context/buildContext.js'
import { parseSelfEmotion, parseEmoteTag } from '../session/emotion.js'
import { selectEmoteFile } from '../characters/emotePool.js'
import { upsertEmotionState, sessionExists, appendExchange } from '../session/queries.js'
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

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
const CONFIG_ERROR_PATTERN = /^Unknown model provider type:|^\[ModelProvider\] .*(modelName is required|API key is not configured|API key environment variable is not available)|^Could not resolve authentication method|^\[Config\] modelProvider is not configured/

const ENV_KEY_UNAVAILABLE_PATTERN = /^\[ModelProvider\] .*API key environment variable is not available/

function isModelStartupFailure(err: unknown): boolean {
  if (err instanceof Error && CONFIG_ERROR_PATTERN.test(err.message)) return true
  let current: unknown = err
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true
    current = current.cause
  }
  return false
}

function logChatError(label: string, err: unknown, message: string): void {
  if (isModelStartupFailure(err)) {
    console.error(label, err)
    return
  }
  console.error(label, err, `(userMessage=${JSON.stringify(message)})`)
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
    const sentAt = Date.now()

    const abortController = new AbortController()
    reply.raw.once('close', () => abortController.abort())

    await enqueue(async () => {
      if (reply.raw.destroyed || reply.raw.writableEnded || abortController.signal.aborted) {
        return
      }

      const send = (event: string, data: unknown) => {
        if (reply.raw.writableEnded || reply.raw.destroyed) return
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const openStream = () => {
        reply.hijack()
        reply.raw.writeHead(200, {
          ...(reply.getHeaders() as OutgoingHttpHeaders),
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })
        reply.raw.flushHeaders()
      }

      const rejectDeletedSession = () => {
        openStream()
        send('system', { type: 'error', payload: { message: 'Session deleted' }, sessionId })
        reply.raw.end()
      }

      if (!sessionExists(sessionId)) {
        rejectDeletedSession()
        return
      }

      let context
      try {
        context = await buildContext(message, { embedding: fastify.embeddingProvider, signal: abortController.signal })
      } catch (err) {
        if (reply.raw.destroyed || reply.raw.writableEnded || abortController.signal.aborted) {
          return
        }
        logChatError('[Chat] buildContext failed:', err, message)
        return reply.status(500).send({ error: 'Failed to build context' })
      }

      if (reply.raw.destroyed || reply.raw.writableEnded || abortController.signal.aborted) {
        return
      }

      if (!sessionExists(sessionId)) {
        rejectDeletedSession()
        return
      }

      openStream()

      const streaming = fastify.streamingEnabled

      try {
        const modelProviderConfig = getModelProviderConfig()
        const modelProvider = createModelProviderForPreset(state.preset, modelProviderConfig, state.credentials)
        const modelType = state.preset.modelType ?? modelProviderConfig.type

        let fullReply = ''

        if (streaming) {
          for await (const chunk of modelProvider.complete(context, { maxTokens: modelProviderConfig.maxTokens, signal: abortController.signal, jsonMode: true })) {
            fullReply += chunk
          }
        } else {
          fullReply = await modelProvider.completeSync(context, { maxTokens: modelProviderConfig.maxTokens, signal: abortController.signal, jsonMode: true })
        }

        if (abortController.signal.aborted) {
          return
        }

        if (!sessionExists(sessionId)) {
          send('system', { type: 'error', payload: { message: 'Session deleted' }, sessionId })
          return
        }

        let replyText = fullReply

        const parsed = parseJsonSalvage(fullReply) as any
        replyText = parsed?.reply ?? fullReply

        if (isEmptyReply(replyText)) {
          console.error(
            `[Chat] Empty reply body (sessionId=${sessionId}, modelType=${modelType}): ` +
            JSON.stringify(fullReply)
          )
          send('system', { type: 'error', payload: { message: 'Model call failed' }, sessionId })
          return
        }

        const messageId = appendExchange(sessionId, message, sentAt, replyText)

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
        if (!abortController.signal.aborted) {
          logChatError('[Chat] Error:', err, message)
        }
        const errorMessage = err instanceof Error && ENV_KEY_UNAVAILABLE_PATTERN.test(err.message)
          ? 'API key 无效或未配置'
          : 'Model call failed'
        send('system', { type: 'error', payload: { message: errorMessage }, sessionId })
      } finally {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          reply.raw.end()
        }
      }
    })
  })
}