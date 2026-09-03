import { describe, it, expect, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fs from 'fs'
import path from 'path'
import { characterImportRoutes } from './characterImport.js'
import { CHARACTERS_ROOT } from '../characters/manifest.js'

async function buildTestApp() {
  const fastify = Fastify()
  // 路由内部读取 fastify.backgroundModelProvider（POST /characters/import/generate），
  // 测试自己 decorate 一份假实现，不依赖真实的 services/core/index.ts 启动流程
  fastify.decorate('backgroundModelProvider', { completeSync: vi.fn() } as any)
  await fastify.register(characterImportRoutes)
  return fastify
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function buildChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
}

function buildPngFixture(name: string): Buffer {
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: '测试角色',
      personality: '',
      scenario: '',
      mes_example: '',
      system_prompt: '',
      creator_notes: '',
      tags: [],
      creator: '',
      character_version: '',
    },
  }
  const text = Buffer.from(JSON.stringify(card), 'utf-8').toString('base64')
  const data = Buffer.concat([Buffer.from('ccv3', 'latin1'), Buffer.from([0x00]), Buffer.from(text, 'latin1')])
  return Buffer.concat([PNG_SIGNATURE, buildChunk('tEXt', data), buildChunk('IEND', Buffer.alloc(0))])
}

describe('POST /characters/import/parse', () => {
  it('成功解析 V2 JSON 卡片，返回精简 DTO，creatorNotes 与 systemPrompt 是分开的字段', async () => {
    const fastify = await buildTestApp()
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Mint',
        description: '一只猫娘',
        personality: '开朗',
        scenario: '',
        mes_example: '',
        system_prompt: '',
        creator_notes: '备注内容',
        tags: ['a'],
        creator: 'someone',
        character_version: '1.0',
      },
    }

    const response = await fastify.inject({
      method: 'POST',
      url: '/characters/import/parse',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('mint.json') },
      payload: Buffer.from(JSON.stringify(card), 'utf-8'),
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.name).toBe('Mint')
    expect(body.suggestedCharacterId).toBe('Mint')
    expect(body.tags).toEqual(['a'])
    expect(body.creator).toBe('someone')
    expect(body.creatorNotes).toBe('备注内容')
    expect(body.characterVersion).toBe('1.0')
    expect(body.hasEmbeddedAvatar).toBe(false)
    expect(body.systemPrompt).not.toContain('备注内容')
    expect(body.systemPrompt).toContain('一只猫娘')
  })

  it('PNG 卡片解析成功时 hasEmbeddedAvatar 为 true', async () => {
    const fastify = await buildTestApp()
    const png = buildPngFixture('PngChar')

    const response = await fastify.inject({
      method: 'POST',
      url: '/characters/import/parse',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('char.png') },
      payload: png,
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.name).toBe('PngChar')
    expect(body.hasEmbeddedAvatar).toBe(true)
  })

  it('畸形输入（非法 JSON）返回 400 而不是 500', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/characters/import/parse',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not json', 'utf-8'),
    })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload)).toHaveProperty('error')
  })

  // 回归测试：这条路由曾经没设 bodyLimit，继承 Fastify 全局默认 1MB，导致 Electron 侧
  // 允许选中的 1-5MB 卡片（真实带内嵌头像的 PNG 卡片常见体积）在到达解析逻辑前就被拒绝——
  // 与 electron/main/index.ts 的 CHARACTER_CARD_MAX_BYTES（5MB）保持一致后才修复
  it('2MB 请求体不会被 bodyLimit 拒绝（超过全局默认 1MB、未超过本路由 5MB 上限）', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/characters/import/parse',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(2 * 1024 * 1024),
    })

    // 内容本身不是合法卡片，预期 400（解析失败），但绝不能是 413（说明请求体大小本身没被拒绝）
    expect(response.statusCode).toBe(400)
  })

  it('超过 5MB 时返回 413', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'POST',
      url: '/characters/import/parse',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(5 * 1024 * 1024 + 1),
    })

    expect(response.statusCode).toBe(413)
  })
})

