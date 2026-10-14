import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fs from 'fs'
import path from 'path'
import { initDb, db } from '../db/index.js'
import {
  upsertPreset, getPresetById, updatePresetDisplayConfig, updatePresetSystemPrompt, updatePresetModelConfig, getEmotionState, upsertEmotionState,
  getPresetApiKeys, upsertPresetApiKey,
  createSession, appendMessage, upsertMessageEmbedding, indexMessageFts, insertEntity, insertSummary,
} from '../session/queries.js'
import { DEFAULT_DISPLAY_CONFIG } from '../session/displayConfig.js'
import { loadSession, getCurrentState } from '../session/index.js'
import { presetRoutes, WALLPAPER_DIR } from './presets.js'
import { buildStatePayload } from '../state.js'
import * as BroadcastModule from '../events/broadcast.js'
import { isEnvCredentialDetected } from '../providers/envCredentials.js'

vi.mock('../providers/envCredentials.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../providers/envCredentials.js')>()
  return { ...actual, isEnvCredentialDetected: vi.fn(() => false) }
})

vi.mock('../events/broadcast.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../events/broadcast.js')>()
  return { ...actual, broadcastEvent: vi.fn() }
})

vi.mock('../session/queries.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../session/queries.js')>()
  return { ...actual, createSession: vi.fn(actual.createSession) }
})

// buildStatePayload 内部读取 getModelProviderConfig().ollamaBaseUrl，mock 掉独立 config
// 模块（而不是依赖真实的本地 config.json），保证测试结果不受本机 config.json 内容影响。
// setDefaultPresetId 同样 mock 掉——POST /switch-preset 经 session/index.ts 的 switchPreset
// 调用它，真实实现会写本机 config.json，测试不应该有这个副作用
vi.mock('../config/index.js', () => ({
  getModelProviderConfig: vi.fn(() => ({ type: 'ollama' })),
  setDefaultPresetId: vi.fn(),
}))

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

// 起一个干净的 Fastify 实例；buildStatePayload 内部读取的 modelProvider 配置已通过上面的
// vi.mock('../config/index.js') 提供，本测试不断言 ollamaReady 的具体值
async function buildTestApp() {
  const fastify = Fastify()
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

describe('POST /presets', () => {
  it('成功创建后返回精简 DTO，DB 里写入正确的默认字段', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/presets',
      payload: { name: '新角色', characterId: 'char-003', systemPrompt: '你是新角色' },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body).toHaveProperty('presetId')
    expect(body.name).toBe('新角色')
    // DTO 精简回归防护：不广播 systemPrompt 等完整 Preset 字段（与 GET /presets 同款约定）
    expect(body).not.toHaveProperty('systemPrompt')
    expect(body).not.toHaveProperty('characterId')
    expect(body).not.toHaveProperty('modelType')
    expect(body).not.toHaveProperty('modelName')

    // 创建的 preset 确实可读回，且各默认字段符合手动创建入口的约定
    const preset = getPresetById(body.presetId)
    expect(preset).not.toBeNull()
    expect(preset!.name).toBe('新角色')
    expect(preset!.characterId).toBe('char-003')
    expect(preset!.modelType).toBeNull()
    expect(preset!.modelName).toBeNull()
    expect(preset!.wallpaperPath).toBeUndefined()
    expect(preset!.displayConfig).toEqual(DEFAULT_DISPLAY_CONFIG)
    expect(preset!.systemPrompt).toBe('你是新角色')
    expect(preset!.addressForms).toEqual([])
  })

  it('name 缺失/全空白时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/presets',
      payload: { name: '   ', characterId: 'char-003', systemPrompt: '你是新角色' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('characterId 缺失/全空白时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/presets',
      payload: { name: '新角色', characterId: '   ', systemPrompt: '你是新角色' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('systemPrompt 缺失/全空白时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/presets',
      payload: { name: '新角色', characterId: 'char-003', systemPrompt: '   ' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('presetId 由服务端生成，两次创建得到不同的 presetId', async () => {
    const fastify = await buildTestApp()

    const first = await fastify.inject({
      method: 'POST',
      url: '/presets',
      payload: { name: '角色A', characterId: 'char-a', systemPrompt: '人设A' },
    })
    const second = await fastify.inject({
      method: 'POST',
      url: '/presets',
      payload: { name: '角色B', characterId: 'char-b', systemPrompt: '人设B' },
    })

    const firstBody = JSON.parse(first.payload)
    const secondBody = JSON.parse(second.payload)
    expect(firstBody.presetId).not.toBe(secondBody.presetId)
  })

  it('创建后立即切换到这个新 preset：走的是新建 session 分支，不是恢复旧 session', async () => {
    const fastify = await buildTestApp()

    const createResponse = await fastify.inject({
      method: 'POST',
      url: '/presets',
      payload: { name: '刚创建的角色', characterId: 'char-brand-new', systemPrompt: '你是刚创建的角色' },
    })
    const { presetId } = JSON.parse(createResponse.payload)

    const switchResponse = await fastify.inject({
      method: 'POST',
      url: '/switch-preset',
      payload: { presetId },
    })
    const switchBody = JSON.parse(switchResponse.payload)

    expect(switchResponse.statusCode).toBe(200)
    expect(switchBody.presetSnapshot.presetId).toBe(presetId)
    expect(switchBody.presetSnapshot.name).toBe('刚创建的角色')
    // 新建 preset 默认跟随全局模型配置、无自定义模型覆盖
    expect(switchBody.presetSnapshot.modelType).toBeNull()
    expect(switchBody.presetSnapshot.modelName).toBeNull()
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
    expect(body).toHaveProperty('aiAvailable')
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

  it('加载会话抛出非「角色不存在」错误时返回 500 而不是 404', async () => {
    loadSession('p1')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSession).mockImplementationOnce(() => {
      throw new Error('db write failed')
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/switch-preset',
      payload: { presetId: 'p2' },
    })

    expect(response.statusCode).toBe(500)
    expect(getCurrentState()!.preset.presetId).toBe('p1')
    expect(errorSpy).toHaveBeenCalledWith('[Presets] Switch preset failed:', expect.any(Error))
    errorSpy.mockRestore()
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
      fs.rmSync(path.join(WALLPAPER_DIR, filename), { force: true })
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
    expect(fs.existsSync(path.join(WALLPAPER_DIR, savedFilename))).toBe(true)
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
    const statePayload = await buildStatePayload()
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

  // 注意：这里只验证重复上传两次都成功、落盘内容是最新一次写入的——不模拟 Windows 下
  // 目标文件被其它句柄占用导致直接覆写失败的场景（Vitest 里难以真实构造文件锁），
  // 那部分的"为什么用 rename 而不是直接覆写"由下面的失败路径用例验证 rename 本身的失败处理
  it('对同一 preset+扩展名重复上传（覆盖场景），第二次上传仍然成功，落盘内容为最新写入', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()
    const savedFilename = 'p1-wallpaper.png'
    writtenFiles.push(savedFilename)

    const upload = (payload: Buffer) => fastify.inject({
      method: 'POST',
      url: '/presets/p1/wallpaper',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('photo.png'),
      },
      payload,
    })

    const first = await upload(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(first.statusCode).toBe(200)

    const second = await upload(Buffer.from([0x01, 0x02, 0x03, 0x04]))
    expect(second.statusCode).toBe(200)

    const filePath = path.join(WALLPAPER_DIR, savedFilename)
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]))
  })

  it('rename 覆盖失败时返回 500 而不是让异常冒泡成默认 500，且清理掉临时文件', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()
    // 故意只 mock renameSync（真正的失败点——覆盖 finalPath 这一步），不 mock writeFileSync：
    // 让临时文件先真实写入磁盘，这样才能真正验证 catch 块里 fs.rmSync(tempPath) 清理逻辑本身
    // 生效了，而不是像"mock writeFileSync 直接失败"那样、临时文件根本没被创建过，
    // "没有残留 tmp 文件"这个断言无论清理代码在不在都会通过
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed')
    })

    const response = await fastify.inject({
      method: 'POST',
      url: '/presets/p1/wallpaper',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('a.png'),
      },
      payload: Buffer.from([1, 2, 3]),
    })
    renameSpy.mockRestore()

    expect(response.statusCode).toBe(500)
    expect(JSON.parse(response.payload)).toEqual({ error: 'Failed to save wallpaper' })

    const leftoverTmp = fs.readdirSync(WALLPAPER_DIR)
      .filter(f => f.startsWith('p1-wallpaper.png.tmp-'))
    expect(leftoverTmp).toHaveLength(0)
  })
})

