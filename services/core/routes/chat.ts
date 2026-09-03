import type { FastifyInstance } from 'fastify'
import { requireCurrentState, addMessage } from '../session/index.js'
import { buildContext } from '../context/buildContext.js'
import { parseSelfEmotion, parseEmoteTag } from '../session/emotion.js'
import { selectEmoteFile } from '../characters/emotePool.js'
import { upsertEmotionState } from '../session/queries.js'
import { createModelProviderForPreset } from '../providers/ModelProvider.js'
import { getModelProviderConfig } from '../config/index.js'

// ─── 回复队列（单会话场景下的串行化）──────────────────────
// MintBot 同一时刻只有一个 SessionState（services/core/session/index.ts 的 current 是单例，
// 不是按 sessionId 分区的 map），前端也刻意允许用户在回复进行中继续发送新消息，
// 因此 /chat 的实际处理必须整体排成一条全局 FIFO 队列，逐条串行执行，
// 避免并发 buildContext/addMessage/upsertEmotionState 导致的乱序与互相覆盖
let queueTail: Promise<void> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queueTail.then(task)
  queueTail = result.then(() => undefined, () => undefined) // 链条本身永远 resolve，单次失败不会卡住后续任务
  return result // 调用方仍然拿到真实的结果/reject
}

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

    // ─── 实际处理排入全局回复队列，与其它 /chat 请求串行执行 ───────
    await enqueue(async () => {
      // 排队等待期间客户端已经放弃这个请求（提前断连/连接已结束）：轮到它时不再做任何
      // 工作——不发起模型调用，不跑 buildContext，也不写消息，避免为一个没人等待的请求
      // 白白占用队列时间、写入无意义的历史记录
      if (reply.raw.destroyed || reply.raw.writableEnded || abortController.signal.aborted) {
        return
      }

      let context
      try {
        context = await buildContext(message, { embedding: fastify.embeddingProvider, signal: abortController.signal })
      } catch {
        // buildContext 内部的 embedding 调用现在会被客户端断连提前 abort（AbortError），
        // 这种情况下连接本来就已经死了，往一个已关闭/已结束的连接发 500 毫无意义——
        // 只有连接仍存活时才是真正需要告知客户端的 buildContext 失败
        if (reply.raw.destroyed || reply.raw.writableEnded || abortController.signal.aborted) {
          return
        }
        return reply.status(500).send({ error: 'Failed to build context' })
      }

      // buildContext 成功返回不代表连接仍然存活——它内部的 embedding 调用可能已经被
      // 客户端断连触发的 abort 提前打断（走的是上面的 catch 分支之外，vector 检索路径自身
      // 吞掉了 AbortError 并直接返回无 RAG 结果的 context），这种情况下 buildContext 会
      // 正常 return 而不抛错。若这里不再检查一次，就会把一个没人等待的请求的用户消息
      // 永久写入历史记录，却永远不会有对应的 assistant 回复
      if (reply.raw.destroyed || reply.raw.writableEnded || abortController.signal.aborted) {
        return
      }

      addMessage(sessionId, 'user', message, 'user')

      // 按当前请求捕获的 preset 构建 provider，而不是用全局单例 fastify.modelProvider，
      // 保证并发切换 preset 时本次请求仍使用它开始时的模型配置
      const modelProvider = createModelProviderForPreset(state.preset, getModelProviderConfig())

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

      const streaming = fastify.streamingEnabled

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

        // 表情包挑选（TDD §3.9「表情包挑选机制：模型选 tag，应用选文件」）：parseEmoteTag 只做
        // 结构校验，词表校验 + 随机选文件交给 selectEmoteFile，用请求捕获的 state.manifest
        // （Part A 缓存，零磁盘 I/O）。tag 缺失/不在词表内/过滤后无候选，都降级为不附表情，不报错。
        const emoteTag = parseEmoteTag(fullReply)
        const emoteFile = selectEmoteFile(emoteTag, state.manifest)

        // message_done 带完整文本，前端直接显示，无需累积 chunk
        // Phase 4：句子切割完成后，改为逐句推 message_chunk，前端追加气泡
        // emote 为可选字段：没有选中表情时不带这个 key（不显式发 null/undefined），
        // 前端按"key 是否存在"判断本轮是否附带表情
        send('message_done', {
          messageId: String(messageId),
          text: replyText,
          ...(emoteFile ? { emote: emoteFile } : {}),
        })

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
  })
}