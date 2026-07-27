import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import fs from 'fs'
import path from 'path'
import { initDb, db } from '../db/index.js'
import { upsertPreset, getPresetById } from '../session/queries.js'
import { loadSession } from '../session/index.js'
import { presetRoutes } from './presets.js'
import { buildStatePayload } from '../state.js'

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
    expect(body).toHaveProperty('embeddingReady')
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

describe('POST /presets/:presetId/wallpaper', () => {
  const writtenFiles: string[] = []

  afterEach(() => {
    for (const filename of writtenFiles) {
      fs.rmSync(path.resolve(process.cwd(), 'data/wallpapers', filename), { force: true })
    }
    writtenFiles.length = 0
  })

  it('成功上传后落盘文件并覆盖响应里的 wallpaperPath', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()
    const savedFilename = 'p1-wallpaper.png'
    writtenFiles.push(savedFilename)

    const response = await fastify.inject({
      method: 'POST',
      url: '/presets/p1/wallpaper',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('my-photo.PNG'),
      },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.wallpaperPath).toBe(savedFilename)
    // DB 里的 Preset.wallpaperPath 列应同步更新（响应里的覆盖值不是唯一的落地位置）
    expect(getPresetById('p1')!.wallpaperPath).toBe(savedFilename)
    expect(fs.existsSync(path.resolve(process.cwd(), 'data/wallpapers', savedFilename))).toBe(true)
  })

  it('已有 session 的 preset 上传新壁纸后，独立的 buildStatePayload 调用（非本次上传的响应）也返回新 wallpaperPath，而非 session 创建时冻结的旧值', async () => {
    // session 在上传前就已存在，此时 presetSnapshot.wallpaperPath 冻结为 p1 当时的值（undefined）
    loadSession('p1')
    const fastify = await buildTestApp()
    const savedFilename = 'p1-wallpaper.png'
    writtenFiles.push(savedFilename)

    await fastify.inject({
      method: 'POST',
      url: '/presets/p1/wallpaper',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('my-photo.PNG'),
      },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    })

    // 上传响应之外，独立再调一次 buildStatePayload，模拟之后的 GET /state / POST /switch-preset
    const statePayload = await buildStatePayload(fastify)
    expect(statePayload.presetSnapshot?.wallpaperPath).toBe(savedFilename)
  })

  it('presetId 不存在时返回 404', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/presets/does-not-exist/wallpaper',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('a.png'),
      },
      payload: Buffer.from([1, 2, 3]),
    })

    expect(response.statusCode).toBe(404)
  })

  it('扩展名不在白名单时返回 400', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/presets/p1/wallpaper',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('a.exe'),
      },
      payload: Buffer.from([1, 2, 3]),
    })

    expect(response.statusCode).toBe(400)
  })

  it('X-Filename 是畸形 percent-encoding 时返回 400 而非 500', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/presets/p1/wallpaper',
      headers: {
        'content-type': 'application/octet-stream',
        // 裸 % 不是合法的 percent-encoding，decodeURIComponent 对此会抛 URIError
        'x-filename': 'a%.png',
      },
      payload: Buffer.from([1, 2, 3]),
    })

    expect(response.statusCode).toBe(400)
  })

  it('超过 bodyLimit 时返回 413', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/presets/p1/wallpaper',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('a.png'),
      },
      payload: Buffer.alloc(10 * 1024 * 1024 + 1),
    })

    expect(response.statusCode).toBe(413)
  })
})