describe('PATCH /presets/:presetId', () => {
  it('成功重命名后响应里的 presetSnapshot.name 与 DB 均更新', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { name: '新名字' },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.name).toBe('新名字')
    expect(getPresetById('p1')!.name).toBe('新名字')
  })

  it('name 缺失时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: {},
    })

    expect(response.statusCode).toBe(400)
  })

  it('name 全是空白字符（trim 后为空）时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { name: '   ' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('presetId 不存在时返回 404', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/does-not-exist',
      payload: { name: '新名字' },
    })

    expect(response.statusCode).toBe(404)
  })

  it('name 和 displayConfig 都缺失时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: {},
    })

    expect(response.statusCode).toBe(400)
  })

  it('仅 displayConfig 的合法更新成功，响应与 DB 均反映新值', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { chatBgRgb: [10, 20, 30], chatBgOpacity: 0.4 } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    // 只 PATCH 了 chatBgRgb/chatBgOpacity，themeMode/accentRgb/tintStrength 未传，
    // 沿用创建时写入的 DEFAULT_DISPLAY_CONFIG 默认值
    expect(body.presetSnapshot.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, chatBgRgb: [10, 20, 30], chatBgOpacity: 0.4 })
    expect(getPresetById('p1')!.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, chatBgRgb: [10, 20, 30], chatBgOpacity: 0.4 })
  })

  it('name 和 displayConfig 同时传入时两者都生效', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { name: '新名字', displayConfig: { chatBgRgb: [5, 5, 5], chatBgOpacity: 0.9 } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.name).toBe('新名字')
    expect(body.presetSnapshot.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, chatBgRgb: [5, 5, 5], chatBgOpacity: 0.9 })
  })

  it('只更新 chatBgOpacity 时，服务端合并不会清空已存的 chatBgRgb', async () => {
    updatePresetDisplayConfig('p1', { ...DEFAULT_DISPLAY_CONFIG, chatBgRgb: [7, 8, 9], chatBgOpacity: 0.5 })
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { chatBgOpacity: 0.8 } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, chatBgRgb: [7, 8, 9], chatBgOpacity: 0.8 })
    expect(getPresetById('p1')!.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, chatBgRgb: [7, 8, 9], chatBgOpacity: 0.8 })
  })

  it('chatBgRgb 长度不是 3 时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { chatBgRgb: [1, 2] } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('chatBgRgb 元素超出 [0, 255] 范围时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { chatBgRgb: [0, 0, 300] } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('chatBgRgb 元素非整数时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { chatBgRgb: [1, 2, 3.5] } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('chatBgOpacity 超出 [0, 1] 范围时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { chatBgOpacity: 1.5 } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('chatBgOpacity 类型错误（非数字）时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { chatBgOpacity: '0.5' } },
    })

    expect(response.statusCode).toBe(400)
  })

  // 回归用例：themeMode/accentRgb/tintStrength 三个字段都必须出现在路由的服务端合并挑选
  // 列表里，否则会被静默丢弃且不报错（docs/MintBot_TDD.md §3.2.2 记录的已知坑），
  // 因此这里用真实 PATCH + 读回断言，而不是检查代码里的字段列表
  it('PATCH themeMode 后读回新值，其余字段不受影响', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { themeMode: 'night' } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, themeMode: 'night' })
    expect(getPresetById('p1')!.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, themeMode: 'night' })
  })

  it('themeMode 不是 day/night/auto 之一时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { themeMode: 'dusk' } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('PATCH accentRgb 后读回新值，其余字段不受影响', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { accentRgb: [200, 100, 50] } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, accentRgb: [200, 100, 50] })
    expect(getPresetById('p1')!.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, accentRgb: [200, 100, 50] })
  })

  it('accentRgb 元素超出 [0, 255] 范围时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { accentRgb: [0, 0, 300] } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('PATCH tintStrength 后读回新值，其余字段不受影响', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { tintStrength: 0.4 } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, tintStrength: 0.4 })
    expect(getPresetById('p1')!.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, tintStrength: 0.4 })
  })

  it('tintStrength 超出 [0, 1] 范围时被夹回边界而不是拒绝（是有限数字就接受）', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { tintStrength: 1.5 } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.displayConfig.tintStrength).toBe(1)
  })

  it('tintStrength 类型错误（非数字）时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { tintStrength: '0.5' } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('PATCH currentPortrait 后读回新值，其余字段不受影响', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { currentPortrait: 'illustration' } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, currentPortrait: 'illustration' })
    expect(getPresetById('p1')!.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, currentPortrait: 'illustration' })
  })

  it('未传 currentPortrait 的 displayConfig PATCH 不改动已保存的形态', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()
    await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { displayConfig: { currentPortrait: 'illustration' } } })

    await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { displayConfig: { chatBgOpacity: 0.2 } } })

    expect(getPresetById('p1')!.displayConfig.currentPortrait).toBe('illustration')
  })

  it('currentPortrait 不是 pixel/illustration 之一时返回 400，且不广播', async () => {
    const fastify = await buildTestApp()
    vi.mocked(BroadcastModule.broadcastEvent).mockClear()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { currentPortrait: 'photo' } },
    })

    expect(response.statusCode).toBe(400)
    expect(BroadcastModule.broadcastEvent).not.toHaveBeenCalled()
  })

  it('currentPortrait 真正变化时广播 preset-pet-display-changed，payload 带上 presetId；未变化或未提供时不广播', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()
    vi.mocked(BroadcastModule.broadcastEvent).mockClear()

    await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { name: 'renamed' } })
    await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { displayConfig: { chatBgOpacity: 0.2, tintStrength: 0.5 } } })
    await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { displayConfig: { currentPortrait: DEFAULT_DISPLAY_CONFIG.currentPortrait } } })
    expect(BroadcastModule.broadcastEvent).not.toHaveBeenCalled()

    await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { displayConfig: { currentPortrait: 'illustration' } } })
    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledTimes(1)
    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledWith('preset-pet-display-changed', { presetId: 'p1' })

    await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { displayConfig: { currentPortrait: 'illustration', chatBgOpacity: 0.3 } } })
    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledTimes(1)
  })

  it('仅 petScale 变化时广播一次，其余字段不变；petScale 值未变时不广播', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()
    vi.mocked(BroadcastModule.broadcastEvent).mockClear()

    const response = await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { displayConfig: { petScale: { pixel: 1.5, illustration: 1 } } } })
    expect(response.statusCode).toBe(200)
    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledTimes(1)
    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledWith('preset-pet-display-changed', { presetId: 'p1' })
    expect(getPresetById('p1')!.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, petScale: { pixel: 1.5, illustration: 1 } })

    await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { displayConfig: { petScale: { pixel: 1.5, illustration: 1 } } } })
    await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { displayConfig: { chatBgOpacity: 0.2 } } })
    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledTimes(1)
    expect(getPresetById('p1')!.displayConfig.petScale).toEqual({ pixel: 1.5, illustration: 1 })
  })

  it('currentPortrait 与 petScale 同时变化时只广播一次', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()
    vi.mocked(BroadcastModule.broadcastEvent).mockClear()

    await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { currentPortrait: 'illustration', petScale: { pixel: 1, illustration: 0.75 } } },
    })

    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledTimes(1)
    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledWith('preset-pet-display-changed', { presetId: 'p1' })
  })

  it.each([
    ['缺少 key', { pixel: 1 }],
    ['值不在档位内', { pixel: 1, illustration: 2 }],
    ['不是对象', 1.5],
  ])('petScale %s 时返回 400，不写入也不广播', async (_label, petScale) => {
    loadSession('p1')
    const fastify = await buildTestApp()
    vi.mocked(BroadcastModule.broadcastEvent).mockClear()

    const response = await fastify.inject({ method: 'PATCH', url: '/presets/p1', payload: { displayConfig: { chatBgOpacity: 0.2, petScale } } })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toContain('petScale')
    expect(getPresetById('p1')!.displayConfig).toEqual(DEFAULT_DISPLAY_CONFIG)
    expect(BroadcastModule.broadcastEvent).not.toHaveBeenCalled()
  })

  it('仅 systemPrompt 的合法更新成功，DB 反映新值', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { systemPrompt: '新的人设正文' },
    })

    expect(response.statusCode).toBe(200)
    expect(getPresetById('p1')!.systemPrompt).toBe('新的人设正文')
  })

  it('systemPrompt 全是空白字符（trim 后为空）时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { systemPrompt: '   ' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('只传 modelType 不传 modelName 时返回 400（必须成对出现）', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { modelType: 'openai' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('只传 modelName 不传 modelType 时返回 400（必须成对出现）', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { modelName: 'gpt-4o-mini' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('modelType 为非法枚举值时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { modelType: 'not-a-real-type', modelName: 'x' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('modelName 全是空白字符（trim 后为空）时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { modelType: 'openai', modelName: '   ' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('modelType 为 null 但 modelName 非 null 时返回 400（混合状态不合法）', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { modelType: null, modelName: 'gpt-4o-mini' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('modelType/modelName 都设为合法值时，覆盖生效并写入 DB', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { modelType: 'openai', modelName: 'gpt-4o-mini', apiKey: 'sk-role-openai' },
    })

    expect(response.statusCode).toBe(200)
    const preset = getPresetById('p1')!
    expect(preset.modelType).toBe('openai')
    expect(preset.modelName).toBe('gpt-4o-mini')
  })

  it('modelType: deepseek 时覆盖生效并写入 DB（DeepSeek 是一等公民 provider 类型）', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { modelType: 'deepseek', modelName: 'deepseek-v4-flash', apiKey: 'sk-role-deepseek' },
    })

    expect(response.statusCode).toBe(200)
    const preset = getPresetById('p1')!
    expect(preset.modelType).toBe('deepseek')
    expect(preset.modelName).toBe('deepseek-v4-flash')
  })

  it('modelType/modelName 都设为 null 时，清除覆盖（跟随全局配置）', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { modelType: null, modelName: null },
    })

    expect(response.statusCode).toBe(200)
    const preset = getPresetById('p1')!
    expect(preset.modelType).toBeNull()
    expect(preset.modelName).toBeNull()
  })

  it('modelType/modelName + applyNow: true，当该 preset 是当前激活 session 时，内存中的 current.preset 立即反映新的模型覆盖', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { modelType: 'openai', modelName: 'gpt-4o-mini', apiKey: 'sk-role-openai', applyNow: true },
    })

    expect(response.statusCode).toBe(200)
    expect(getCurrentState()!.preset.modelType).toBe('openai')
    expect(getCurrentState()!.preset.modelName).toBe('gpt-4o-mini')
  })

  it('name、displayConfig、systemPrompt 全部缺失时返回 400（即使带了 applyNow）', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { applyNow: true },
    })

    expect(response.statusCode).toBe(400)
  })

  it('systemPrompt + applyNow: true，当该 preset 是当前激活 session 时，内存中的 current.preset 立即反映新值', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { systemPrompt: '立即生效的人设', applyNow: true },
    })

    expect(response.statusCode).toBe(200)
    expect(getPresetById('p1')!.systemPrompt).toBe('立即生效的人设')
    // 证明生效的不只是 DB：内存缓存（buildContext.ts 实际消费的 current.preset）也已刷新
    expect(getCurrentState()!.preset.systemPrompt).toBe('立即生效的人设')
  })

  it('systemPrompt + applyNow: false（或缺省），DB 已更新但内存中的 current.preset 不刷新', async () => {
    loadSession('p1')
    const beforePreset = getCurrentState()!.preset
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { systemPrompt: '下次生效的人设' },
    })

    expect(response.statusCode).toBe(200)
    // DB 已经写入新值——applyNow 只影响内存缓存是否刷新，不影响落库本身
    expect(getPresetById('p1')!.systemPrompt).toBe('下次生效的人设')
    // 但内存中当前对话仍在用旧的 preset 对象，直到下次真正切换到这个 preset 才会读到新值
    expect(getCurrentState()!.preset).toEqual(beforePreset)
    expect(getCurrentState()!.preset.systemPrompt).toBe('你是角色一')
  })

  it('systemPrompt 更新（含 applyNow）不会调用 resetEmotionState，情绪状态不受影响', async () => {
    const { session } = loadSession('p1')
    upsertEmotionState(session.sessionId, { self: { label: 'happy', intensity: 0.7 }, perceived_user: null })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { systemPrompt: '不应该清空情绪', applyNow: true },
    })

    expect(response.statusCode).toBe(200)
    expect(getEmotionState(session.sessionId)).toEqual({ self: { label: 'happy', intensity: 0.7 }, perceived_user: null })
  })

  it('合法 name + 非法 displayConfig 时返回 400，name 不被写入', async () => {
    const fastify = await buildTestApp()
    const nameBefore = getPresetById('p1')!.name

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { name: '不应写入的名字', displayConfig: { themeMode: 'x' } },
    })

    expect(response.statusCode).toBe(400)
    expect(getPresetById('p1')!.name).toBe(nameBefore)
  })

  it('合法 displayConfig + 全空白 systemPrompt 时返回 400，displayConfig 不变且不广播', async () => {
    loadSession('p1')
    const fastify = await buildTestApp()
    vi.mocked(BroadcastModule.broadcastEvent).mockClear()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { displayConfig: { currentPortrait: 'illustration' }, systemPrompt: '   ' },
    })

    expect(response.statusCode).toBe(400)
    expect(getPresetById('p1')!.displayConfig).toEqual(DEFAULT_DISPLAY_CONFIG)
    expect(BroadcastModule.broadcastEvent).not.toHaveBeenCalled()
  })

  it('合法 systemPrompt + 只给 modelType 不给 modelName 时返回 400，systemPrompt 不被写入', async () => {
    const fastify = await buildTestApp()
    const systemPromptBefore = getPresetById('p1')!.systemPrompt

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { systemPrompt: '不应写入的人设', modelType: 'openai' },
    })

    expect(response.statusCode).toBe(400)
    expect(getPresetById('p1')!.systemPrompt).toBe(systemPromptBefore)
  })
})

