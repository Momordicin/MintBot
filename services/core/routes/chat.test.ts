import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import type { FastifyReply } from 'fastify'
import { initDb, db } from '../db/index.js'
import { decrypt } from '../db/crypto.js'
import { upsertPreset, getEmotionState } from '../session/queries.js'
import * as queries from '../session/queries.js'
import { loadSession, getHistory } from '../session/index.js'
import { getLastAttentionAt, isExplicitSleep, markExplicitSleep, recordAttention } from '../session/attention.js'
import { chatRoutes } from './chat.js'
import * as ModelProviderModule from '../providers/ModelProvider.js'
import * as BuildContextModule from '../context/buildContext.js'
import * as BroadcastModule from '../events/broadcast.js'
import type { ModelProvider } from '../providers/ModelProvider.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'

// emotion 双发（TDD §3.3）：私有流照常发送，broadcastEvent 只是额外调用，本文件不关心
// broadcast.ts 自己的注册表/写入机制（那是 broadcast.test.ts 的职责），这里只验证 chat.ts
// 确实调用了它、且 payload 与私有流一致
vi.mock('../events/broadcast.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../events/broadcast.js')>()
  return { ...actual, broadcastEvent: vi.fn() }
})

// chat.ts 内部读取 getModelProviderConfig()（原来的 fastify.config.modelProvider）；
// buildContext.ts（chat.ts 内部调用）也依赖同一个 config 模块的 getMemoryConfig()——
// mock 整个模块时两者都要提供，否则 buildContext.ts 拿到的 getMemoryConfig 会是 undefined
vi.mock('../config/index.js', () => ({
  getModelProviderConfig: vi.fn(() => ({ type: 'ollama', ollamaModel: 'qwen3' })),
  getMemoryConfig: vi.fn(() => ({
    recentTrackMaxMessages: 50,
    recentTrackMaxMinutes: 30,
    organizeWindowStartHour: 22,
    organizeWindowEndHour: 8,
    summaryTrigger: { pendingCountThreshold: 100, oldestPendingAgeMinutes: 120, messageCountThreshold: 50, lockScreenMinutes: 60 },
    contextBudget: { total: 8000, systemPrompt: 1000, summary: 1500, rag: 2000, recentMessages: 3000, responseReserve: 500 },
  })),
}))

