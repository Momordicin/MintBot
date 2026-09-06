import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fs from 'fs'
import path from 'path'
import { initDb, db } from '../db/index.js'
import { upsertPreset, getPresetById, updatePresetDisplayConfig, updatePresetSystemPrompt, updatePresetModelConfig, getEmotionState, upsertEmotionState } from '../session/queries.js'
import { DEFAULT_DISPLAY_CONFIG } from '../session/displayConfig.js'
import { loadSession, getCurrentState } from '../session/index.js'
import { presetRoutes } from './presets.js'
import { buildStatePayload } from '../state.js'

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

    const filePath = path.resolve(process.cwd(), 'data/wallpapers', savedFilename)
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

    const leftoverTmp = fs.readdirSync(path.resolve(process.cwd(), 'data/wallpapers'))
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
      payload: { modelType: 'openai', modelName: 'gpt-4o-mini' },
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
      payload: { modelType: 'deepseek', modelName: 'deepseek-v4-flash' },
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
      payload: { modelType: 'openai', modelName: 'gpt-4o-mini', applyNow: true },
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