describe('DELETE /presets/:presetId', () => {
  const writtenFiles: string[] = []

  afterEach(() => {
    for (const filename of writtenFiles) {
      fs.rmSync(path.join(WALLPAPER_DIR, filename), { force: true })
    }
    writtenFiles.length = 0
  })

  function makeSession(presetId: string, sessionId: string, lastActiveAt: number): string {
    const preset = getPresetById(presetId)!
    createSession({
      sessionId,
      presetId,
      presetSnapshot: {
        presetId,
        name: preset.name,
        characterId: preset.characterId,
        modelType: preset.modelType,
        modelName: preset.modelName,
        wallpaperPath: preset.wallpaperPath,
        displayConfig: preset.displayConfig,
        systemPrompt: preset.systemPrompt,
      },
      title: undefined,
      createdAt: lastActiveAt,
      lastActiveAt,
    })
    return sessionId
  }

  function seedSessionData(sessionId: string): void {
    const messageId = appendMessage({
      sessionId, role: 'user', content: `内容 ${sessionId}`, createdAt: 1000,
      embedded: true, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    upsertMessageEmbedding(messageId, sessionId, new Array(1024).fill(0.5))
    indexMessageFts(messageId, sessionId, `内容 ${sessionId}`)
    insertEntity({ messageId, sessionId, type: 'preference', value: '喜欢猫', validFrom: 1000 })
    insertSummary({ sessionId, content: '摘要', fromMessageId: messageId, toMessageId: messageId })
    upsertEmotionState(sessionId, { self: { label: 'happy', intensity: 0.5 }, perceived_user: null })
  }

  function countRows(sessionId: string): Record<string, number> {
    const count = (sql: string) => (db.prepare(sql).get(sessionId) as { c: number }).c
    return {
      sessions: count('SELECT COUNT(*) AS c FROM Sessions WHERE sessionId = ?'),
      messages: count('SELECT COUNT(*) AS c FROM Messages WHERE sessionId = ?'),
      embeddings: count('SELECT COUNT(*) AS c FROM message_embeddings WHERE session_id = ?'),
      fts: count('SELECT COUNT(*) AS c FROM message_fts WHERE session_id = ?'),
      entities: count('SELECT COUNT(*) AS c FROM MessageEntities WHERE sessionId = ?'),
      summaries: count('SELECT COUNT(*) AS c FROM Summaries WHERE sessionId = ?'),
      emotions: count('SELECT COUNT(*) AS c FROM EmotionStates WHERE sessionId = ?'),
    }
  }

  it('presetId 不存在时返回 404', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'DELETE', url: '/presets/does-not-exist' })

    expect(response.statusCode).toBe(404)
  })

  it('只剩一个角色时返回 409，该角色不被删除', async () => {
    db.prepare('DELETE FROM Presets WHERE presetId = ?').run('p2')
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'DELETE', url: '/presets/p1' })

    expect(response.statusCode).toBe(409)
    expect(getPresetById('p1')).not.toBeNull()
  })

  it('删除非当前角色：该角色及其全部数据被删除，当前角色不变且不广播切换，其他角色数据不受影响', async () => {
    const p2Session = makeSession('p2', 'sess-p2', 1000)
    seedSessionData(p2Session)
    const { session: p1Session } = loadSession('p1')
    seedSessionData(p1Session.sessionId)
    const p1Before = countRows(p1Session.sessionId)
    expect(p1Before).toEqual({ sessions: 1, messages: 1, embeddings: 1, fts: 1, entities: 1, summaries: 1, emotions: 1 })
    expect(countRows(p2Session).messages).toBe(1)
    vi.mocked(BroadcastModule.broadcastEvent).mockClear()
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'DELETE', url: '/presets/p2' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.presetId).toBe('p1')
    expect(getPresetById('p2')).toBeNull()
    expect(countRows(p2Session)).toEqual({ sessions: 0, messages: 0, embeddings: 0, fts: 0, entities: 0, summaries: 0, emotions: 0 })
    expect(countRows(p1Session.sessionId)).toEqual(p1Before)
    expect(getPresetById('p1')).not.toBeNull()
    expect(BroadcastModule.broadcastEvent).not.toHaveBeenCalled()
  })

  it('删除当前角色：先切换到最近活跃（最新会话 lastActiveAt 最大）的其他角色，再删除，响应为切换后的状态', async () => {
    upsertPreset({ presetId: 'p3', name: '角色三', characterId: 'char-003', modelType: 'ollama', modelName: 'qwen3', systemPrompt: '你是角色三' })
    upsertPreset({ presetId: 'p4', name: '角色四', characterId: 'char-004', modelType: 'ollama', modelName: 'qwen3', systemPrompt: '你是角色四' })
    makeSession('p2', 'sess-p2', 1000)
    makeSession('p3', 'sess-p3', 5000)
    const { session: p1Session } = loadSession('p1')
    seedSessionData(p1Session.sessionId)
    vi.mocked(BroadcastModule.broadcastEvent).mockClear()
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'DELETE', url: '/presets/p1' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.presetSnapshot.presetId).toBe('p3')
    expect(getCurrentState()!.preset.presetId).toBe('p3')
    expect(BroadcastModule.broadcastEvent).toHaveBeenCalledWith('preset-switched', { sessionId: 'sess-p3', presetId: 'p3' })
    expect(getPresetById('p1')).toBeNull()
    expect(countRows(p1Session.sessionId)).toEqual({ sessions: 0, messages: 0, embeddings: 0, fts: 0, entities: 0, summaries: 0, emotions: 0 })
    expect(getPresetById('p2')).not.toBeNull()
    expect(getPresetById('p4')).not.toBeNull()
  })

  it('其他角色都没有会话时，切换到 createdAt 最新的那个', async () => {
    upsertPreset({ presetId: 'p3', name: '角色三', characterId: 'char-003', modelType: 'ollama', modelName: 'qwen3', systemPrompt: '你是角色三' })
    db.prepare('UPDATE Presets SET createdAt = ? WHERE presetId = ?').run(1000, 'p2')
    db.prepare('UPDATE Presets SET createdAt = ? WHERE presetId = ?').run(2000, 'p3')
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'DELETE', url: '/presets/p1' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload).presetSnapshot.presetId).toBe('p3')
  })

  it('删除当前角色时切换到最近活跃角色因非「角色不存在」错误失败：返回 500，不删除任何数据也不删壁纸', async () => {
    fs.mkdirSync(WALLPAPER_DIR, { recursive: true })
    writtenFiles.push('p1-wallpaper.png')
    fs.writeFileSync(path.join(WALLPAPER_DIR, 'p1-wallpaper.png'), Buffer.from([1]))
    const { session: p1Session } = loadSession('p1')
    seedSessionData(p1Session.sessionId)
    const p1Before = countRows(p1Session.sessionId)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSession).mockImplementationOnce(() => {
      throw new Error('db write failed')
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'DELETE', url: '/presets/p1' })

    expect(response.statusCode).toBe(500)
    expect(getPresetById('p1')).not.toBeNull()
    expect(getPresetById('p2')).not.toBeNull()
    expect(countRows(p1Session.sessionId)).toEqual(p1Before)
    expect(fs.existsSync(path.join(WALLPAPER_DIR, 'p1-wallpaper.png'))).toBe(true)
    expect(errorSpy).toHaveBeenCalledWith('[Presets] Switch before delete failed:', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('删除时移除该角色的壁纸文件，不动其他角色的壁纸', async () => {
    fs.mkdirSync(WALLPAPER_DIR, { recursive: true })
    writtenFiles.push('p2-wallpaper.png', 'p1-wallpaper.png')
    fs.writeFileSync(path.join(WALLPAPER_DIR, 'p2-wallpaper.png'), Buffer.from([1]))
    fs.writeFileSync(path.join(WALLPAPER_DIR, 'p1-wallpaper.png'), Buffer.from([2]))
    loadSession('p1')
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'DELETE', url: '/presets/p2' })

    expect(response.statusCode).toBe(200)
    expect(fs.existsSync(path.join(WALLPAPER_DIR, 'p2-wallpaper.png'))).toBe(false)
    expect(fs.existsSync(path.join(WALLPAPER_DIR, 'p1-wallpaper.png'))).toBe(true)
  })
})

