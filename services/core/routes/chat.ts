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
      const modelProviderConfig = getModelProviderConfig()
      const modelProvider = createModelProviderForPreset(state.preset, modelProviderConfig)
      // 拦截类命中时的日志需要"模型类型"（TDD §3.8「拦截类」第 1 条：带上 sessionId、模型
      // 类型、原始输出截断片段），实际生效的类型是 preset 覆盖优先、否则回落全局配置，
      // 与 createModelProviderForPreset 内部判定一致
      const modelType = state.preset.modelType ?? modelProviderConfig.type

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
          // 模型没有返回 JSON，直接用原文——§3.9 既有降级风格保持不变：拦截类只挡空正文，
          // 不要求回复必须是合法 JSON（TDD §3.8「与 §3.9 降级风格的边界」）
        }

        // ─── 回复检查·拦截类（TDD §3.8「回复检查」）：reply 正文去掉首尾空白后为空则不入库。
        // 命中时三件事一起做：console.error 定位是哪个模型哪次调用返的空、不 addMessage
        // （连带不落情绪、不发 message_done）、发一条 system 事件——第 3 条是必须的，
        // 不然 message_done 不发，聊天窗口会永远停在"对方输入中"，没有气泡也没有报错，
        // 「不入库」这个正确决定会以「界面卡死」的形式暴露给用户 ───
        if (isEmptyReply(replyText)) {
          console.error(
            `[Chat] Empty reply body (sessionId=${sessionId}, modelType=${modelType}): ` +
            JSON.stringify(fullReply.slice(0, 200))
          )
          send('system', { type: 'error', payload: { message: 'Model call failed' }, sessionId })
          return
        }

        const messageId = addMessage(sessionId, 'assistant', replyText, 'user')

        // 三种"搭理 bot"交互之一（TDD §3.7 附「悬浮窗立绘状态模型」）：只有产出可用回复的这
        // 一轮才算数——上面 isEmptyReply 命中已经 return，模型抛错走的是下方 catch，都不会
        // 走到这里。必须在 detectSleepiness/markExplicitSleep 之前调用：recordAttention 会
        // 顺带清除显式睡着标记，晚于 markExplicitSleep 调用会把本轮刚置上的标记立刻擦掉
        recordAttention(sessionId)

        // ─── 回复检查·文本检测类（TDD §3.8「回复检查」+ §3.9）：从解析后的 reply 正文（不是
        // 原始 JSON，否则会匹配到 JSON 字段值本身）里识别困意，命中即置显式睡着标记，供悬浮窗
        // 立绘状态模型的 y 求值消费 ───
        if (detectSleepiness(replyText)) {
          markExplicitSleep(sessionId)
        }

        // 表情包挑选（TDD §3.9「表情包挑选机制：模型选 tag，应用选文件」）：parseEmoteTag 只做
        // 结构校验，词表校验 + 随机选文件交给 selectEmoteFile，用请求捕获的 state.manifest
        // （Part A 缓存，零磁盘 I/O）。tag 缺失/不在词表内/过滤后无候选，都降级为不附表情，不报错。
        const emoteTag = parseEmoteTag(fullReply)
        const emoteFile = selectEmoteFile(emoteTag, state.manifest)

        // message_done 带完整文本，前端直接显示，无需累积 chunk
        // Phase 4：句子切割完成后，改为逐句推 message_chunk，前端追加气泡
        // emote 为可选字段：没有选中表情时不带这个 key（不显式发 null/undefined），
        // 前端按"key 是否存在"判断本轮是否附带表情
        // sessionId 为请求 dispatch 时刻捕获的值（见上方常量），不是重新读取的全局当前
        // session——前端据此判断"这条回复是否还属于我现在展示的会话"，是 preset-switched
        // 广播 + syncSessionOnFocus 那套跨窗口切换同步机制的最后一道防线：切换检测本身要经过
        // 两次异步往返（SSE 广播送达 + 再 fetch 一次 /state）才能真正 abort 掉本地的
        // AbortController，这段时间差内旧 session 的模型调用仍可能先一步跑完——纯靠客户端
        // abort 拦不住这种情况，必须由后端把回复真正所属的 session 显式带回去，前端才能在
        // "已经切换完成之后才姗姗来迟"的场景下正确识别并丢弃
        send('message_done', {
          messageId: String(messageId),
          text: replyText,
          sessionId,
          ...(emoteFile ? { emote: emoteFile } : {}),
        })

        // self 情绪校验通过才落库；模型没按格式回复（校验失败/字段缺失）时不落库也不报错，
        // 保持现有降级风格。持久化异常不应影响本轮对话的正常返回
        const selfEmotion = parseSelfEmotion(fullReply)
        // 这不是"词表里的特例分支"，是「x 永不为 sleep」这条不变式的守卫（TDD §3.9「必须
        // 保留的守卫」）：emotionVocabulary 已经不再声明 sleep（本轮 sleep 归位改动），但词表
        // 干净不代表模型不会输出它——sleep 是常见词，角色人设里也常有困倦相关描写，模型仍可能
        // 自发吐出这个 label。看到词表已经"删掉 sleep"就顺手删掉这条守卫，是这里最容易犯的
        // 错误：一旦守卫被撤掉，x 就会变成 sleep，下一轮被 buildContext 当真实情绪喂回模型，
        // 角色会从此一直表现困倦——这正是 §3.9 要避免的后果。
        //
        // 命中时只拦 x：不落 EmotionStates，也不发这次的 emotion 帧（私有流与广播都不发，
        // 见下方 !isSleep 分支）。但**不再** markExplicitSleep——自发的 sleep label 是未定义
        // 行为（词表没声明它，模型输出它没有任何契约保证），不能拿一段未定义行为当触发睡着
        // 的依据。显式睡着标记现在唯一的触发来源是上面的回复检查·文本检测类，那是一条经过
        // 单测覆盖的规则，不是"模型偶尔吐出一个词表外的 label"这种不可预测的行为
        const isSleep = selfEmotion?.label === 'sleep'
        if (selfEmotion && !isSleep) {
          try {
            upsertEmotionState(sessionId, { self: selfEmotion, perceived_user: null })
          } catch (err) {
            console.error('[Chat] Failed to persist emotion state:', err)
          }
        }

        // 帧本身总是发出，isSleep 只决定**要不要带 self**，不再决定要不要发帧。
        // 这个区别很关键：isSleep 这个守卫的职责是「x 永不为 sleep」（TDD §3.9），而 x 只
        // 从 self.label 派生——省掉 self 就已经完全达到目的。此前连整帧一起吞掉，会顺带
        // 把 sessionId / explicitSleep 也吞掉：模型这一轮既被 §3.8 文本检测判为困了、又恰好
        // 自发把 label 标成 sleep 时，标记置上了却一帧不发，悬浮窗要等到下一次阈值轮询才
        // 知道——正是这两个字段要消除的那个洞。两个检测器读的是同一段「角色说自己困了」的
        // 文本，所以这不是随机撞车，而是恰好在最该生效的那一轮撞车。
        //
        // 省的是**整个 self 键**，不是发 self: null。后者会把渲染层的 x 清空，而 TDD §3.9
        // 的推论要求「从睡着唤醒后回落到上一次真实的情绪」——x 必须保留原值。渲染层按
        // 「self 键在不在」决定要不要动 x，与 message_done 的 emote 字段同一约定。
        // 没有合法情绪时 selfEmotion 为 null，仍照常带 self: null（既有降级行为，不受影响）
        //
        // sessionId：请求 dispatch 时刻捕获的值（同 message_done），不是重新读取的当前
        // 全局 session——悬浮窗据此判断这帧是否还属于它当前展示的角色，同一竞态防线。
        // explicitSleep：在此刻（帧即将发出前）读取，而不是请求开始时的快照——上面的
        // detectSleepiness → markExplicitSleep 已经跑完，这里读到的是本轮真正生效的值
        const emotionPayload = {
          sessionId,
          explicitSleep: isExplicitSleep(sessionId),
          // perceived_user：Phase 2 基础版故意留空占位，不透传模型的尝试性输出，不是遗漏
          ...(isSleep ? {} : { self: selfEmotion, perceived_user: null }),
        }

        send('emotion', emotionPayload)

        // 双发，不是迁移（TDD §3.3「SSE 事件类型规范」）：私有流零延迟给请求方本身，
        // 这里额外广播同一份数据给其它窗口（悬浮窗按情绪标签联动立绘）
        broadcastEvent('emotion', emotionPayload)

      } catch (err) {
        // ─── 连接建立后的错误，走 SSE system 事件 ───────────────
        console.error('[Chat] Error:', err)
        // sessionId 同 message_done，供前端识别这条错误是否还属于当前展示的会话
        send('system', { type: 'error', payload: { message: 'Model call failed' }, sessionId })
      } finally {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          reply.raw.end()
        }
      }
    })
  })
}