import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { initDb, db } from '../db/index.js'
import { upsertPreset, getEmotionState } from '../session/queries.js'
import * as queries from '../session/queries.js'
import { loadSession } from '../session/index.js'
import { chatRoutes } from './chat.js'
import * as ModelProviderModule from '../providers/ModelProvider.js'
import type { ModelProvider } from '../providers/ModelProvider.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'

initDb()

beforeEach(() => {
  db.exec(`
    DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;
    DELETE FROM message_embeddings; DELETE FROM message_fts; DELETE FROM MessageEntities;
    DELETE FROM EmotionStates;
  `)
  upsertPreset({
    presetId: 'p1',
    name: '角色一',
    characterId: 'char-001',
    modelType: 'ollama',
    modelName: 'qwen3',
    systemPrompt: '你是角色一',
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// 确定性假向量，本测试不依赖 RAG 召回结果，只需满足 EmbeddingProvider 接口类型
function fakeEmbeddingProvider(): EmbeddingProvider {
  return {
    async embed() {
      return new Array(1024).fill(0)
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => new Array(1024).fill(0))
    },
  }
}

// 起一个干净的 Fastify 实例（非 services/core/index.ts 里真实启动的那个），
// 非流式模式（streaming: false）走 completeSync 分支，避免实现 complete 异步生成器。
// chat.ts 现在按请求捕获的 preset 通过 createModelProviderForPreset 现场构建 provider，
// 不再读 fastify.modelProvider 全局单例，因此这里 spy 掉 createModelProviderForPreset
// 而不是直接 decorate modelProvider
async function buildTestApp(fakeReply: string) {
  const fastify = Fastify()
  const fakeModelProvider = {
    completeSync: async () => fakeReply,
  }
  const createSpy = vi.spyOn(ModelProviderModule, 'createModelProviderForPreset')
    .mockReturnValue(fakeModelProvider as unknown as ModelProvider)
  fastify.decorate('config', { streaming: false, modelProvider: { type: 'ollama', ollamaModel: 'qwen3' } })
  fastify.decorate('embeddingProvider', fakeEmbeddingProvider())
  await fastify.register(chatRoutes)
  return { fastify, createSpy }
}

// 把 inject() 返回的 SSE 文本（event: xxx\ndata: {...}\n\n 拼接）拆成 {event, data} 数组，够用即可
function parseSSE(payload: string): Array<{ event: string; data: any }> {
  return payload
    .split('\n\n')
    .filter(chunk => chunk.trim().length > 0)
    .map(chunk => {
      const lines = chunk.split('\n')
      const eventLine = lines.find(l => l.startsWith('event: ')) ?? ''
      const dataLine = lines.find(l => l.startsWith('data: ')) ?? ''
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)),
      }
    })
}