// 表情包挑选（Part E）端到端测试需要不依赖真实磁盘 fixture 的、词表/资源池形状可控的角色包
// manifest——两个虚构 characterId 分别覆盖"唯一匹配"与"多个匹配（验证随机分支落在候选集合内）"
// 两种候选数量；其余 characterId（如 char-001）透传给真实的 loadCharacterManifest，
// 保持"无 manifest 目录 → null" 这条既有降级路径不变
vi.mock('../characters/manifest.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../characters/manifest.js')>()
  const fakeManifest = (overrides: Partial<import('../characters/manifest.js').CharacterManifest>): import('../characters/manifest.js').CharacterManifest => ({
    schemaVersion: 2, name: '', displayName: '', description: '', tags: [], creator: '', version: '', creatorNotes: '', avatar: '',
    userAvatar: '',
    emotionVocabulary: [], emoteTagVocabulary: [],
    portraits: { pixel: { fallback: '', emotions: {} }, illustration: { fallback: '', emotions: {} } },
    interactionStates: {}, reservedStates: {}, emotePool: [], transitions: {},
    ...overrides,
  })
  return {
    ...actual,
    loadCharacterManifest: (characterId: string) => {
      if (characterId === 'char-single-emote') {
        return fakeManifest({
          emoteTagVocabulary: ['comforting'],
          emotePool: [{ file: 'emotes/hug.jpg', tags: ['comforting'] }],
        })
      }
      if (characterId === 'char-multi-emote') {
        return fakeManifest({
          emoteTagVocabulary: ['playful'],
          emotePool: [{ file: 'emotes/a.jpg', tags: ['playful'] }, { file: 'emotes/b.jpg', tags: ['playful'] }],
        })
      }
      return actual.loadCharacterManifest(characterId)
    },
  }
})

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
    async unload() { return true },
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
  fastify.decorate('streamingEnabled', false)
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
    expect(emotion?.data).toEqual({
      self: { label: 'happy', intensity: 0.8 },
      perceived_user: null,
      sessionId: session.sessionId,
      explicitSleep: false,
    })

    const stored = getEmotionState(session.sessionId)
    expect(stored?.self).toEqual({ label: 'happy', intensity: 0.8 })
    expect(stored?.perceived_user).toBeNull()
  })

  it('message_done 和 system 私有流事件都带上请求 dispatch 时刻捕获的 sessionId', async () => {
    // 供前端识别"这条回复是否还属于我现在展示的会话"（见 chat.ts send() 处的注释）——
    // 纯靠 controller.signal.aborted 拦不住"切换检测本身还没跑完、旧 session 模型调用
    // 却先一步完成"这种时序，必须由后端把回复真正所属的 session 显式带回去
    const { session } = loadSession('p1')
    const { fastify } = await buildTestApp(JSON.stringify({ reply: '你好呀' }))

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const events = parseSSE(response.payload)

    const messageDone = events.find(e => e.event === 'message_done')
    expect(messageDone?.data.sessionId).toBe(session.sessionId)
  })

  it('模型调用失败时，system 错误事件同样带上 sessionId', async () => {
    const { session } = loadSession('p1')
    const fastify = Fastify()
    const throwingModelProvider = {
      completeSync: async () => { throw new Error('model boom') },
    }
    const createSpy = vi.spyOn(ModelProviderModule, 'createModelProviderForPreset')
      .mockReturnValue(throwingModelProvider as unknown as ModelProvider)
    fastify.decorate('streamingEnabled', false)
    fastify.decorate('embeddingProvider', fakeEmbeddingProvider())
    await fastify.register(chatRoutes)

    try {
      const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
      const events = parseSSE(response.payload)

      const systemEvent = events.find(e => e.event === 'system')
      expect(systemEvent?.data.sessionId).toBe(session.sessionId)
    } finally {
      createSpy.mockRestore()
    }
  })

  it('self 情绪合法时，广播流也收到与私有流一致的 emotion payload', async () => {
    const { session } = loadSession('p1')
    const { fastify } = await buildTestApp(JSON.stringify({
      reply: '你好呀',
      emotion: { self: { label: 'happy', intensity: 0.8 }, perceived_user: null },
    }))

    await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })

    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledWith('emotion', {
      self: { label: 'happy', intensity: 0.8 },
      perceived_user: null,
      sessionId: session.sessionId,
      explicitSleep: false,
    })
  })

  it('emotion 字段缺失/不合法时，不落库，也不报错，SSE 正常返回', async () => {
    const { session } = loadSession('p1')
    const { fastify } = await buildTestApp(JSON.stringify({ reply: '嗯嗯' }))

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const events = parseSSE(response.payload)

    const emotion = events.find(e => e.event === 'emotion')
    expect(emotion?.data).toEqual({
      self: null,
      perceived_user: null,
      sessionId: session.sessionId,
      explicitSleep: false,
    })

    expect(getEmotionState(session.sessionId)).toBeNull()
  })

  it('reply 正文命中困意检测规则时，emotion 帧的 explicitSleep 携带 true（私有流与广播流一致，TDD §3.7 附「入睡转场」"回复内容检测到困意"）', async () => {
    const { session } = loadSession('p1')
    const { fastify } = await buildTestApp(JSON.stringify({ reply: '啊我好困呀' }))

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const events = parseSSE(response.payload)

    const emotion = events.find(e => e.event === 'emotion')
    expect(emotion?.data).toMatchObject({ sessionId: session.sessionId, explicitSleep: true })
    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledWith(
      'emotion',
      expect.objectContaining({ sessionId: session.sessionId, explicitSleep: true }),
    )
  })

  it('self 情绪 label 为 sleep 时：不落 EmotionStates，但也不再置显式睡着标记（TDD §3.9「必须保留的守卫」：sleep 归位后，自发的 sleep label 是未定义行为，不能触发睡着）', async () => {
    const { session } = loadSession('p1')
    // reply 正文特意选用不会触发文本检测类（好困/困了等模式）的中性文本，这样这里观察到
    // 的行为只来自 emotion.label === 'sleep' 这条路径本身，不与 §3.8 的困意文本检测混在一起
    const { fastify } = await buildTestApp(JSON.stringify({
      reply: '嗯嗯',
      emotion: { self: { label: 'sleep', intensity: 0.9 }, perceived_user: null },
    }))

    await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })

    expect(getEmotionState(session.sessionId)).toBeNull()
    expect(isExplicitSleep(session.sessionId)).toBe(false)
  })

  it('self 情绪 label 为 sleep 时：帧照常发出但整个省掉 self 键（x 永不为 sleep 靠不给 self 达成，而不是吞掉整帧——sessionId/explicitSleep 必须照常送达）', async () => {
    const { session } = loadSession('p1')
    // reply 正文特意选用不会触发文本检测类（好困/困了等模式）的中性文本，这样这里观察到
    // 的行为只来自 emotion.label === 'sleep' 这条路径本身，不与 §3.8 的困意文本检测混在一起
    const { fastify } = await buildTestApp(JSON.stringify({
      reply: '嗯嗯',
      emotion: { self: { label: 'sleep', intensity: 0.9 }, perceived_user: null },
    }))

    // broadcastEvent 是整个测试文件共享的模块级 mock（vi.mock 工厂里手写的 vi.fn()），不是
    // 通过 vi.spyOn() 创建的——afterEach 的 vi.restoreAllMocks() 只对 spyOn 创建的 mock 生效，
    // 对这个 vi.fn() 是空操作，调用记录会跨用例持续累积。因此这里改用调用次数的前后差值来
    // 断言"这次请求没有再产生新的 emotion 广播"，而不是断言从未被调用过
    const callsBefore = (BroadcastModule.broadcastEvent as unknown as { mock: { calls: unknown[] } }).mock.calls.length

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const emotion = parseSSE(response.payload).find(e => e.event === 'emotion')

    // 帧必须发出：吞掉整帧会连 sessionId/explicitSleep 一起吞掉，而模型「既被文本检测判为
    // 困了、又自发标 label 为 sleep」时正是最需要这两个字段送达的那一轮
    expect(emotion).toBeDefined()
    // self 键整个不存在——不是 self: null。发 null 会把渲染层的 x 清空，而 TDD §3.9 的推论
    // 要求唤醒后回落到上一次真实的情绪，x 必须保留
    expect(emotion!.data).not.toHaveProperty('self')
    expect(emotion!.data).toMatchObject({ sessionId: session.sessionId, explicitSleep: false })

    const broadcastCalls = (BroadcastModule.broadcastEvent as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(broadcastCalls.length).toBe(callsBefore + 1)
    const broadcastPayload = broadcastCalls[broadcastCalls.length - 1][1] as Record<string, unknown>
    expect(broadcastPayload).not.toHaveProperty('self')
    expect(broadcastPayload).toMatchObject({ sessionId: session.sessionId, explicitSleep: false })

    expect(isExplicitSleep(session.sessionId)).toBe(false)
  })

  it('两个检测器同时命中（正文含困意 + label 也是 sleep）：帧仍照常发出，explicitSleep 为 true 且不带 self', async () => {
    const { session } = loadSession('p1')
    // 这是本条修复真正针对的场景：§3.8 的文本检测与 §3.9 的 label 守卫读的是同一段「角色说
    // 自己困了」的文本，所以两者会相关地一起命中。此前 emotion 帧被 isSleep 整个吞掉，
    // 标记置上了却送不出去，悬浮窗要等下一次阈值轮询才知道——正好回到这两个字段要消除的洞
    const { fastify } = await buildTestApp(JSON.stringify({
      reply: '啊我好困呀',
      emotion: { self: { label: 'sleep', intensity: 0.9 }, perceived_user: null },
    }))

    const callsBefore = (BroadcastModule.broadcastEvent as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const emotion = parseSSE(response.payload).find(e => e.event === 'emotion')

    expect(emotion).toBeDefined()
    expect(emotion!.data).not.toHaveProperty('self')
    expect(emotion!.data).toMatchObject({ sessionId: session.sessionId, explicitSleep: true })

    const broadcastCalls = (BroadcastModule.broadcastEvent as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(broadcastCalls.length).toBe(callsBefore + 1)
    expect(broadcastCalls[broadcastCalls.length - 1][1] as Record<string, unknown>).toMatchObject({ explicitSleep: true })

    // 文本检测置的标记生效；label 那条路径仍然只拦 x，不落 EmotionStates
    expect(isExplicitSleep(session.sessionId)).toBe(true)
  })
  it('已存在真实情绪时，模型接着回复 sleep 不会覆盖/清除原有的 EmotionStates 记录', async () => {
    const { session } = loadSession('p1')
    queries.upsertEmotionState(session.sessionId, { self: { label: 'happy', intensity: 0.8 }, perceived_user: null })

    // reply 正文特意选用不会触发文本检测类（好困/困了等模式）的中性文本，这样这里观察到
    // 的行为只来自 emotion.label === 'sleep' 这条路径本身，不与 §3.8 的困意文本检测混在一起
    const { fastify } = await buildTestApp(JSON.stringify({
      reply: '嗯嗯',
      emotion: { self: { label: 'sleep', intensity: 0.9 }, perceived_user: null },
    }))

    await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })

    expect(getEmotionState(session.sessionId)).toEqual({ self: { label: 'happy', intensity: 0.8 }, perceived_user: null })
    expect(isExplicitSleep(session.sessionId)).toBe(false)
  })

  it('本轮产出可用回复时才刷新 lastAttentionAt、清除显式睡着标记（TDD §3.7 附「搭理 bot」：计数器位，不是点击发送即算）', async () => {
    const { session } = loadSession('p1')
    markExplicitSleep(session.sessionId)
    expect(isExplicitSleep(session.sessionId)).toBe(true)

    const before = Date.now()
    const { fastify } = await buildTestApp(JSON.stringify({ reply: '嗯嗯' }))
    await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })

    expect(getLastAttentionAt(session.sessionId)).toBeGreaterThanOrEqual(before)
    expect(isExplicitSleep(session.sessionId)).toBe(false)
  })

  it('reply 正文去掉首尾空白后为空（拦截类命中）时：不刷新 lastAttentionAt（TDD §3.7 附「搭理 bot」：产不出可用回复的这一轮不算数）', async () => {
    const { session } = loadSession('p1')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fixedPast = Date.now() - 1000 * 60 * 60
    recordAttention(session.sessionId, fixedPast)

    const { fastify } = await buildTestApp(JSON.stringify({ reply: '   ' }))
    await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })

    expect(getLastAttentionAt(session.sessionId)).toBe(fixedPast)
    errorSpy.mockRestore()
  })

  it('模型调用抛错时：不刷新 lastAttentionAt（TDD §3.7 附「搭理 bot」：一次没有得到回复的对话不算搭理过）', async () => {
    const { session } = loadSession('p1')
    const fixedPast = Date.now() - 1000 * 60 * 60
    recordAttention(session.sessionId, fixedPast)

    const fastify = Fastify()
    const throwingModelProvider = {
      completeSync: async () => { throw new Error('model boom') },
    }
    const createSpy = vi.spyOn(ModelProviderModule, 'createModelProviderForPreset')
      .mockReturnValue(throwingModelProvider as unknown as ModelProvider)
    fastify.decorate('streamingEnabled', false)
    fastify.decorate('embeddingProvider', fakeEmbeddingProvider())
    await fastify.register(chatRoutes)

    try {
      await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
      expect(getLastAttentionAt(session.sessionId)).toBe(fixedPast)
    } finally {
      createSpy.mockRestore()
    }
  })

  it('reply 正文去掉首尾空白后为空时：不入库、不发 message_done，改发 system 事件（TDD §3.8「回复检查」拦截类）', async () => {
    const { session } = loadSession('p1')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { fastify } = await buildTestApp(JSON.stringify({ reply: '   ' }))
    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const events = parseSSE(response.payload)

    expect(events.find(e => e.event === 'message_done')).toBeUndefined()
    const systemEvent = events.find(e => e.event === 'system')
    expect(systemEvent?.data.sessionId).toBe(session.sessionId)
    expect(errorSpy).toHaveBeenCalled()

    // 用户消息仍照常入库（发生在拦截判定之前），但没有对应的 assistant 消息——
    // 「不入库」只挡这一轮的空回复，不影响已经写入的用户消息
    const history = getHistory(50)
    expect(history.some(m => m.role === 'assistant')).toBe(false)
    expect(history.some(m => m.role === 'user')).toBe(true)

    errorSpy.mockRestore()
  })

  it('reply 正文命中困意检测规则时置显式睡着标记，且照常入库（TDD §3.8「回复检查」文本检测类，不依赖 emotion.label）', async () => {
    const { session } = loadSession('p1')
    const before = Date.now()
    const { fastify } = await buildTestApp(JSON.stringify({ reply: '啊我好困呀' }))

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const events = parseSSE(response.payload)

    expect(events.find(e => e.event === 'message_done')).toBeDefined()
    // 排序陷阱回归测试：recordAttention 必须先于 markExplicitSleep 执行——若顺序颠倒，
    // recordAttention 会把本轮刚置上的显式睡着标记立刻清除，这里就会观察到 false
    expect(isExplicitSleep(session.sessionId)).toBe(true)
    // 同一轮里 lastAttentionAt 也必须刷新（这是一次产出可用回复的成功轮次）
    expect(getLastAttentionAt(session.sessionId)).toBeGreaterThanOrEqual(before)
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

  it('按请求捕获的 preset 和 getModelProviderConfig() 构建 provider', async () => {
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
    fastify.decorate('streamingEnabled', false)
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
    const { session } = loadSession('p1')

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
      unload: async () => true,
    }

    const fastify = Fastify()
    fastify.decorate('streamingEnabled', false)
    fastify.decorate('embeddingProvider', slowEmbeddingProvider)
    fastify.addHook('onRequest', (_request, reply, done) => {
      capturedReply = reply
      onRequestDone()
      done()
    })

    // buildContext 成功之后新增的第三处守卫会在 signal 已 aborted 时直接 return，
    // 不再往下走到 modelProvider——因此这里改为断言 completeSync 从未被调用，
    // 用它来证明 close 监听器注册得足够早：如果注册得太晚（signal 没能及时变成 aborted），
    // 这个守卫就会形同虚设，completeSync 反而会被调用到
    const completeSyncMock = vi.fn(async () => JSON.stringify({ reply: '嗯嗯' }))
    vi.spyOn(ModelProviderModule, 'createModelProviderForPreset').mockReturnValue({
      completeSync: completeSyncMock,
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

    // 放行 buildContext，让它跑完
    resolveEmbed!(new Array(1024).fill(0))
    // 等 buildContext 成功之后的守卫、addMessage 等微任务跑完（不等 injectPromise 本身——
    // emit('close') 之后 light-my-request 会把它判定为提前断开并 reject，不代表 handler 内部已经跑完）
    await new Promise(resolve => setImmediate(resolve))

    // 断连发生在 buildContext 期间、早于 buildContext 返回，buildContext 返回后的守卫
    // 应当已经能看到 aborted 的 signal 并直接 return——证明 close 监听器注册得足够早，
    // 没有错过这个更早的窗口
    expect(completeSyncMock).not.toHaveBeenCalled()

    const rows = db.prepare('SELECT role, content FROM Messages WHERE sessionId = ?')
      .all(session.sessionId) as Array<{ role: string; content: string }>
    expect(rows).toEqual([])
  })

  it('客户端在 buildContext 的 embedding 调用进行中断开：signal 一路传到 embed()，abort 后立即取消而不是一直挂起等 5 秒超时，且该请求的用户消息不会被落库', async () => {
    const { session } = loadSession('p1')

    let capturedReply: { raw: import('http').ServerResponse } | undefined
    let onRequestDone: () => void
    const onRequestPromise = new Promise<void>(resolve => { onRequestDone = resolve })

    // 复刻 BGEProvider 修复后的真实行为：fetch 的 signal 一旦 abort，请求本身 reject（AbortError），
    // 而不是像旧行为那样一直挂起等 5 秒固定超时——这里通过监听 signal 的 abort 事件模拟同样效果。
    // retrieval.ts 向量路本身已有 try/catch（既有正确行为，本次不改），所以这次 abort 会被
    // retrieveMemories 内部吞掉，buildContext 本身不会因此抛出——这里只验证 signal 确实一路
    // 传到 embed() 并让它的 promise 及时 settle，不再无限期挂起
    let capturedEmbedSignal: AbortSignal | undefined
    let embedCalled: () => void
    const embedCalledPromise = new Promise<void>(resolve => { embedCalled = resolve })
    let embedSettled = false
    const slowEmbeddingProvider: EmbeddingProvider = {
      embed: (_text: string, signal?: AbortSignal) => {
        capturedEmbedSignal = signal
        embedCalled()
        return new Promise<number[]>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            embedSettled = true
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
      },
      embedBatch: async (texts: string[]) => texts.map(() => new Array(1024).fill(0)),
      unload: async () => true,
    }

    const fastify = Fastify()
    fastify.decorate('streamingEnabled', false)
    fastify.decorate('embeddingProvider', slowEmbeddingProvider)
    fastify.addHook('onRequest', (_request, reply, done) => {
      capturedReply = reply
      onRequestDone()
      done()
    })

    vi.spyOn(ModelProviderModule, 'createModelProviderForPreset').mockReturnValue({
      completeSync: async () => JSON.stringify({ reply: '嗯嗯' }),
    } as unknown as ModelProvider)

    await fastify.register(chatRoutes)

    // "记得" 命中回忆类关键词，确保 buildContext 内部真的会走到 retrieveMemories → embed()
    const injectPromise = fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你还记得吗' } })
    injectPromise.catch(() => {})

    await onRequestPromise
    await embedCalledPromise
    expect(capturedEmbedSignal?.aborted).toBe(false)
    expect(embedSettled).toBe(false)

    // 模拟客户端在 embedding 调用进行中断开
    capturedReply!.raw.emit('close')

    // 等 close 监听器触发 abortController.abort() 的微任务跑完
    await new Promise(resolve => setImmediate(resolve))

    // 修复前：embed() 从未收到任何 signal，这里会一直是 undefined/false，请求实际要跑满 5 秒
    // 固定超时才会继续。修复后：signal 立即变为 aborted，embed() 的 promise 也随之立即 settle
    expect(capturedEmbedSignal?.aborted).toBe(true)
    expect(embedSettled).toBe(true)

    // buildContext 因为 retrieval.ts 既有的 try/catch 吞掉了这次 abort，会正常 return（不抛错），
    // 但连接此时已经死了——buildContext 成功之后必须再检查一次连接状态，否则这条注定不会有
    // 任何 assistant 回复的用户消息会被永久落库。等 addMessage 之后的微任务跑完，确认
    // Messages 表里这个 sessionId 下没有任何一行（既没有 user，也没有 assistant）
    await new Promise(resolve => setImmediate(resolve))
    const rows = db.prepare('SELECT role, content FROM Messages WHERE sessionId = ?')
      .all(session.sessionId) as Array<{ role: string; content: string }>
    expect(rows).toEqual([])
  })

  it('buildContext 失败但客户端连接已经断开：catch 块直接 return，不再尝试发送任何响应', async () => {
    let capturedReply: FastifyReply | undefined
    let onRequestDone: () => void
    const onRequestPromise = new Promise<void>(resolve => { onRequestDone = resolve })

    let buildContextCalled: () => void
    const buildContextCalledPromise = new Promise<void>(resolve => { buildContextCalled = resolve })
    let rejectBuildContext: (err: unknown) => void
    const buildContextPromise = new Promise((_resolve, reject) => { rejectBuildContext = reject })
    const buildContextSpy = vi.spyOn(BuildContextModule, 'buildContext').mockImplementation(async () => {
      buildContextCalled()
      return buildContextPromise as never
    })

    try {
      loadSession('p1')

      const fastify = Fastify()
      fastify.decorate('streamingEnabled', false)
      fastify.decorate('embeddingProvider', fakeEmbeddingProvider())
      fastify.addHook('onRequest', (_request, reply, done) => {
        capturedReply = reply
        onRequestDone()
        done()
      })

      await fastify.register(chatRoutes)

      const injectPromise = fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
      injectPromise.catch(() => {})

      await onRequestPromise
      await buildContextCalledPromise

      // buildContext 仍在执行期间就 spy 好 status，确保能捕捉到 catch 块是否尝试发送响应
      const statusSpy = vi.spyOn(capturedReply!, 'status')

      // 客户端在 buildContext 执行期间断开
      Object.defineProperty(capturedReply!.raw, 'destroyed', { value: true, configurable: true })
      capturedReply!.raw.emit('close')

      // 此时才让 buildContext 失败（与真实的 embedding abort 场景时序一致：断连发生在先，
      // buildContext 抛出在后）
      rejectBuildContext!(new Error('boom, unrelated to abort'))
      await new Promise(resolve => setImmediate(resolve))

      expect(statusSpy).not.toHaveBeenCalled()
    } finally {
      buildContextSpy.mockRestore()
    }
  })

  it('buildContext 因非断连原因失败，但连接仍然存活：照常返回 500（守卫只在连接已死时才跳过发送）', async () => {
    const buildContextSpy = vi.spyOn(BuildContextModule, 'buildContext').mockRejectedValue(new Error('boom'))

    try {
      const { fastify } = await buildTestApp(JSON.stringify({ reply: '嗯嗯' }))
      const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })

      expect(response.statusCode).toBe(500)
      expect(JSON.parse(response.payload)).toEqual({ error: 'Failed to build context' })
    } finally {
      buildContextSpy.mockRestore()
    }
  })

  it('并发发送两条消息时按到达顺序串行处理：落库顺序是严格的发送序，不会因第二条模型先返回而抢先', async () => {
    const { session } = loadSession('p1')

    // 第一条请求的模型调用人为卡住，只有测试手动放行才 resolve——
    // 如果 /chat 的处理没有被串行化，第二条请求会在这段等待期间抢先跑完并落库
    let resolveFirstComplete: (v: string) => void
    const firstCompletePromise = new Promise<string>(resolve => { resolveFirstComplete = resolve })
    let signalFirstCalled: () => void
    const firstCalledPromise = new Promise<void>(resolve => { signalFirstCalled = resolve })

    let callCount = 0
    vi.spyOn(ModelProviderModule, 'createModelProviderForPreset').mockImplementation(() => {
      callCount += 1
      if (callCount === 1) {
        signalFirstCalled()
        return { completeSync: async () => firstCompletePromise } as unknown as ModelProvider
      }
      return { completeSync: async () => JSON.stringify({ reply: '第二条回复' }) } as unknown as ModelProvider
    })

    const fastify = Fastify()
    fastify.decorate('streamingEnabled', false)
    fastify.decorate('embeddingProvider', fakeEmbeddingProvider())
    await fastify.register(chatRoutes)

    const p1 = fastify.inject({ method: 'POST', url: '/chat', payload: { message: '第一条' } })
    // 等第一条请求真正跑到模型调用这一步（此时它正卡在 completeSync 上等待），
    // 再发出第二条请求，确保第二条是在第一条已经进入队列处理中途时才到达
    await firstCalledPromise

    const p2 = fastify.inject({ method: 'POST', url: '/chat', payload: { message: '第二条' } })

    // 给第二条请求一点时间，看它是否会抢先跑到 createModelProviderForPreset——
    // 串行化正确时，第二条此刻应该仍卡在队列里，callCount 还停留在 1
    await new Promise(resolve => setImmediate(resolve))
    expect(callCount).toBe(1)

    resolveFirstComplete!(JSON.stringify({ reply: '第一条回复' }))
    await Promise.all([p1, p2])

    const rows = db.prepare('SELECT role, content FROM Messages WHERE sessionId = ? ORDER BY id ASC')
      .all(session.sessionId) as Array<{ role: string; content: string }>
    const ordered = rows.map(r => ({ role: r.role, content: decrypt(r.content) }))

    expect(ordered).toEqual([
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '第一条回复' },
      { role: 'user', content: '第二条' },
      { role: 'assistant', content: '第二条回复' },
    ])
  })

  it('排队等待期间客户端已断开：轮到该请求处理时直接跳过，不发起模型调用，也不落库', async () => {
    const { session } = loadSession('p1')

    const capturedReplies: Array<{ raw: import('http').ServerResponse }> = []
    const fastify = Fastify()
    fastify.decorate('streamingEnabled', false)
    fastify.decorate('embeddingProvider', fakeEmbeddingProvider())
    fastify.addHook('onRequest', (_request, reply, done) => {
      capturedReplies.push(reply)
      done()
    })

    // 第一条请求卡住，让第二条请求有机会先排进队列，再被模拟断开
    let resolveFirstComplete: (v: string) => void
    const firstCompletePromise = new Promise<string>(resolve => { resolveFirstComplete = resolve })
    const completeSyncMock = vi.fn(async () => firstCompletePromise)
    vi.spyOn(ModelProviderModule, 'createModelProviderForPreset').mockReturnValue({
      completeSync: completeSyncMock,
    } as unknown as ModelProvider)

    await fastify.register(chatRoutes)

    const p1 = fastify.inject({ method: 'POST', url: '/chat', payload: { message: '第一条' } })
    const p2 = fastify.inject({ method: 'POST', url: '/chat', payload: { message: '第二条（会被断开）' } })

    // 等两个请求都跑过 onRequest 钩子，拿到各自的 reply.raw 引用
    await new Promise(resolve => setImmediate(resolve))
    expect(capturedReplies).toHaveLength(2)

    // 模拟第二条请求在排队等待期间（还没轮到它处理）客户端已经断开
    Object.defineProperty(capturedReplies[1].raw, 'destroyed', { value: true, configurable: true })
    capturedReplies[1].raw.emit('close')

    // 放行第一条请求，让队列继续往下轮到第二条
    resolveFirstComplete!(JSON.stringify({ reply: '第一条回复' }))
    // 断开场景下不关心两个 inject() 最终各自 settle 成什么，用 allSettled 稳妥地把两者都消费掉，
    // 避免 promise rejection 未被处理
    await Promise.allSettled([p1, p2])

    // completeSync 全程只应该被第一条请求调用过一次，第二条被跳过，模型调用从未发生
    expect(completeSyncMock).toHaveBeenCalledTimes(1)

    const rows = db.prepare('SELECT role, content FROM Messages WHERE sessionId = ? ORDER BY id ASC')
      .all(session.sessionId) as Array<{ role: string; content: string }>
    const ordered = rows.map(r => ({ role: r.role, content: decrypt(r.content) }))

    expect(ordered).toEqual([
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '第一条回复' },
    ])
  })
})

