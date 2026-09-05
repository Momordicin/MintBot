import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadCharacterManifest, CHARACTERS_ROOT } from './manifest.js'

// Aemeath 是本地专属、未提交进 git 的真实角色包
const AEMEATH_FIXTURE_PATH = path.join(CHARACTERS_ROOT, 'Aemeath', 'manifest.json')

describe('loadCharacterManifest — 真实角色包 fixture（assets/characters/ 下的实际文件）', () => {
  it.skipIf(!fs.existsSync(AEMEATH_FIXTURE_PATH))(
    'Aemeath（manifest schema v3 全字段，仅本地存在真实素材时运行）各层级结构与类型解析正确', 
    () => {
      const manifest = loadCharacterManifest('Aemeath')

      expect(manifest).not.toBeNull()
      if (!manifest) return

      expect(manifest.schemaVersion).toBe(3)
      expect(manifest.name).toBe('Aemeath')
      expect(manifest.displayName).toBe('Aemeath')
      expect(typeof manifest.description).toBe('string')
      expect(Array.isArray(manifest.tags)).toBe(true)
      expect(typeof manifest.avatar).toBe('string')
      expect(manifest.avatar.length).toBeGreaterThan(0)
      expect(typeof manifest.userAvatar).toBe('string')
      expect(Array.isArray(manifest.emotionVocabulary)).toBe(true)
      expect(manifest.emotionVocabulary.length).toBeGreaterThan(0)
      expect(Array.isArray(manifest.emoteTagVocabulary)).toBe(true)

      expect(typeof manifest.portraits.pixel.fallback).toBe('string')
      expect(typeof manifest.portraits.pixel.emotions).toBe('object')
      const pixelEmotionEntries = Object.values(manifest.portraits.pixel.emotions)
      expect(pixelEmotionEntries.length).toBeGreaterThan(0)
      for (const files of pixelEmotionEntries) {
        expect(Array.isArray(files)).toBe(true)
      }

      expect(typeof manifest.portraits.illustration.fallback).toBe('string')
      expect(typeof manifest.portraits.illustration.emotions).toBe('object')

      expect(typeof manifest.interactionStates).toBe('object')
      expect(typeof manifest.reservedStates).toBe('object')

      expect(Array.isArray(manifest.emotePool)).toBe(true)
      for (const entry of manifest.emotePool) {
        expect(typeof entry.file).toBe('string')
        expect(Array.isArray(entry.tags)).toBe(true)
      }

      // v3 新增：transitions 的每一步都必须解析成归一化后的结构（from 恒为数组），
      // 且引用的情绪键都在该角色包自己的 emotionVocabulary 内——本地真实角色包上
      // 校验一遍解析结果，与上面各字段同款的结构性断言
      expect(typeof manifest.transitions).toBe('object')
      for (const steps of Object.values(manifest.transitions)) {
        expect(Array.isArray(steps)).toBe(true)
        for (const step of steps) {
          expect(Array.isArray(step.from)).toBe(true)
          expect(step.from.length).toBeGreaterThan(0)
          for (const source of step.from) {
            expect(manifest.emotionVocabulary).toContain(source.replace('emotions.', ''))
          }
          expect(step.pick).toBe('random')
          expect(step.durationMs).toBeGreaterThan(0)
        }
      }
    }
  )

  // Mint 跟 Aemeath 同样是本地专属、未提交进 git 的真实角色包
  const MINT_FIXTURE_PATH = path.join(CHARACTERS_ROOT, 'Mint', 'manifest.json')

  it.skipIf(!fs.existsSync(MINT_FIXTURE_PATH))(
    'Mint（legacy + Part D 补充的 emotionVocabulary，仅本地存在真实素材时运行）其余 v2 字段回退安全默认值，且不告警',
    () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const manifest = loadCharacterManifest('Mint')

      expect(manifest).not.toBeNull()
      if (!manifest) return

      expect(manifest.schemaVersion).toBe(1)
      expect(typeof manifest.avatar).toBe('string')
      expect(manifest.avatar.length).toBeGreaterThan(0)
      expect(Array.isArray(manifest.emotionVocabulary)).toBe(true)
      expect(manifest.emotionVocabulary.length).toBeGreaterThan(0)
      expect(manifest.emoteTagVocabulary).toEqual([])
      expect(manifest.portraits).toEqual({
        pixel: { fallback: '', emotions: {} },
        illustration: { fallback: '', emotions: {} },
      })
      expect(manifest.interactionStates).toEqual({})
      expect(manifest.reservedStates).toEqual({})
      expect(manifest.emotePool).toEqual([])

      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    }
  )

  // example 是唯一提交进 git 的角色包
  it('example（schema v3 完整字段，占位内容，git 内唯一提交的角色包 fixture）解析结果与 fixture 完全一致', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = loadCharacterManifest('example')

    expect(manifest).toEqual({
      schemaVersion: 3,
      name: 'example',
      displayName: '示例角色',
      description: '示例角色包，展示 manifest schema v3 的完整字段结构，供开发者参考；不含真实立绘/表情包素材',
      tags: ['示例', '占位'],
      creator: '',
      version: '1.0',
      creatorNotes: '',
      avatar: 'avatar.png',
      userAvatar: '',
      emotionVocabulary: ['idle', 'happy', 'sad', 'curious', 'angry', 'surprised', 'shy'],
      emoteTagVocabulary: ['excited', 'comforting'],
      portraits: {
        pixel: {
          fallback: 'idle',
          emotions: {
            idle: ['gifs/idle1.gif', 'gifs/idle2.gif'],
            happy: ['gifs/happy1.gif'],
          },
        },
        illustration: {
          fallback: 'idle',
          emotions: {
            idle: ['full-body.png'],
            happy: ['half-body.png'],
          },
        },
      },
      interactionStates: {
        drag: 'gifs/drag.gif',
        move: 'gifs/move.gif',
      },
      reservedStates: {
        thinking: ['gifs/thinking.gif'],
        'listening-to-music': ['gifs/music.gif'],
        'boredom-idle': ['gifs/boredom.gif'],
      },
      emotePool: [
        { file: 'emotes/example.jpg', tags: ['excited'] },
      ],
      transitions: {
        'wake-from-sleep': [
          { from: ['emotions.sad'], pick: 'random', durationMs: 3000 },
          { from: ['emotions.happy'], pick: 'random', durationMs: 3000 },
        ],
        'wake-from-bored': [
          { from: ['emotions.curious'], pick: 'random', durationMs: 3000 },
        ],
        'poke-neutral': [
          { from: ['emotions.shy', 'emotions.happy'], pick: 'random', durationMs: 3000 },
        ],
      },
    })
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

// 以下用例需要手工构造异常内容的 manifest.json, 验证 ASSET_PATH 是本模块解析角色包根目录的唯一来源
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

  it('v2 manifest（未声明 transitions）仍能加载，transitions 回退为 {}，不告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = await loadWithFixture('v2-no-transitions', JSON.stringify({
      schemaVersion: 2,
      avatar: 'avatar.jpg',
    }))

    expect(manifest?.transitions).toEqual({})
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('transitions 声明且全部合法时被解析，单字符串 from 被归一化为数组', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = await loadWithFixture('transitions-valid', JSON.stringify({
      avatar: 'avatar.jpg',
      emotionVocabulary: ['idle', 'happy'],
      transitions: {
        'wake-from-sleep': [
          { from: 'emotions.idle', durationMs: 3000 },
        ],
      },
    }))

    expect(manifest?.transitions).toEqual({
      'wake-from-sleep': [
        { from: ['emotions.idle'], pick: 'random', durationMs: 3000 },
      ],
    })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('步骤缺少 durationMs 时跳过该步，链内其它步骤不受影响，并告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = await loadWithFixture('transitions-bad-duration', JSON.stringify({
      avatar: 'avatar.jpg',
      emotionVocabulary: ['idle', 'happy'],
      transitions: {
        'wake-from-bored': [
          { from: 'emotions.idle' },
          { from: 'emotions.happy', durationMs: 3000 },
        ],
      },
    }))

    expect(manifest?.transitions).toEqual({
      'wake-from-bored': [
        { from: ['emotions.happy'], pick: 'random', durationMs: 3000 },
      ],
    })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('步骤引用了不存在于 emotionVocabulary 的键时跳过该步，链内其它步骤仍解析，并告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = await loadWithFixture('transitions-bad-ref', JSON.stringify({
      avatar: 'avatar.jpg',
      emotionVocabulary: ['idle', 'happy'],
      transitions: {
        'poke-neutral': [
          { from: 'emotions.missing', durationMs: 3000 },
          { from: 'emotions.happy', durationMs: 3000 },
        ],
      },
    }))

    expect(manifest?.transitions).toEqual({
      'poke-neutral': [
        { from: ['emotions.happy'], pick: 'random', durationMs: 3000 },
      ],
    })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('多来源 from 数组按完整来源列表解析', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifest = await loadWithFixture('transitions-multi-source', JSON.stringify({
      avatar: 'avatar.jpg',
      emotionVocabulary: ['idle', 'happy', 'shy'],
      transitions: {
        'poke-neutral': [
          { from: ['emotions.shy', 'emotions.happy'], durationMs: 3000 },
        ],
      },
    }))

    expect(manifest?.transitions).toEqual({
      'poke-neutral': [
        { from: ['emotions.shy', 'emotions.happy'], pick: 'random', durationMs: 3000 },
      ],
    })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