describe('POST /chat', () => {
  it('self 情绪合法且模型尝试输出 perceived_user 时，落库与 SSE 都强制 perceived_user 为 null', async () => {
    const { session } = loadSession('p1')
    const { fastify } = await buildTestApp(JSON.stringify({
      reply: '你好呀',
      emotion: {
        self: { label: 'happy', intensity: 0.8 },
        perceived_user: { label: '???', intensity: 0.5 },
      },
    }))

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const events = parseSSE(response.payload)

    const messageDone = events.find(e => e.event === 'message_done')
    expect(messageDone?.data.text).toBe('你好呀')

    const emotion = events.find(e => e.event === 'emotion')
    expect(emotion?.data).toEqual({ self: { label: 'happy', intensity: 0.8 }, perceived_user: null })

    const stored = getEmotionState(session.sessionId)
    expect(stored?.self).toEqual({ label: 'happy', intensity: 0.8 })
    expect(stored?.perceived_user).toBeNull()
  })

  it('emotion 字段缺失/不合法时，不落库，也不报错，SSE 正常返回', async () => {
    const { session } = loadSession('p1')
    const { fastify } = await buildTestApp(JSON.stringify({ reply: '嗯嗯' }))

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const events = parseSSE(response.payload)

    const emotion = events.find(e => e.event === 'emotion')
    expect(emotion?.data).toEqual({ self: null, perceived_user: null })

    expect(getEmotionState(session.sessionId)).toBeNull()
  })

  it('情绪持久化失败时不影响本轮对话正常返回', async () => {
    loadSession('p1')
    const spy = vi.spyOn(queries, 'upsertEmotionState').mockImplementation(() => {
      throw new Error('db boom')
    })

    try {
      const { fastify } = await buildTestApp(JSON.stringify({
        reply: '你好呀',
        emotion: { self: { label: 'happy', intensity: 0.8 }, perceived_user: null },
      }))

      const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
      const events = parseSSE(response.payload)

      expect(events.find(e => e.event === 'message_done')).toBeDefined()
      expect(events.find(e => e.event === 'system')).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('按请求捕获的 preset 和 fastify.config.modelProvider 构建 provider', async () => {
    const { preset } = loadSession('p1')
    const { fastify, createSpy } = await buildTestApp(JSON.stringify({ reply: '嗯嗯' }))

    await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })

    expect(createSpy).toHaveBeenCalledWith(preset, { type: 'ollama', ollamaModel: 'qwen3' })
  })

  it('客户端提前断开（reply.raw 触发 close）：signal 被传给 provider，断开后不再写入/结束响应', async () => {
    loadSession('p1')

    // onRequest 钩子拿到与 handler 内部同一个 reply 对象的引用，
    // 这样测试代码就能在请求处理过程中手动触发 reply.raw 的 close 事件
    let capturedReply: { raw: import('http').ServerResponse } | undefined
    let onRequestDone: () => void
    const onRequestPromise = new Promise<void>(resolve => { onRequestDone = resolve })

    const fastify = Fastify()
    fastify.decorate('config', { streaming: false, modelProvider: { type: 'ollama', ollamaModel: 'qwen3' } })
    fastify.decorate('embeddingProvider', fakeEmbeddingProvider())
    fastify.addHook('onRequest', (_request, reply, done) => {
      capturedReply = reply
      onRequestDone()
      done()
    })

    // 模拟一个"感知 abort"的 provider：真实的 ModelProvider（走 fetch/Anthropic SDK）在
    // signal 被 abort 时会让请求本身 reject，这里用监听 signal 的 abort 事件来复刻这个行为
    let receivedOptions: { signal?: AbortSignal } | undefined
    let completeSyncCalled: () => void
    const completeSyncCalledPromise = new Promise<void>(resolve => { completeSyncCalled = resolve })
    vi.spyOn(ModelProviderModule, 'createModelProviderForPreset').mockReturnValue({
      completeSync: (_context: unknown, options: { signal?: AbortSignal }) => {
        receivedOptions = options
        completeSyncCalled()
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
      },
    } as unknown as ModelProvider)

    await fastify.register(chatRoutes)

    const injectPromise = fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    injectPromise.catch(() => {}) // 断开场景下不关心最终 settle 结果，避免未处理 rejection 警告
    await onRequestPromise
    // 等 handler 真正调用到 modelProvider.completeSync（拿到 signal）之后再模拟断开，
    // 否则 close 事件可能在 buildContext 等前置异步步骤完成前就触发，signal 还没被传入
    await completeSyncCalledPromise

    const writeSpy = vi.spyOn(capturedReply!.raw, 'write')
    // 真实断连时 Node 会把 destroyed 置位，这里手动模拟同样的状态
    Object.defineProperty(capturedReply!.raw, 'destroyed', { value: true, configurable: true })
    capturedReply!.raw.emit('close')

    expect(receivedOptions?.signal?.aborted).toBe(true)

    // 等 catch/finally 里的微任务跑完
    await new Promise(resolve => setImmediate(resolve))

    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('客户端在 buildContext 执行期间断开：close 监听器注册得足够早，没有错过这个窗口', async () => {
    loadSession('p1')

    let capturedReply: { raw: import('http').ServerResponse } | undefined
    let onRequestDone: () => void
    const onRequestPromise = new Promise<void>(resolve => { onRequestDone = resolve })

    // 可控的假 embeddingProvider：embed() 被调用后阻塞住，直到测试手动放行，
    // 用它模拟 buildContext（RAG 召回）"仍在执行中"的一个窗口
    let embedCalled: () => void
    const embedCalledPromise = new Promise<void>(resolve => { embedCalled = resolve })
    let resolveEmbed: (v: number[]) => void
    const embedPromise = new Promise<number[]>(resolve => { resolveEmbed = resolve })
    const slowEmbeddingProvider: EmbeddingProvider = {
      embed: async () => {
        embedCalled()
        return embedPromise
      },
      embedBatch: async (texts: string[]) => texts.map(() => new Array(1024).fill(0)),
    }

    const fastify = Fastify()
    fastify.decorate('config', { streaming: false, modelProvider: { type: 'ollama', ollamaModel: 'qwen3' } })
    fastify.decorate('embeddingProvider', slowEmbeddingProvider)
    fastify.addHook('onRequest', (_request, reply, done) => {
      capturedReply = reply
      onRequestDone()
      done()
    })

    // 注意：这里必须在 completeSync 被调用的那一刻就把 signal.aborted 拍成一个布尔值快照，
    // 不能只保留 options/signal 的对象引用——signal 是可变对象，请求结束时的正常 close
    // （成功完成后 socket 也会触发一次 close）会让引用的 .aborted 事后变成 true，
    // 掩盖"注册得太晚导致提前断连时根本没被置为 aborted"这个真正要测的 bug
    let abortedAtCallTime: boolean | undefined
    vi.spyOn(ModelProviderModule, 'createModelProviderForPreset').mockReturnValue({
      completeSync: async (_context: unknown, options: { signal?: AbortSignal }) => {
        abortedAtCallTime = options.signal?.aborted
        return JSON.stringify({ reply: '嗯嗯' })
      },
    } as unknown as ModelProvider)

    await fastify.register(chatRoutes)

    // "记得" 命中回忆类关键词，确保 buildContext 内部真的会走到 retrieveMemories → embed()
    const injectPromise = fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你还记得吗' } })
    injectPromise.catch(() => {}) // 手动 emit('close') 会让 light-my-request 判定连接提前断开而 reject，不关心这个 settle 结果

    await onRequestPromise
    // 等 buildContext 真正阻塞在 embed() 调用上（此时请求还没跑到 modelProvider 那一步）
    await embedCalledPromise

    // 模拟客户端在 buildContext 执行期间断开——此时 close 监听器必须已经注册好
    capturedReply!.raw.emit('close')

    // 放行 buildContext，让它跑完，请求继续往下走到 modelProvider.completeSync
    resolveEmbed!(new Array(1024).fill(0))
    // 等 completeSync 被调用的微任务跑完（不等 injectPromise 本身——emit('close') 之后
    // light-my-request 会把它判定为提前断开并 reject，不代表 handler 内部已经跑完）
    await new Promise(resolve => setImmediate(resolve))

    // 断连发生在 buildContext 期间、早于 completeSync 被调用，但 completeSync 被调用那一刻
    // 拿到的 signal 依然应该已经是 aborted——证明 close 监听器注册得足够早，没有错过这个更早的窗口
    expect(abortedAtCallTime).toBe(true)
  })
})
