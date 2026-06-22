import type { FastifyInstance } from 'fastify'
import { requireCurrentState, addMessage } from '../session/index.js'
import { buildContext } from '../context/buildContext.js'

export async function chatRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { message: string }
  }>('/chat', async (request, reply) => {

    // ─── 前置校验（连接建立前，走 HTTP 错误）───────────────

    const { message } = request.body
    if (!message?.trim()) {
      return reply.status(400).send({ error: 'message is required' })
    }

    try {
      requireCurrentState()
    } catch {
      return reply.status(503).send({ error: 'No active session' })
    }

    let context
    try {
      context = await buildContext(message)
    } catch {
      return reply.status(500).send({ error: 'Failed to build context' })
    }

    // ─── 写入用户消息 ──────────────────────────────────────

    addMessage('user', message, 'user')

    // ─── 建立 SSE 连接 ─────────────────────────────────────

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
        // ─── 流式模式 ────────────────────────────────────────
        for await (const chunk of fastify.modelProvider.complete(context)) {
          fullReply += chunk
          send('message_chunk', { text: chunk })
        }
      } else {
        // ─── 非流式模式 ──────────────────────────────────────
        // Phase 后期：全文生成后切割为多段发送
        fullReply = await fastify.modelProvider.completeSync(context)
        send('message_chunk', { text: fullReply })
      }

      // ─── 解析 JSON 回复（emotion 占位）──────────────────────
      let replyText = fullReply
      let emotion = null

      try {
        const parsed = JSON.parse(fullReply)
        replyText = parsed.reply ?? fullReply
        emotion = parsed.emotion ?? null
      } catch {
        // 模型没有返回 JSON，直接用原文
      }

      // ─── 写入 assistant 消息 ─────────────────────────────
      const messageId = addMessage('assistant', replyText, 'user')

      send('message_done', { messageId: String(messageId) })
      send('emotion', {
        self: emotion?.self ?? null,
        perceived_user: emotion?.perceived_user ?? null,
      })

    } catch (err) {
      // ─── 连接建立后的错误，走 SSE system 事件 ───────────────
      send('system', { type: 'error', payload: { message: 'Model call failed' } })
    } finally {
      reply.raw.end()
    }
  })
}