describe('POST /chat — 表情包挑选（emote 字段，TDD §3.9「表情包挑选机制」）', () => {
  it('tag 命中角色包词表，emotePool 中唯一匹配：message_done 带上对应 file', async () => {
    upsertPreset({
      presetId: 'p-single-emote',
      name: '单候选表情测试',
      characterId: 'char-single-emote',
      modelType: 'ollama',
      modelName: 'qwen3',
      systemPrompt: '你是角色',
    })
    loadSession('p-single-emote')

    const { fastify } = await buildTestApp(JSON.stringify({
      reply: '好呀',
      emotion: { self: { label: 'happy', intensity: 0.5 } },
      emote: 'comforting',
    }))

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const messageDone = parseSSE(response.payload).find(e => e.event === 'message_done')

    expect(messageDone?.data.emote).toBe('emotes/hug.jpg')
  })

  it('tag 不在角色包 emoteTagVocabulary 词表内：message_done 不带 emote key', async () => {
    upsertPreset({
      presetId: 'p-single-emote',
      name: '单候选表情测试',
      characterId: 'char-single-emote',
      modelType: 'ollama',
      modelName: 'qwen3',
      systemPrompt: '你是角色',
    })
    loadSession('p-single-emote')

    const { fastify } = await buildTestApp(JSON.stringify({
      reply: '好呀',
      emotion: { self: { label: 'happy', intensity: 0.5 } },
      emote: 'not-a-real-tag',
    }))

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const messageDone = parseSSE(response.payload).find(e => e.event === 'message_done')

    expect(messageDone?.data).not.toHaveProperty('emote')
  })

  it('模型本轮没有输出 emote 字段（常见情况）：message_done 不带 emote key，不报错', async () => {
    upsertPreset({
      presetId: 'p-single-emote',
      name: '单候选表情测试',
      characterId: 'char-single-emote',
      modelType: 'ollama',
      modelName: 'qwen3',
      systemPrompt: '你是角色',
    })
    loadSession('p-single-emote')

    const { fastify } = await buildTestApp(JSON.stringify({
      reply: '好呀',
      emotion: { self: { label: 'happy', intensity: 0.5 } },
    }))

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const messageDone = parseSSE(response.payload).find(e => e.event === 'message_done')

    expect(messageDone?.data).not.toHaveProperty('emote')
  })

  it('角色包缺失 manifest（如 char-001）时，即使模型输出了 emote 字段，也不附带表情', async () => {
    const { fastify } = await buildTestApp(JSON.stringify({
      reply: '好呀',
      emotion: { self: { label: 'happy', intensity: 0.5 } },
      emote: 'playful',
    }))

    const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
    const messageDone = parseSSE(response.payload).find(e => e.event === 'message_done')

    expect(messageDone?.data).not.toHaveProperty('emote')
  })

  it('tag 命中且 emotePool 有多个匹配条目：随机分支落在过滤后的候选集合内（Math.random 打桩验证具体挑中哪一个，避免测试本身不确定）', async () => {
    upsertPreset({
      presetId: 'p-multi-emote',
      name: '多候选表情测试',
      characterId: 'char-multi-emote',
      modelType: 'ollama',
      modelName: 'qwen3',
      systemPrompt: '你是角色',
    })
    loadSession('p-multi-emote')

    // 2 个候选（emotes/a.jpg、emotes/b.jpg），Math.floor(0.99 * 2) = 1 → 取到第二个
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    try {
      const { fastify } = await buildTestApp(JSON.stringify({
        reply: '好呀',
        emotion: { self: { label: 'happy', intensity: 0.5 } },
        emote: 'playful',
      }))

      const response = await fastify.inject({ method: 'POST', url: '/chat', payload: { message: '你好' } })
      const messageDone = parseSSE(response.payload).find(e => e.event === 'message_done')

      expect(messageDone?.data.emote).toBe('emotes/b.jpg')
    } finally {
      randomSpy.mockRestore()
    }
  })
})