// ─── buildStatePayload — displayConfig 现查覆盖（与 wallpaperPath/name 同款行为）────
describe('buildStatePayload — displayConfig 现查覆盖', () => {
  it('updatePresetDisplayConfig 直接更新 DB 后，buildStatePayload 返回新值而非冻结快照里的默认值', async () => {
    loadSession('p1')
    // 会话创建时冻结快照里的 displayConfig 是 p1 当时的默认值
    const before = await buildStatePayload()
    expect(before.presetSnapshot?.displayConfig).toEqual(DEFAULT_DISPLAY_CONFIG)

    updatePresetDisplayConfig('p1', { ...DEFAULT_DISPLAY_CONFIG, chatBgRgb: [200, 0, 0], chatBgOpacity: 0.9 })

    const after = await buildStatePayload()
    expect(after.presetSnapshot?.displayConfig).toEqual({ ...DEFAULT_DISPLAY_CONFIG, chatBgRgb: [200, 0, 0], chatBgOpacity: 0.9 })
  })
})

// ─── buildStatePayload — systemPrompt 现查覆盖（第四个字段，与前三个同款行为）────
describe('buildStatePayload — systemPrompt 现查覆盖', () => {
  it('updatePresetSystemPrompt 直接更新 DB 后，buildStatePayload 返回新值而非冻结快照里的旧人设——但这只影响展示，不影响 current.preset', async () => {
    loadSession('p1')
    // 会话创建时冻结快照里的 systemPrompt 是 p1 当时 seed 的值
    const before = await buildStatePayload()
    expect(before.presetSnapshot?.systemPrompt).toBe('你是角色一')

    updatePresetSystemPrompt('p1', '你是全新的角色一')

    // 只是"展示层"现读覆盖：applyNow 没有被调用，模型实际会用到的 current.preset.systemPrompt
    // 必须仍然是旧值，不能因为扩展了 buildStatePayload 就意外提前生效
    expect(getCurrentState()!.preset.systemPrompt).toBe('你是角色一')

    const after = await buildStatePayload()
    expect(after.presetSnapshot?.systemPrompt).toBe('你是全新的角色一')
  })
})

