import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { initDb, db } from '../db/index.js'
import { upsertPreset } from '../session/queries.js'
import { loadSession } from '../session/index.js'
import { presetRoutes } from './presets.js'

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
  upsertPreset({
    presetId: 'p2',
    name: '角色二',
    characterId: 'char-002',
    modelType: 'ollama',
    modelName: 'llama3',
    wallpaperPath: 'p2-bg.jpg',
    systemPrompt: '你是角色二',
  })
})

// 起一个干净的 Fastify 实例，config.modelProvider 只需满足 buildStatePayload 内部读取
// ollamaBaseUrl 的类型要求，本测试不断言 ollamaReady 的具体值
async function buildTestApp() {
  const fastify = Fastify()
  fastify.decorate('config', { modelProvider: { type: 'ollama' } })
  await fastify.register(presetRoutes)
  return fastify
}

describe('GET /presets', () => {
  it('返回所有 preset 列表', async () => {
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/presets' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body).toHaveLength(2)
    expect(body.map((p: { presetId: string }) => p.presetId).sort()).toEqual(['p1', 'p2'])
    // DTO 精简回归防护：不广播 systemPrompt 等完整 Preset 字段
    expect(body[0]).not.toHaveProperty('systemPrompt')
    expect(body[0]).not.toHaveProperty('modelType')
    expect(body[0]).not.toHaveProperty('modelName')
  })
})

describe('POST /switch-preset', () => {
  it('成功切换后返回与 GET /state 一致的 shape', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/switch-preset',
      payload: { presetId: 'p2' },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.presetId).toBe('p2')
    expect(body.presetSnapshot.wallpaperPath).toBe('p2-bg.jpg')
    expect(body).toHaveProperty('sessionId')
    expect(body).toHaveProperty('ollamaReady')
    expect(body).toHaveProperty('emotion')
    expect(body).toHaveProperty('embeddingQueue')
  })

  it('presetId 不存在时返回 404', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/switch-preset',
      payload: { presetId: 'does-not-exist' },
    })

    expect(response.statusCode).toBe(404)
  })

  it('presetId 缺失/空时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/switch-preset',
      payload: { presetId: '' },
    })

    expect(response.statusCode).toBe(400)
  })
})
