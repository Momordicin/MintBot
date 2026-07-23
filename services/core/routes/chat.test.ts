import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { initDb, db } from '../db/index.js'
import { upsertPreset, getEmotionState } from '../session/queries.js'
import * as queries from '../session/queries.js'
import { loadSession } from '../session/index.js'
import { chatRoutes } from './chat.js'
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
// 非流式模式（streaming: false）走 completeSync 分支，避免实现 complete 异步生成器
async function buildTestApp(fakeReply: string) {
  const fastify = Fastify()
  const fakeModelProvider = {
    completeSync: async () => fakeReply,
  }
  fastify.decorate('config', { streaming: false })
  fastify.decorate('modelProvider', fakeModelProvider as unknown as ModelProvider)
  fastify.decorate('embeddingProvider', fakeEmbeddingProvider())
  await fastify.register(chatRoutes)
  return fastify
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
    const fastify = await buildTestApp(JSON.stringify({
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
    const fastify = await buildTestApp(JSON.stringify({ reply: '嗯嗯' }))

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
      const fastify = await buildTestApp(JSON.stringify({
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
})