// ─── buildStatePayload — modelType/modelName 现查覆盖（第五/六个字段）────
describe('buildStatePayload — modelType/modelName 现查覆盖', () => {
  it('updatePresetModelConfig 直接更新 DB 后，buildStatePayload 返回新值而非冻结快照里的旧模型覆盖', async () => {
    loadSession('p1')
    // 会话创建时冻结快照里的 modelType/modelName 是 p1 当时 seed 的值
    const before = await buildStatePayload()
    expect(before.presetSnapshot?.modelType).toBe('ollama')
    expect(before.presetSnapshot?.modelName).toBe('qwen3')

    updatePresetModelConfig('p1', 'openai', 'gpt-4o-mini')

    const afterSet = await buildStatePayload()
    expect(afterSet.presetSnapshot?.modelType).toBe('openai')
    expect(afterSet.presetSnapshot?.modelName).toBe('gpt-4o-mini')

    // 清除覆盖（都设为 null）也要能正确反映为 null，而不是误回退到冻结快照里的旧值
    // （preset.modelType 本身合法为 null，不能用 `preset?.modelType ?? frozenSnapshot.modelType`
    // 这种写法，否则 null 会被误当成"取不到值"）
    updatePresetModelConfig('p1', null, null)

    const afterClear = await buildStatePayload()
    expect(afterClear.presetSnapshot?.modelType).toBeNull()
    expect(afterClear.presetSnapshot?.modelName).toBeNull()
    // 清除覆盖后这个 preset 跟随全局对话模型（mock 里 type 为 'ollama'），buildStatePayload
    // 判断是否需要检测 Ollama 运行状态时必须看这个"实际生效"的 type，不能因为 snapshot 自己
    // 的 modelType 字段是 null 就跳过检测——ollamaReady 应为一个真正检测过的 boolean（false
    // 也算检测过，代表本机没有 Ollama 在跑），而不是代表"不适用"的 null
    expect(afterClear.ollamaReady).not.toBeNull()
  })
})

