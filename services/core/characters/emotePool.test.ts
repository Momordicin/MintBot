import { describe, it, expect } from 'vitest'
import { selectEmoteFile } from './emotePool.js'
import type { CharacterManifest } from './manifest.js'

// 只需要 emoteTagVocabulary/emotePool 两个字段参与本模块逻辑，其余字段填安全占位值
function fakeManifest(overrides: Partial<CharacterManifest>): CharacterManifest {
  return {
    schemaVersion: 2,
    name: '',
    displayName: '',
    description: '',
    tags: [],
    creator: '',
    version: '',
    creatorNotes: '',
    avatar: '',
    userAvatar: '',
    emotionVocabulary: [],
    emoteTagVocabulary: [],
    portraits: { pixel: { fallback: '', emotions: {} }, illustration: { fallback: '', emotions: {} } },
    interactionStates: {},
    reservedStates: {},
    emotePool: [],
    transitions: {},
    ...overrides,
  }
}

describe('selectEmoteFile', () => {
  it('tag 为 null（模型本轮未输出 emote）：返回 null，不报错', () => {
    const manifest = fakeManifest({
      emoteTagVocabulary: ['playful'],
      emotePool: [{ file: 'emotes/a.jpg', tags: ['playful'] }],
    })
    expect(selectEmoteFile(null, manifest)).toBeNull()
  })

  it('manifest 为 null（角色包缺失/解析失败）：返回 null，不报错', () => {
    expect(selectEmoteFile('playful', null)).toBeNull()
  })

  it('tag 不在 emoteTagVocabulary 词表内：返回 null', () => {
    const manifest = fakeManifest({
      emoteTagVocabulary: ['comforting'],
      emotePool: [{ file: 'emotes/a.jpg', tags: ['comforting'] }],
    })
    expect(selectEmoteFile('playful', manifest)).toBeNull()
  })

  it('tag 在词表内，但 emotePool 中没有任何条目带这个 tag：返回 null', () => {
    const manifest = fakeManifest({
      emoteTagVocabulary: ['playful'],
      emotePool: [{ file: 'emotes/a.jpg', tags: ['comforting'] }],
    })
    expect(selectEmoteFile('playful', manifest)).toBeNull()
  })

  it('emotePool 为空数组：返回 null', () => {
    const manifest = fakeManifest({ emoteTagVocabulary: ['playful'], emotePool: [] })
    expect(selectEmoteFile('playful', manifest)).toBeNull()
  })

  it('tag 匹配唯一一条候选：返回该条目的 file', () => {
    const manifest = fakeManifest({
      emoteTagVocabulary: ['playful'],
      emotePool: [{ file: 'emotes/a.jpg', tags: ['playful'] }],
    })
    expect(selectEmoteFile('playful', manifest)).toBe('emotes/a.jpg')
  })

  it('多个候选条目匹配同一 tag 时，用注入的 pickRandom 从过滤后的候选子集中挑选（确定性验证）', () => {
    const manifest = fakeManifest({
      emoteTagVocabulary: ['excited'],
      emotePool: [
        { file: 'emotes/singing.jpg', tags: ['excited', 'performing'] },
        { file: 'half-body.png', tags: ['comforting'] },
        { file: 'emotes/dance.jpg', tags: ['excited'] },
      ],
    })

    // 注入的 pickRandom 断言过滤后的候选子集确实只剩两条匹配 excited 的条目，
    // 且不包含只带 comforting 的 half-body.png
    const pickRandom = <T>(items: T[]): T => {
      expect(items).toHaveLength(2)
      return items[0]
    }

    expect(selectEmoteFile('excited', manifest, pickRandom)).toBe('emotes/singing.jpg')
  })

  it('不传 pickRandom 时使用默认随机实现，结果必然是过滤后候选子集中的一个', () => {
    const manifest = fakeManifest({
      emoteTagVocabulary: ['excited'],
      emotePool: [
        { file: 'emotes/singing.jpg', tags: ['excited'] },
        { file: 'emotes/dance.jpg', tags: ['excited'] },
      ],
    })

    const result = selectEmoteFile('excited', manifest)
    expect(['emotes/singing.jpg', 'emotes/dance.jpg']).toContain(result)
  })
})
