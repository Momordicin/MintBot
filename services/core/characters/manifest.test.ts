import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadCharacterManifest } from './manifest.js'

describe('loadCharacterManifest — 真实角色包 fixture（assets/characters/ 下的实际文件）', () => {
  it('Aemeath（manifest schema v2 全字段）端到端解析，所有字段与 fixture 一致', () => {
    const manifest = loadCharacterManifest('Aemeath')

    expect(manifest).not.toBeNull()
    expect(manifest).toEqual({
      schemaVersion: 2,
      name: 'Aemeath',
      displayName: 'Aemeath',
      description: '实验性角色包，用于验证 manifest schema v2（角色卡导入 / 立绘资源管理重设计）',
      tags: [],
      creator: '',
      version: '1.0',
      creatorNotes: '',
      avatar: 'avatar.jpg',
      emotionVocabulary: ['idle', 'happy', 'shy', 'playful', 'sleep', 'confused'],
      emoteTagVocabulary: ['excited', 'performing', 'comforting'],
      portraits: {
        pixel: {
          fallback: 'idle',
          emotions: {
            idle: ['gifs/idle1.gif', 'gifs/idle2.gif', 'gifs/idle3.gif', 'gifs/idle4.gif'],
            happy: ['gifs/screen1.gif', 'gifs/screen2.gif'],
            shy: ['gifs/screen2.gif'],
            playful: ['gifs/screen3.gif'],
            sleep: ['gifs/screen5.gif'],
            confused: ['gifs/screen7.gif'],
          },
        },
        illustration: {
          fallback: 'idle',
          emotions: {
            idle: ['full-body.png', 'full-body2.png'],
            happy: ['half-body.png'],
          },
        },
      },
      interactionStates: {
        drag: 'gifs/drag.gif',
        move: 'gifs/move.gif',
      },
      reservedStates: {
        thinking: ['gifs/screen4.gif'],
        'listening-to-music': ['gifs/ameath.gif'],
        'boredom-idle': ['gifs/screen6.gif'],
      },
      emotePool: [
        { file: 'emotes/singing.jpg', tags: ['excited', 'performing'] },
        { file: 'half-body.png', tags: ['comforting'] },
      ],
    })
  })

  it('Mint（legacy + Part D 补充的 emotionVocabulary）其余 v2 字段回退安全默认值，且不告警（合法缺失，不是错误）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = loadCharacterManifest('Mint')

    expect(manifest).toEqual({
      schemaVersion: 1,
      name: '',
      displayName: '',
      description: '',
      tags: [],
      creator: '',
      version: '',
      creatorNotes: '',
      avatar: 'avatar.png',
      emotionVocabulary: ['idle', 'happy', 'sad', 'curious', 'angry', 'surprised', 'shy'],
      emoteTagVocabulary: [],
      portraits: {
        pixel: { fallback: '', emotions: {} },
        illustration: { fallback: '', emotions: {} },
      },
      interactionStates: {},
      reservedStates: {},
      emotePool: [],
    })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('example（legacy，只有 avatar 一个字段）同样正常加载，不告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = loadCharacterManifest('example')

    expect(manifest?.avatar).toBe('avatar.png')
    expect(manifest?.schemaVersion).toBe(1)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('不存在的 characterId 文件夹返回 null（角色包不可用），并告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(loadCharacterManifest('does-not-exist-character-xyz')).toBeNull()

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// 以下用例需要手工构造异常内容的 manifest.json（非法 JSON / 字段类型错误），不适合写进
// assets/characters/ 下的真实 fixture——用临时目录 + ASSET_PATH 环境变量覆盖 + vi.resetModules()
// 重新加载模块，验证 ASSET_PATH 是本模块解析角色包根目录的唯一来源（同时也是 §3.5 配置外置
// 原则本身的验证）
describe('loadCharacterManifest — 手工构造的异常 manifest（临时目录 + ASSET_PATH 覆盖）', () => {
  let tempRoot: string | undefined

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
    delete process.env.ASSET_PATH
    vi.resetModules()
  })

  async function loadWithFixture(characterId: string, manifestContent: string) {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-manifest-'))
    const dir = path.join(tempRoot, 'characters', characterId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), manifestContent)

    process.env.ASSET_PATH = tempRoot
    vi.resetModules()
    const { loadCharacterManifest: freshLoadCharacterManifest } = await import('./manifest.js')
    return freshLoadCharacterManifest(characterId)
  }

  it('manifest.json 内容不是合法 JSON 时返回 null（角色包不可用），并告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = await loadWithFixture('broken', '{not valid json')

    expect(manifest).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('emotionVocabulary 类型错误（字符串而非数组）时该字段回退默认值 []，不连累其它字段，且告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = await loadWithFixture('bad-field', JSON.stringify({
      avatar: 'avatar.jpg',
      emotionVocabulary: 'not-an-array',
      emoteTagVocabulary: ['excited'],
    }))

    expect(manifest).not.toBeNull()
    expect(manifest?.avatar).toBe('avatar.jpg')
    expect(manifest?.emotionVocabulary).toEqual([])
    expect(manifest?.emoteTagVocabulary).toEqual(['excited'])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('portraits.pixel.emotions 里某个标签的值类型错误时，只丢弃该条目，其它标签不受影响', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = await loadWithFixture('bad-emotion-entry', JSON.stringify({
      avatar: 'avatar.jpg',
      portraits: {
        pixel: {
          fallback: 'idle',
          emotions: {
            idle: ['gifs/idle1.gif'],
            happy: 'not-an-array',
          },
        },
      },
    }))

    expect(manifest?.portraits.pixel.emotions).toEqual({ idle: ['gifs/idle1.gif'] })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('avatar 缺失时回退默认值 \'\' 并告警（v2 字段里唯一必填字段）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = await loadWithFixture('no-avatar', JSON.stringify({ name: 'X' }))

    expect(manifest?.avatar).toBe('')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