describe('GET /presets/:presetId/model-keys', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM PresetApiKeys`)
  })

  it('只返回 hasKey / last4 / fromEnv：长 key 取末 4 位，不足 8 位不给 last4，从不返回完整 key', async () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-openai-1234567890' })
    upsertPresetApiKey('p1', { provider: 'deepseek', apiKey: 'short' })
    upsertPresetApiKey('p1', { provider: 'anthropic', fromEnv: true })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/presets/p1/model-keys' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({
      anthropic: { hasKey: false, last4: null, fromEnv: true, summary: { hasKey: false, last4: null, fromEnv: false } },
      openai: { hasKey: true, last4: '7890', fromEnv: false, summary: { hasKey: false, last4: null, fromEnv: false } },
      deepseek: { hasKey: true, last4: null, fromEnv: false, summary: { hasKey: false, last4: null, fromEnv: false } },
    })
    expect(response.payload).not.toContain('sk-openai-1234567890')
    expect(response.payload).not.toContain('short')
  })

  it('没有任何 key 行时三家都是 hasKey=false', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/presets/p2/model-keys' })

    expect(JSON.parse(response.payload)).toEqual({
      anthropic: { hasKey: false, last4: null, fromEnv: false, summary: { hasKey: false, last4: null, fromEnv: false } },
      openai: { hasKey: false, last4: null, fromEnv: false, summary: { hasKey: false, last4: null, fromEnv: false } },
      deepseek: { hasKey: false, last4: null, fromEnv: false, summary: { hasKey: false, last4: null, fromEnv: false } },
    })
  })

  it('未知 preset 返回 404', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/presets/missing/model-keys' })

    expect(response.statusCode).toBe(404)
  })
})

describe('PATCH /presets/:presetId — 角色 API Key', () => {
  async function patch(payload: Record<string, unknown>, presetId = 'p1') {
    const fastify = await buildTestApp()
    return fastify.inject({ method: 'PATCH', url: `/presets/${presetId}`, payload })
  }

  beforeEach(() => {
    db.exec(`DELETE FROM PresetApiKeys`)
    vi.mocked(isEnvCredentialDetected).mockReset()
    vi.mocked(isEnvCredentialDetected).mockReturnValue(false)
  })

  it('apiKey 随 modelType 保存：去掉首尾空白后写入该 provider 的行', async () => {
    const response = await patch({ modelType: 'openai', modelName: 'gpt-4o-mini', apiKey: '  sk-role-key  ' })

    expect(response.statusCode).toBe(200)
    expect(getPresetById('p1')!.modelType).toBe('openai')
    expect(getPresetApiKeys('p1').openai).toEqual({ apiKey: 'sk-role-key', fromEnv: false, summaryFromEnv: false })
    expect(getPresetApiKeys('p1').anthropic).toEqual({ fromEnv: false, summaryFromEnv: false })
  })

  it('空串或全空白 apiKey 被忽略，已保存的 key 不变', async () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-saved-key' })

    const empty = await patch({ modelType: 'openai', modelName: 'gpt-4o-mini', apiKey: '' })
    const blank = await patch({ modelType: 'openai', modelName: 'gpt-4o', apiKey: '   ' })

    expect(empty.statusCode).toBe(200)
    expect(blank.statusCode).toBe(200)
    expect(getPresetApiKeys('p1').openai).toEqual({ apiKey: 'sk-saved-key', fromEnv: false, summaryFromEnv: false })
  })

  it('空 apiKey 且没有已保存的 key 时按未配置处理，返回 400', async () => {
    const response = await patch({ modelType: 'openai', modelName: 'gpt-4o-mini', apiKey: '  ' })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toBe('API key 无效或未配置')
  })

  it('apiKeyFromEnv 由 false 变 true 且未检测到环境变量：400 且什么都不写', async () => {
    const response = await patch({ name: '新名字', modelType: 'openai', modelName: 'gpt-4o-mini', apiKey: 'sk-role-key', apiKeyFromEnv: true })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toBe('未检测到环境变量 OPENAI_API_KEY')
    expect(getPresetById('p1')!.name).toBe('角色一')
    expect(getPresetById('p1')!.modelType).toBe('ollama')
    expect(getPresetApiKeys('p1').openai).toEqual({ fromEnv: false, summaryFromEnv: false })
  })

  it('apiKeyFromEnv 由 false 变 true 且检测到环境变量：写入 fromEnv，不需要保存的 key', async () => {
    vi.mocked(isEnvCredentialDetected).mockReturnValue(true)

    const response = await patch({ modelType: 'deepseek', modelName: 'deepseek-v4-flash', apiKeyFromEnv: true })

    expect(response.statusCode).toBe(200)
    expect(getPresetApiKeys('p1').deepseek).toEqual({ fromEnv: true, summaryFromEnv: false })
  })

  it('已保存为 true 的 apiKeyFromEnv 再次提交不触发"未检测到环境变量"，环境可用时通过', async () => {
    upsertPresetApiKey('p1', { provider: 'openai', fromEnv: true })
    vi.mocked(isEnvCredentialDetected).mockReturnValue(true)

    const response = await patch({ modelType: 'openai', modelName: 'gpt-4o-mini', apiKeyFromEnv: true })

    expect(response.statusCode).toBe(200)
    expect(getPresetApiKeys('p1').openai).toEqual({ fromEnv: true, summaryFromEnv: false })
  })

  it('已保存为 true 的 apiKeyFromEnv 再次提交但环境变量已丢失：不报"未检测到环境变量"，按未配置 400', async () => {
    upsertPresetApiKey('p1', { provider: 'openai', fromEnv: true })

    const response = await patch({ modelType: 'openai', modelName: 'gpt-4o-mini', apiKeyFromEnv: true })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toBe('API key 无效或未配置')
  })

  it('key provider 未配置（无 key、未勾选环境变量）：400 且 name 等其它字段也不写', async () => {
    const response = await patch({ name: '新名字', systemPrompt: '新人设', modelType: 'anthropic', modelName: 'claude-sonnet' })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toBe('API key 无效或未配置')
    const preset = getPresetById('p1')!
    expect(preset.name).toBe('角色一')
    expect(preset.systemPrompt).toBe('你是角色一')
    expect(preset.modelType).toBe('ollama')
    expect(getPresetApiKeys('p1').anthropic).toEqual({ fromEnv: false, summaryFromEnv: false })
  })

  it('勾选环境变量但环境不可用：400', async () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-saved-key', fromEnv: true })

    const response = await patch({ modelType: 'openai', modelName: 'gpt-4o-mini' })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toBe('API key 无效或未配置')
  })

  it('取消勾选环境变量且已有保存的 key：通过，写入 fromEnv=false 并保留 key', async () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-saved-key', fromEnv: true })

    const response = await patch({ modelType: 'openai', modelName: 'gpt-4o-mini', apiKeyFromEnv: false })

    expect(response.statusCode).toBe(200)
    expect(getPresetApiKeys('p1').openai).toEqual({ apiKey: 'sk-saved-key', fromEnv: false, summaryFromEnv: false })
  })

  it('只带 apiKey（不带 modelType）时作用于已保存的 modelType', async () => {
    updatePresetModelConfig('p1', 'openai', 'gpt-4o')

    const response = await patch({ apiKey: 'sk-new-key' })

    expect(response.statusCode).toBe(200)
    expect(getPresetApiKeys('p1').openai).toEqual({ apiKey: 'sk-new-key', fromEnv: false, summaryFromEnv: false })
    expect(getPresetById('p1')!.modelName).toBe('gpt-4o')
  })

  it('只带 apiKey 且已保存的 modelType 是 ollama：400', async () => {
    const response = await patch({ apiKey: 'sk-new-key' })

    expect(response.statusCode).toBe(400)
    expect(getPresetApiKeys('p1').openai).toEqual({ fromEnv: false, summaryFromEnv: false })
  })

  it('apiKey / apiKeyFromEnv 与 modelType=ollama 或 null 同时出现：400，不写任何东西', async () => {
    const withOllama = await patch({ modelType: 'ollama', modelName: 'llama3', apiKey: 'sk-x' })
    const withNull = await patch({ modelType: null, modelName: null, apiKey: 'sk-x' })
    const flagWithNull = await patch({ modelType: null, modelName: null, apiKeyFromEnv: true })

    expect(withOllama.statusCode).toBe(400)
    expect(withNull.statusCode).toBe(400)
    expect(flagWithNull.statusCode).toBe(400)
    expect(getPresetById('p1')!.modelName).toBe('qwen3')
    expect(db.prepare(`SELECT COUNT(*) AS count FROM PresetApiKeys`).get()).toEqual({ count: 0 })
  })

  it('modelType 设为 null（跟随全局）时不触碰已有的 key 行', async () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-saved-key', fromEnv: true })

    const response = await patch({ modelType: null, modelName: null })

    expect(response.statusCode).toBe(200)
    expect(getPresetApiKeys('p1').openai).toEqual({ apiKey: 'sk-saved-key', fromEnv: true, summaryFromEnv: false })
  })

  it('不含模型相关字段的 PATCH（name / systemPrompt / displayConfig）不校验 key，即使当前已是未配置 key 的 key provider', async () => {
    updatePresetModelConfig('p1', 'anthropic', 'claude-sonnet')

    const byName = await patch({ name: '改名' })
    const byPrompt = await patch({ systemPrompt: '新人设' })
    const byDisplay = await patch({ displayConfig: { chatBgOpacity: 0.5 } })

    expect(byName.statusCode).toBe(200)
    expect(byPrompt.statusCode).toBe(200)
    expect(byDisplay.statusCode).toBe(200)
    expect(getPresetById('p1')!.name).toBe('改名')
  })

  it('applyNow: true 时内存中的角色凭据立即刷新；缺省时不刷新', async () => {
    loadSession('p1')
    expect(getCurrentState()!.credentials.openai).toEqual({ fromEnv: false, summaryFromEnv: false })

    await patch({ modelType: 'openai', modelName: 'gpt-4o-mini', apiKey: 'sk-later' })
    expect(getCurrentState()!.credentials.openai).toEqual({ fromEnv: false, summaryFromEnv: false })
    expect(getCurrentState()!.preset.modelType).toBe('ollama')

    await patch({ modelType: 'openai', modelName: 'gpt-4o-mini', apiKey: 'sk-now', applyNow: true })
    expect(getCurrentState()!.credentials.openai).toEqual({ apiKey: 'sk-now', fromEnv: false, summaryFromEnv: false })
    expect(getCurrentState()!.preset.modelType).toBe('openai')
  })

  it('响应、/state 载荷、GET /presets、广播与日志里都不出现 key', async () => {
    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
    loadSession('p1')
    const fastify = await buildTestApp()

    const patched = await fastify.inject({
      method: 'PATCH',
      url: '/presets/p1',
      payload: { modelType: 'openai', modelName: 'gpt-4o-mini', apiKey: 'sk-top-secret-value', applyNow: true },
    })
    const list = await fastify.inject({ method: 'GET', url: '/presets' })
    const state = JSON.stringify(await buildStatePayload())

    expect(patched.statusCode).toBe(200)
    expect(patched.payload).not.toContain('sk-top-secret-value')
    expect(list.payload).not.toContain('sk-top-secret-value')
    expect(state).not.toContain('sk-top-secret-value')
    expect(JSON.stringify(getPresetById('p1'))).not.toContain('sk-top-secret-value')
    expect(JSON.stringify(getCurrentState()!.session.presetSnapshot)).not.toContain('sk-top-secret-value')
    expect(JSON.stringify(vi.mocked(BroadcastModule.broadcastEvent).mock.calls)).not.toContain('sk-top-secret-value')
    expect(JSON.stringify(logSpies.map(spy => spy.mock.calls))).not.toContain('sk-top-secret-value')
  })

  it('apiKey 不是字符串、apiKeyFromEnv 不是布尔时返回 400', async () => {
    const badKey = await patch({ modelType: 'openai', modelName: 'gpt-4o', apiKey: 123 })
    const badFlag = await patch({ modelType: 'openai', modelName: 'gpt-4o', apiKey: 'sk-x', apiKeyFromEnv: 'yes' })

    expect(badKey.statusCode).toBe(400)
    expect(badFlag.statusCode).toBe(400)
  })

  it('DELETE /presets/:presetId 同时删除该角色的 key 行', async () => {
    upsertPresetApiKey('p2', { provider: 'openai', apiKey: 'sk-p2-key' })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'DELETE', url: '/presets/p2' })

    expect(response.statusCode).toBe(200)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM PresetApiKeys WHERE presetId = 'p2'`).get()).toEqual({ count: 0 })
  })
})

