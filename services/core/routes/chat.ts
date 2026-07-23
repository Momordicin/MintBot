import type { FastifyInstance } from 'fastify'
import { requireCurrentState, addMessage } from '../session/index.js'
import { buildContext } from '../context/buildContext.js'
import { parseSelfEmotion } from '../session/emotion.js'
import { upsertEmotionState } from '../session/queries.js'

export async function chatRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { message: string }
  }>('/chat', async (request, reply) => {

    // ─── 前置校验（连接建立前，走 HTTP 错误）───────────────

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

    let context
    try {
      context = await buildContext(message, { embedding: fastify.embeddingProvider })
    } catch {
      return reply.status(500).send({ error: 'Failed to build context' })
    }

    addMessage('user', message, 'user')

    reply.raw.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const streaming = (fastify.config?.streaming as boolean) ?? true

    try {
      let fullReply = ''

      if (streaming) {
        // ─── 流式模式：累积 chunk，Phase 4 开放逐句推送 ───────
        for await (const chunk of fastify.modelProvider.complete(context)) {
          fullReply += chunk
        }
      } else {
        // ─── 非流式模式 ──────────────────────────────────────
        fullReply = await fastify.modelProvider.completeSync(context)
      }

      // ─── 解析 JSON 回复，取出 reply 文本（emotion 解析见下方 parseSelfEmotion）───
      let replyText = fullReply

      try {
        const parsed = JSON.parse(fullReply)
        replyText = parsed.reply ?? fullReply
      } catch {
        // 模型没有返回 JSON，直接用原文
      }

      const messageId = addMessage('assistant', replyText, 'user')

      // message_done 带完整文本，前端直接显示，无需累积 chunk
      // Phase 4：句子切割完成后，改为逐句推 message_chunk，前端追加气泡
      send('message_done', { messageId: String(messageId), text: replyText })

      // self 情绪校验通过才落库；模型没按格式回复（校验失败/字段缺失）时不落库也不报错，
      // 保持现有降级风格。持久化异常不应影响本轮对话的正常返回
      const selfEmotion = parseSelfEmotion(fullReply)
      if (selfEmotion) {
        try {
          upsertEmotionState(state.session.sessionId, { self: selfEmotion, perceived_user: null })
        } catch (err) {
          console.error('[Chat] Failed to persist emotion state:', err)
        }
      }

      send('emotion', {
        self: selfEmotion,
        perceived_user: null,  // Phase 2 基础版故意留空占位，不透传模型的尝试性输出，不是遗漏
      })

    } catch (err) {
      // ─── 连接建立后的错误，走 SSE system 事件 ───────────────
      console.error('[Chat] Error:', err)
      send('system', { type: 'error', payload: { message: 'Model call failed' } })
    } finally {
      reply.raw.end()
    }
  })
}