describe('POST /characters/import/generate', () => {
  it('成功调用 backgroundModelProvider.completeSync，返回改写后的 systemPrompt', async () => {
    const fastify = await buildTestApp()
    ;(fastify.backgroundModelProvider.completeSync as any).mockResolvedValue('改写后的人设正文')

    const response = await fastify.inject({
      method: 'POST',
      url: '/characters/import/generate',
      payload: { description: '一只猫娘', personality: '开朗', scenario: '', mesExample: '', systemPromptRaw: '' },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body).toEqual({ systemPrompt: '改写后的人设正文' })
    expect(fastify.backgroundModelProvider.completeSync).toHaveBeenCalledTimes(1)
  })

  it('model 调用失败时返回 502，不抛出未捕获异常', async () => {
    const fastify = await buildTestApp()
    ;(fastify.backgroundModelProvider.completeSync as any).mockRejectedValue(new Error('model boom'))

    const response = await fastify.inject({
      method: 'POST',
      url: '/characters/import/generate',
      payload: { description: '一只猫娘' },
    })

    expect(response.statusCode).toBe(502)
    expect(JSON.parse(response.payload)).toHaveProperty('error')
  })
})

describe('POST /characters/:characterId/avatar', () => {
  const testCharacterIds: string[] = []

  afterEach(() => {
    for (const characterId of testCharacterIds) {
      fs.rmSync(path.join(CHARACTERS_ROOT, characterId), { recursive: true, force: true })
    }
    testCharacterIds.length = 0
  })

  it('无 manifest.json 时创建最小 manifest（仅含 avatar 字段），并落盘图片文件', async () => {
    const fastify = await buildTestApp()
    const characterId = `test-avatar-new-${Date.now()}`
    testCharacterIds.push(characterId)

    const response = await fastify.inject({
      method: 'POST',
      url: `/characters/${characterId}/avatar`,
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('pic.png') },
      payload: Buffer.from([1, 2, 3]),
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body).toEqual({ avatar: 'avatar.png' })

    const characterDir = path.join(CHARACTERS_ROOT, characterId)
    expect(fs.existsSync(path.join(characterDir, 'avatar.png'))).toBe(true)
    expect(fs.readFileSync(path.join(characterDir, 'avatar.png'))).toEqual(Buffer.from([1, 2, 3]))

    const manifest = JSON.parse(fs.readFileSync(path.join(characterDir, 'manifest.json'), 'utf-8'))
    expect(manifest).toEqual({ avatar: 'avatar.png' })
  })

  it('已有 manifest.json 时只合并 avatar 字段，其余已有字段原样保留', async () => {
    const fastify = await buildTestApp()
    const characterId = `test-avatar-merge-${Date.now()}`
    testCharacterIds.push(characterId)
    const characterDir = path.join(CHARACTERS_ROOT, characterId)
    fs.mkdirSync(characterDir, { recursive: true })
    fs.writeFileSync(
      path.join(characterDir, 'manifest.json'),
      JSON.stringify({ avatar: 'old-avatar.png', emotionVocabulary: ['happy', 'sad'], tags: ['existing'] })
    )

    const response = await fastify.inject({
      method: 'POST',
      url: `/characters/${characterId}/avatar`,
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('new.jpg') },
      payload: Buffer.from([4, 5, 6]),
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body).toEqual({ avatar: 'avatar.jpg' })

    const manifest = JSON.parse(fs.readFileSync(path.join(characterDir, 'manifest.json'), 'utf-8'))
    expect(manifest).toEqual({ avatar: 'avatar.jpg', emotionVocabulary: ['happy', 'sad'], tags: ['existing'] })
  })

  it('扩展名不在白名单时返回 400', async () => {
    const fastify = await buildTestApp()
    const characterId = `test-avatar-badext-${Date.now()}`
    testCharacterIds.push(characterId)

    const response = await fastify.inject({
      method: 'POST',
      url: `/characters/${characterId}/avatar`,
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('a.exe') },
      payload: Buffer.from([1, 2, 3]),
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('POST /characters/:characterId/metadata', () => {
  const testCharacterIds: string[] = []

  afterEach(() => {
    for (const characterId of testCharacterIds) {
      fs.rmSync(path.join(CHARACTERS_ROOT, characterId), { recursive: true, force: true })
    }
    testCharacterIds.length = 0
  })

  it('无 manifest.json 时创建最小 manifest，只含请求体里提供的字段（characterVersion 映射到 version）', async () => {
    const fastify = await buildTestApp()
    const characterId = `test-metadata-new-${Date.now()}`
    testCharacterIds.push(characterId)

    const response = await fastify.inject({
      method: 'POST',
      url: `/characters/${characterId}/metadata`,
      payload: { tags: ['猫娘'], creator: 'someone', creatorNotes: '备注', characterVersion: '1.0' },
    })

    expect(response.statusCode).toBe(200)

    const manifest = JSON.parse(fs.readFileSync(path.join(CHARACTERS_ROOT, characterId, 'manifest.json'), 'utf-8'))
    expect(manifest).toEqual({ tags: ['猫娘'], creator: 'someone', creatorNotes: '备注', version: '1.0' })
  })

  it('已有 manifest.json 时只合并请求体里的字段，其余已有字段（emotionVocabulary/portraits/avatar）原样保留', async () => {
    const fastify = await buildTestApp()
    const characterId = `test-metadata-merge-${Date.now()}`
    testCharacterIds.push(characterId)
    const characterDir = path.join(CHARACTERS_ROOT, characterId)
    fs.mkdirSync(characterDir, { recursive: true })
    fs.writeFileSync(
      path.join(characterDir, 'manifest.json'),
      JSON.stringify({ avatar: 'avatar.png', emotionVocabulary: ['happy', 'sad'], portraits: { pixel: { fallback: 'a.png', emotions: {} } } })
    )

    const response = await fastify.inject({
      method: 'POST',
      url: `/characters/${characterId}/metadata`,
      payload: { tags: ['治愈'], creator: 'someone', creatorNotes: '备注', characterVersion: '2.0' },
    })

    expect(response.statusCode).toBe(200)

    const manifest = JSON.parse(fs.readFileSync(path.join(characterDir, 'manifest.json'), 'utf-8'))
    expect(manifest).toEqual({
      avatar: 'avatar.png',
      emotionVocabulary: ['happy', 'sad'],
      portraits: { pixel: { fallback: 'a.png', emotions: {} } },
      tags: ['治愈'],
      creator: 'someone',
      creatorNotes: '备注',
      version: '2.0',
    })
  })

  it('请求体只提供部分字段时，不清空 manifest 里已有的其余三个字段', async () => {
    const fastify = await buildTestApp()
    const characterId = `test-metadata-partial-${Date.now()}`
    testCharacterIds.push(characterId)
    const characterDir = path.join(CHARACTERS_ROOT, characterId)
    fs.mkdirSync(characterDir, { recursive: true })
    fs.writeFileSync(
      path.join(characterDir, 'manifest.json'),
      JSON.stringify({ tags: ['旧标签'], creator: '旧作者', creatorNotes: '旧备注', version: '0.9' })
    )

    const response = await fastify.inject({
      method: 'POST',
      url: `/characters/${characterId}/metadata`,
      payload: { creatorNotes: '新备注' },
    })

    expect(response.statusCode).toBe(200)

    const manifest = JSON.parse(fs.readFileSync(path.join(characterDir, 'manifest.json'), 'utf-8'))
    expect(manifest).toEqual({ tags: ['旧标签'], creator: '旧作者', creatorNotes: '新备注', version: '0.9' })
  })
})