describe('角色摘要模型与摘要 key', () => {
  async function patch(payload: Record<string, unknown>, presetId = 'p1') {
    const fastify = await buildTestApp()
    return fastify.inject({ method: 'PATCH', url: `/presets/${presetId}`, payload })
  }

  beforeEach(() => {
    db.exec(`DELETE FROM PresetApiKeys`)
    vi.mocked(isEnvCredentialDetected).mockReset()
    vi.mocked(isEnvCredentialDetected).mockReturnValue(false)
    updatePresetModelConfig('p1', 'openai', 'gpt-4o')
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-chat-key' })
  })

  it('GET model-keys 同时返回对话与摘要两套脱敏信息，从不返回完整 key', async () => {
    upsertPresetApiKey('p1', { provider: 'openai', summaryApiKey: 'sk-summary-1234567890', summaryFromEnv: true })
    upsertPresetApiKey('p1', { provider: 'deepseek', summaryApiKey: 'short' })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/presets/p1/model-keys' })

    expect(JSON.parse(response.payload)).toEqual({
      anthropic: { hasKey: false, last4: null, fromEnv: false, summary: { hasKey: false, last4: null, fromEnv: false } },
      openai: { hasKey: true, last4: '-key', fromEnv: false, summary: { hasKey: true, last4: '7890', fromEnv: true } },
      deepseek: { hasKey: false, last4: null, fromEnv: false, summary: { hasKey: true, last4: null, fromEnv: false } },
    })
    expect(response.payload).not.toContain('sk-summary-1234567890')
    expect(response.payload).not.toContain('sk-chat-key')
  })

  it('摘要模型与摘要 key 一起保存：模型名去空白，key 去空白，写入摘要列而不是对话列', async () => {
    const response = await patch({ summaryModelType: 'deepseek', summaryModelName: '  deepseek-v4-flash  ', summaryApiKey: '  sk-ds-summary  ' })

    expect(response.statusCode).toBe(200)
    const preset = getPresetById('p1')!
    expect(preset.modelType).toBe('openai')
    expect(preset.modelName).toBe('gpt-4o')
    expect(preset.summaryModelType).toBe('deepseek')
    expect(preset.summaryModelName).toBe('deepseek-v4-flash')
    expect(getPresetApiKeys('p1').deepseek).toEqual({ fromEnv: false, summaryApiKey: 'sk-ds-summary', summaryFromEnv: false })
    expect(getPresetApiKeys('p1').openai.apiKey).toBe('sk-chat-key')
  })

  it('摘要用同一 provider 但不同模型时仍要求摘要 key，不借用对话 key', async () => {
    const response = await patch({ summaryModelType: 'openai', summaryModelName: 'gpt-4o-mini' })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toBe('摘要模型的 API key 无效或未配置')
    expect(getPresetById('p1')!.summaryModelType).toBeNull()
  })

  it('摘要 provider 未配置：400 且 name 等其它字段、摘要列都不写', async () => {
    const response = await patch({ name: '新名字', summaryModelType: 'anthropic', summaryModelName: 'claude-sonnet' })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toBe('摘要模型的 API key 无效或未配置')
    const preset = getPresetById('p1')!
    expect(preset.name).toBe('角色一')
    expect(preset.summaryModelType).toBeNull()
    expect(getPresetApiKeys('p1').anthropic.summaryApiKey).toBeUndefined()
  })

  it('summaryModelType 与 summaryModelName 必须同时提供，设置类型时模型名必填，null 时模型名必须为 null', async () => {
    const onlyType = await patch({ summaryModelType: 'ollama' })
    const onlyName = await patch({ summaryModelName: 'qwen3' })
    const emptyName = await patch({ summaryModelType: 'ollama', summaryModelName: '   ' })
    const nullWithName = await patch({ summaryModelType: null, summaryModelName: 'qwen3' })
    const badType = await patch({ summaryModelType: 'gemini', summaryModelName: 'x' })

    for (const response of [onlyType, onlyName, emptyName, nullWithName, badType]) {
      expect(response.statusCode).toBe(400)
    }
    expect(getPresetById('p1')!.summaryModelType).toBeNull()
  })

  it('summaryModelType 为 ollama 时只需模型名，不要求 key', async () => {
    const response = await patch({ summaryModelType: 'ollama', summaryModelName: 'qwen3' })

    expect(response.statusCode).toBe(200)
    expect(getPresetById('p1')!.summaryModelType).toBe('ollama')
    expect(getPresetById('p1')!.summaryModelName).toBe('qwen3')
  })

  it('summaryModelType 与 summaryModelName 为 null 时清空摘要模型，摘要 key 保持不变', async () => {
    await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash', summaryApiKey: 'sk-ds-summary' })

    const response = await patch({ summaryModelType: null, summaryModelName: null })

    expect(response.statusCode).toBe(200)
    expect(getPresetById('p1')!.summaryModelType).toBeNull()
    expect(getPresetById('p1')!.summaryModelName).toBeNull()
    expect(getPresetApiKeys('p1').deepseek.summaryApiKey).toBe('sk-ds-summary')
  })

  it('空串或全空白 summaryApiKey 被忽略，已保存的摘要 key 不变', async () => {
    await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash', summaryApiKey: 'sk-ds-summary' })

    const empty = await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-pro', summaryApiKey: '' })
    const blank = await patch({ summaryApiKey: '   ', name: '改名' })

    expect(empty.statusCode).toBe(200)
    expect(blank.statusCode).toBe(200)
    expect(getPresetApiKeys('p1').deepseek.summaryApiKey).toBe('sk-ds-summary')
    expect(getPresetById('p1')!.summaryModelName).toBe('deepseek-v4-pro')
  })

  it('只带 summaryApiKey 时作用于已保存的 summaryModelType，不动模型列', async () => {
    await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash', summaryApiKey: 'sk-ds-old' })

    const response = await patch({ summaryApiKey: 'sk-ds-new' })

    expect(response.statusCode).toBe(200)
    expect(getPresetApiKeys('p1').deepseek.summaryApiKey).toBe('sk-ds-new')
    expect(getPresetById('p1')!.summaryModelName).toBe('deepseek-v4-flash')
    expect(getPresetById('p1')!.modelName).toBe('gpt-4o')
  })

  it('summaryApiKeyFromEnv 由 false 变 true 且未检测到环境变量：400 且什么都不写', async () => {
    const response = await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash', summaryApiKey: 'sk-ds', summaryApiKeyFromEnv: true })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toBe('未检测到环境变量 DEEPSEEK_API_KEY')
    expect(getPresetById('p1')!.summaryModelType).toBeNull()
    expect(getPresetApiKeys('p1').deepseek.summaryApiKey).toBeUndefined()
  })

  it('summaryApiKeyFromEnv 由 false 变 true 且检测到环境变量：写入 summaryFromEnv；已保存为 true 时再次提交不报未检测到，环境丢失时按未配置 400', async () => {
    vi.mocked(isEnvCredentialDetected).mockReturnValue(true)

    const first = await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash', summaryApiKeyFromEnv: true })
    vi.mocked(isEnvCredentialDetected).mockReturnValue(false)
    const second = await patch({ summaryApiKeyFromEnv: true })

    expect(first.statusCode).toBe(200)
    expect(getPresetApiKeys('p1').deepseek.summaryFromEnv).toBe(true)
    expect(second.statusCode).toBe(400)
    expect(JSON.parse(second.payload).error).toBe('摘要模型的 API key 无效或未配置')
  })

  it('摘要 key 字段与 ollama 或 null 的结果摘要模型同时出现：400，不写任何东西', async () => {
    await patch({ summaryModelType: 'ollama', summaryModelName: 'qwen3' })

    const keyWithOllama = await patch({ summaryApiKey: 'sk-x' })
    const flagWithOllama = await patch({ summaryApiKeyFromEnv: true })
    const keyWithNull = await patch({ summaryModelType: null, summaryModelName: null, summaryApiKey: 'sk-x' })

    expect(keyWithOllama.statusCode).toBe(400)
    expect(flagWithOllama.statusCode).toBe(400)
    expect(keyWithNull.statusCode).toBe(400)
    expect(getPresetById('p1')!.summaryModelType).toBe('ollama')
    expect(db.prepare(`SELECT COUNT(*) AS count FROM PresetApiKeys WHERE summaryApiKey IS NOT NULL`).get()).toEqual({ count: 0 })
  })

  it('结果角色使用全局配置时任何摘要字段都返回 400', async () => {
    const globalPatch = await patch({ modelType: null, modelName: null, summaryModelType: 'ollama', summaryModelName: 'qwen3' })
    updatePresetModelConfig('p2', null, null)
    const alreadyGlobal = await patch({ summaryModelType: 'ollama', summaryModelName: 'qwen3' }, 'p2')
    const keyOnGlobal = await patch({ summaryApiKey: 'sk-x' }, 'p2')
    const clearOnGlobal = await patch({ summaryModelType: null, summaryModelName: null }, 'p2')

    for (const response of [globalPatch, alreadyGlobal, keyOnGlobal, clearOnGlobal]) {
      expect(response.statusCode).toBe(400)
    }
    expect(getPresetById('p1')!.modelType).toBe('openai')
    expect(getPresetById('p2')!.summaryModelType).toBeNull()
  })

  it('改成全局配置时保留已有的摘要模型与摘要 key', async () => {
    await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash', summaryApiKey: 'sk-ds-summary' })

    const response = await patch({ modelType: null, modelName: null })

    expect(response.statusCode).toBe(200)
    expect(getPresetById('p1')!.summaryModelType).toBe('deepseek')
    expect(getPresetById('p1')!.summaryModelName).toBe('deepseek-v4-flash')
    expect(getPresetApiKeys('p1').deepseek.summaryApiKey).toBe('sk-ds-summary')
  })

  it('摘要 key 写入后执行 WAL checkpoint(TRUNCATE)', async () => {
    const pragma = vi.spyOn(db, 'pragma')

    await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash', summaryApiKey: 'sk-ds-summary' })

    expect(pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)')
  })

  it('summaryApiKey 不是字符串、summaryApiKeyFromEnv 不是布尔时返回 400', async () => {
    const badKey = await patch({ summaryModelType: 'deepseek', summaryModelName: 'x', summaryApiKey: 123 })
    const badFlag = await patch({ summaryModelType: 'deepseek', summaryModelName: 'x', summaryApiKey: 'sk-x', summaryApiKeyFromEnv: 'yes' })

    expect(badKey.statusCode).toBe(400)
    expect(badFlag.statusCode).toBe(400)
  })

  it('applyNow: true 时内存中的摘要模型与摘要凭据立即刷新；缺省时不刷新', async () => {
    loadSession('p1')

    await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash', summaryApiKey: 'sk-later' })
    expect(getCurrentState()!.preset.summaryModelType).toBeNull()
    expect(getCurrentState()!.credentials.deepseek.summaryApiKey).toBeUndefined()

    await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash', summaryApiKey: 'sk-now', applyNow: true })
    expect(getCurrentState()!.preset.summaryModelType).toBe('deepseek')
    expect(getCurrentState()!.preset.summaryModelName).toBe('deepseek-v4-flash')
    expect(getCurrentState()!.credentials.deepseek.summaryApiKey).toBe('sk-now')
  })

  it('/state 的 presetSnapshot 带 summaryModelType / summaryModelName，响应与 /state 里都没有摘要 key', async () => {
    loadSession('p1')

    const patched = await patch({ summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash', summaryApiKey: 'sk-summary-secret' })
    const state = await buildStatePayload()

    expect(patched.statusCode).toBe(200)
    expect(JSON.parse(patched.payload).presetSnapshot.summaryModelType).toBe('deepseek')
    expect(JSON.parse(patched.payload).presetSnapshot.summaryModelName).toBe('deepseek-v4-flash')
    expect(state.presetSnapshot?.summaryModelType).toBe('deepseek')
    expect(state.presetSnapshot?.summaryModelName).toBe('deepseek-v4-flash')
    expect(patched.payload).not.toContain('sk-summary-secret')
    expect(JSON.stringify(state)).not.toContain('sk-summary-secret')
    expect(JSON.stringify(getCurrentState()!.session.presetSnapshot)).not.toContain('sk-summary-secret')
  })
})

describe('PATCH /presets/:presetId — 错误文案', () => {
  async function patch(payload: Record<string, unknown>) {
    const fastify = await buildTestApp()
    return fastify.inject({ method: 'PATCH', url: '/presets/p1', payload })
  }

  beforeEach(() => {
    db.exec(`DELETE FROM PresetApiKeys`)
    vi.mocked(isEnvCredentialDetected).mockReset()
    vi.mocked(isEnvCredentialDetected).mockReturnValue(false)
  })

  it('对话 key 与摘要 key 都未配置时报对话 key 的文案', async () => {
    const response = await patch({
      modelType: 'openai',
      modelName: 'gpt-4o',
      summaryModelType: 'deepseek',
      summaryModelName: 'deepseek-v4-flash',
    })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toBe('API key 无效或未配置')
  })

  it('只有摘要 key 未配置时报摘要专用文案', async () => {
    upsertPresetApiKey('p1', { provider: 'openai', apiKey: 'sk-chat-key' })

    const response = await patch({
      modelType: 'openai',
      modelName: 'gpt-4o',
      summaryModelType: 'deepseek',
      summaryModelName: 'deepseek-v4-flash',
    })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload).error).toBe('摘要模型的 API key 无效或未配置')
  })

  it('没有任何可更新字段时文案列出全部可更新字段', async () => {
    const response = await patch({})

    expect(response.statusCode).toBe(400)
    const message = JSON.parse(response.payload).error as string
    for (const field of ['name', 'displayConfig', 'systemPrompt', 'modelType', 'modelName', 'apiKey', 'apiKeyFromEnv', 'summaryModelType', 'summaryModelName', 'summaryApiKey', 'summaryApiKeyFromEnv']) {
      expect(message).toContain(field)
    }
  })
})
