import type { FastifyInstance } from 'fastify'
import { requireCurrentState, addMessage } from '../session/index.js'
import { buildContext } from '../context/buildContext.js'
import { parseSelfEmotion } from '../session/emotion.js'
import { upsertEmotionState } from '../session/queries.js'
import { createModelProviderForPreset } from '../providers/ModelProvider.js'
import type { ModelConfig } from '../../../shared/types/index.js'

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

    // 请求开始时捕获 sessionId，后续所有 addMessage 调用都显式传入这个值，
    // 不管中途是否发生 preset 切换，消息永远正确落在它实际所属的 session 上
    const sessionId = state.session.sessionId

    // 客户端提前断开连接时，底层 http.ServerResponse 会触发 close 事件——用它中断正在进行中
    // 的模型调用：否则服务端会继续跑完整个模型调用，再往一个已经关闭的连接写数据，
    // 轻则白白烧一次完整请求，重则触发未捕获的 error 事件把整个核心服务进程崩掉。
    // 这里要尽早注册（在 buildContext 之前）——buildContext 内的 RAG/embedding 调用往往是
    // 整个请求里最慢的一步，如果断连发生在这期间，注册得晚会错过这个 close 事件，
    // signal 永远不会变成 aborted，模型调用还是会照常发起
    const abortController = new AbortController()
    reply.raw.once('close', () => abortController.abort())

    let context
    try {
      context = await buildContext(message, { embedding: fastify.embeddingProvider })
    } catch {
      return reply.status(500).send({ error: 'Failed to build context' })
    }

    addMessage(sessionId, 'user', message, 'user')

    // 按当前请求捕获的 preset 构建 provider，而不是用全局单例 fastify.modelProvider，
    // 保证并发切换 preset 时本次请求仍使用它开始时的模型配置
    const modelProvider = createModelProviderForPreset(state.preset, fastify.config.modelProvider as ModelConfig)

    reply.raw.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    // 连接已经关闭（客户端提前断开）时不再写入，避免往已关闭的 socket 写数据
    const send = (event: string, data: unknown) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const streaming = (fastify.config?.streaming as boolean) ?? true

    try {
      let fullReply = ''

      if (streaming) {
        // ─── 流式模式：累积 chunk，Phase 4 开放逐句推送 ───────
        for await (const chunk of modelProvider.complete(context, { signal: abortController.signal })) {
          fullReply += chunk
        }
      } else {
        // ─── 非流式模式 ──────────────────────────────────────
        fullReply = await modelProvider.completeSync(context, { signal: abortController.signal })
      }

      // ─── 解析 JSON 回复，取出 reply 文本（emotion 解析见下方 parseSelfEmotion）───
      let replyText = fullReply

      try {
        const parsed = JSON.parse(fullReply)
        replyText = parsed.reply ?? fullReply
      } catch {
        // 模型没有返回 JSON，直接用原文
      }

      const messageId = addMessage(sessionId, 'assistant', replyText, 'user')

      // message_done 带完整文本，前端直接显示，无需累积 chunk
      // Phase 4：句子切割完成后，改为逐句推 message_chunk，前端追加气泡
      send('message_done', { messageId: String(messageId), text: replyText })

      // self 情绪校验通过才落库；模型没按格式回复（校验失败/字段缺失）时不落库也不报错，
      // 保持现有降级风格。持久化异常不应影响本轮对话的正常返回
      const selfEmotion = parseSelfEmotion(fullReply)
      if (selfEmotion) {
        try {
          upsertEmotionState(sessionId, { self: selfEmotion, perceived_user: null })
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
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end()
      }
    }
  })
}