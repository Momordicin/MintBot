// services/core/tts/voiceRefs.test.ts — 情绪参考音频测试：扫描分组与跳过原因、用当前预设的聊天模型匹配、模型回答的校验与重试和失败原因、存档复用与重新匹配、匹配中切换角色、按情绪取参考音频与回退
// 用法：pnpm test；模型、config、broadcast、manager 换成假实现，参考音频只建在测试临时素材目录下，存档写在 VOICE_REFERENCES_PATH 指向的临时目录，不调用真实模型
// 对应文件：services/core/tts/voiceRefs.ts / vitest.setup.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { CHARACTERS_ROOT, type CharacterManifest } from '../characters/manifest.js'

const mocks = vi.hoisted(() => ({
  completeSync: vi.fn<(context: unknown) => Promise<string>>(),
  createModelProviderForPreset: vi.fn(),
  createModelProvider: vi.fn(),
  getBackgroundModelProviderConfig: vi.fn(() => ({ type: 'ollama' })),
  broadcastEvent: vi.fn(),
}))

vi.mock('../providers/ModelProvider.js', () => ({
  createModelProviderForPreset: mocks.createModelProviderForPreset,
  createModelProvider: mocks.createModelProvider,
  stripThinkTags: (text: string) => text,
}))
vi.mock('../config/index.js', () => ({
  getModelProviderConfig: () => GLOBAL_CONFIG,
  getBackgroundModelProviderConfig: mocks.getBackgroundModelProviderConfig,
}))
vi.mock('../events/broadcast.js', () => ({ broadcastEvent: mocks.broadcastEvent }))
vi.mock('./manager.js', () => ({ characterVoiceStatus: () => ({ voice: 'ok', missing: [], model: null }) }))

type VoiceRefs = typeof import('./voiceRefs.js')
type VoiceReferenceModel = import('./voiceRefs.js').VoiceReferenceModel
let refs: VoiceRefs

const GLOBAL_CONFIG = vi.hoisted(() => ({ type: 'openai', maxTokens: 2048 }))
const MODEL = {
  preset: { presetId: 'p1', characterId: 'refs-a', modelType: 'deepseek', modelName: 'deepseek-flash' },
  credentials: { deepseek: { apiKey: 'sk-test', fromEnv: false } },
} as unknown as VoiceReferenceModel
const EMOTIONS = ['happy', 'sad', 'shy']
const GOOD_ANSWER = '{"happy":"开心","sad":"忧伤","shy":null}'

function voiceDir(characterId: string): string {
  return path.join(CHARACTERS_ROOT, characterId, 'voice')
}

function writeWav(file: string, seconds: number, presentSeconds = seconds): void {
  const byteRate = 32000
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(seconds * byteRate, 40)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(presentSeconds * byteRate)]))
}

function makeCharacter(characterId: string): { characterId: string; manifest: CharacterManifest } {
  const dir = voiceDir(characterId)
  writeWav(path.join(dir, '开心', 'a_1.wav'), 5)
  writeWav(path.join(dir, '开心', '你好呀.wav'), 5)
  fs.mkdirSync(path.join(dir, '开心'), { recursive: true })
  fs.writeFileSync(path.join(dir, '开心', '坏的.wav'), 'not a wav')
  writeWav(path.join(dir, '开心', '太短.wav'), 1)
  writeWav(path.join(dir, '开心', '截断.wav'), 5, 1)
  writeWav(path.join(dir, '忧伤', '太长.wav'), 12)
  return {
    characterId,
    manifest: {
      emotionVocabulary: EMOTIONS,
      voice: { gptWeights: 'voice/x.ckpt', sovitsWeights: 'voice/x.pth', preview: { audio: 'voice/开心/你好呀.wav', text: '你好呀', lang: 'ja' } },
    } as CharacterManifest,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

beforeEach(async () => {
  vi.resetModules()
  mocks.completeSync.mockReset().mockResolvedValue(GOOD_ANSWER)
  mocks.createModelProviderForPreset.mockReset().mockReturnValue({ completeSync: mocks.completeSync })
  mocks.createModelProvider.mockReset()
  mocks.getBackgroundModelProviderConfig.mockClear()
  mocks.broadcastEvent.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  refs = await import('./voiceRefs.js')
})

afterEach(() => {
  fs.rmSync(path.join(CHARACTERS_ROOT, 'refs-a'), { recursive: true, force: true })
  fs.rmSync(path.join(CHARACTERS_ROOT, 'refs-b'), { recursive: true, force: true })
  fs.rmSync(refs.VOICE_REFERENCES_DIR, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('voice references', () => {
  it('scans the groups, records skipped clips, matches once and saves the result', async () => {
    const character = makeCharacter('refs-a')
    refs.loadVoiceReferences(character, MODEL)
    expect(refs.getVoiceReferencesStatus().state).toBe('matching')
    await flush()
    expect(refs.getVoiceReferencesStatus()).toEqual({
      state: 'ok',
      entries: [
        { emotion: 'happy', group: '开心', clip: '开心/你好呀.wav' },
        { emotion: 'sad', group: null },
        { emotion: 'shy', group: null },
      ],
      skipped: [
        { path: '开心/a_1.wav', reason: 'missing_text' },
        { path: '开心/坏的.wav', reason: 'invalid_wav' },
        { path: '开心/太短.wav', reason: 'duration' },
        { path: '开心/截断.wav', reason: 'duration' },
        { path: '忧伤/太长.wav', reason: 'duration' },
      ],
    })
    expect(mocks.completeSync).toHaveBeenCalledOnce()
    expect(mocks.createModelProviderForPreset).toHaveBeenCalledWith(MODEL.preset, GLOBAL_CONFIG, MODEL.credentials)
    expect(mocks.createModelProvider).not.toHaveBeenCalled()
    expect(mocks.getBackgroundModelProviderConfig).not.toHaveBeenCalled()
    const sent = JSON.stringify(mocks.completeSync.mock.calls[0][0])
    expect(sent).toContain(JSON.stringify(JSON.stringify(EMOTIONS)).slice(1, -1))
    expect(sent).toContain(JSON.stringify(JSON.stringify(['开心', '忧伤'])).slice(1, -1))
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('tts-status-changed', {})
    const saved = JSON.parse(fs.readFileSync(path.join(refs.VOICE_REFERENCES_DIR, 'refs-a.json'), 'utf-8'))
    expect(saved).toMatchObject({ mapping: { happy: '开心', sad: '忧伤', shy: null } })
  })

  it('picks the mapped clip by emotion and falls back otherwise', async () => {
    refs.loadVoiceReferences(makeCharacter('refs-a'), MODEL)
    expect(refs.voiceReferenceFor('refs-a', 'happy')).toBeNull()
    await flush()
    expect(refs.voiceReferenceFor('refs-a', 'happy')).toEqual({
      refAudio: path.join(voiceDir('refs-a'), '开心', '你好呀.wav'),
      refText: '你好呀',
      lang: 'ja',
    })
    for (const [characterId, emotion] of [['refs-a', null], ['refs-a', 'sad'], ['refs-a', 'shy'], ['refs-a', 'unknown'], ['refs-b', 'happy']] as const) {
      expect(refs.voiceReferenceFor(characterId, emotion)).toBeNull()
    }
  })

  it('reports none without asking the model when there are no emotion folders', async () => {
    const character = makeCharacter('refs-a')
    fs.rmSync(voiceDir('refs-a'), { recursive: true, force: true })
    refs.loadVoiceReferences(character, MODEL)
    await flush()
    expect(refs.getVoiceReferencesStatus()).toEqual({ state: 'none', entries: [], skipped: [] })
    expect(mocks.completeSync).not.toHaveBeenCalled()
  })

  const networkError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })
  it.each([
    ['a valid answer inside a code fence', ['```json\n' + GOOD_ANSWER + '\n```'], 'ok', undefined, 1],
    ['an invalid answer then a valid one', ['不是 JSON', GOOD_ANSWER], 'ok', undefined, 2],
    ['an unknown emotion key twice', ['{"angry":"开心"}', '{"angry":"开心"}'], 'failed', 'invalid_answer', 2],
    ['an unknown group twice', ['{"happy":"生气"}', '{"happy":"生气"}'], 'failed', 'invalid_answer', 2],
    ['a non-string value twice', ['{"happy":1,"sad":null,"shy":null}', '["开心"]'], 'failed', 'invalid_answer', 2],
    ['an empty object twice', ['{}', '{}'], 'failed', 'invalid_answer', 2],
    ['a partial answer then a full one', ['{"happy":"开心","sad":"忧伤"}', GOOD_ANSWER], 'ok', undefined, 2],
    ['a partial answer twice', ['{"happy":"开心"}', '{"happy":"开心","shy":null}'], 'failed', 'invalid_answer', 2],
    ['two network failures', [networkError(), networkError()], 'failed', 'network', 2],
    ['two model errors', [new Error('401'), new Error('401')], 'failed', 'model_error', 2],
  ] as const)('validates and retries once: %s', async (_name, answers, state, error, calls) => {
    for (const answer of answers) {
      if (typeof answer === 'string') mocks.completeSync.mockResolvedValueOnce(answer)
      else mocks.completeSync.mockRejectedValueOnce(answer)
    }
    refs.loadVoiceReferences(makeCharacter('refs-a'), MODEL)
    await flush()
    const status = refs.getVoiceReferencesStatus()
    expect(status.state).toBe(state)
    expect(status.error).toBe(error)
    expect(mocks.completeSync).toHaveBeenCalledTimes(calls)
    expect(fs.existsSync(path.join(refs.VOICE_REFERENCES_DIR, 'refs-a.json'))).toBe(state === 'ok')
    if (state === 'failed') {
      expect(status.entries).toEqual([])
      expect(refs.voiceReferenceFor('refs-a', 'happy')).toBeNull()
    }
  })

  it('fails with model_error without crashing when the chat model key is missing', async () => {
    mocks.createModelProviderForPreset.mockImplementation(() => {
      throw new Error('[ModelProvider] DeepSeek API key is not configured')
    })
    refs.loadVoiceReferences(makeCharacter('refs-a'), MODEL)
    await flush()
    expect(refs.getVoiceReferencesStatus()).toMatchObject({ state: 'failed', error: 'model_error', entries: [] })
    expect(mocks.createModelProviderForPreset).toHaveBeenCalledTimes(2)
    expect(mocks.completeSync).not.toHaveBeenCalled()
  })

  it('reuses the saved result, matches again when the groups change, and rematch ignores the saved result', async () => {
    const character = makeCharacter('refs-a')
    refs.loadVoiceReferences(character, MODEL)
    await flush()
    refs.loadVoiceReferences(character, MODEL)
    expect(refs.getVoiceReferencesStatus().state).toBe('ok')
    expect(mocks.completeSync).toHaveBeenCalledTimes(1)

    expect(refs.rematchVoiceReferences(character, MODEL)).toBe('started')
    expect(refs.getVoiceReferencesStatus().state).toBe('matching')
    await flush()
    expect(mocks.completeSync).toHaveBeenCalledTimes(2)

    fs.mkdirSync(path.join(voiceDir('refs-a'), '害羞'))
    refs.loadVoiceReferences(character, MODEL)
    expect(refs.getVoiceReferencesStatus().state).toBe('matching')
    await flush()
    expect(mocks.completeSync).toHaveBeenCalledTimes(3)
  })

  it('matches again when a saved result lacks some emotion words', async () => {
    const character = makeCharacter('refs-a')
    const file = path.join(refs.VOICE_REFERENCES_DIR, 'refs-a.json')
    fs.mkdirSync(refs.VOICE_REFERENCES_DIR, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ key: JSON.stringify([[...EMOTIONS].sort(), ['开心', '忧伤']]), mapping: { happy: '开心' }, at: 0 }))
    refs.loadVoiceReferences(character, MODEL)
    expect(refs.getVoiceReferencesStatus().state).toBe('matching')
    await flush()
    expect(mocks.completeSync).toHaveBeenCalledOnce()
    expect(refs.getVoiceReferencesStatus().state).toBe('ok')
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).mapping).toEqual({ happy: '开心', sad: '忧伤', shy: null })
  })

  it('saves the old answer and asks again when the groups change during matching', async () => {
    const answers: ((text: string) => void)[] = []
    mocks.completeSync.mockImplementation(() => new Promise(resolve => { answers.push(resolve) }))
    const a = makeCharacter('refs-a')
    refs.loadVoiceReferences(a, MODEL)
    fs.mkdirSync(path.join(voiceDir('refs-a'), '害羞'))
    refs.loadVoiceReferences(a, MODEL)
    expect(refs.getVoiceReferencesStatus().state).toBe('matching')

    mocks.broadcastEvent.mockReset()
    answers[0](GOOD_ANSWER)
    await flush()
    expect(refs.getVoiceReferencesStatus().state).toBe('matching')
    expect(mocks.completeSync).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(mocks.completeSync.mock.calls[1][0])).toContain(JSON.stringify(JSON.stringify(['害羞', '开心', '忧伤'])).slice(1, -1))
    const file = path.join(refs.VOICE_REFERENCES_DIR, 'refs-a.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({ key: JSON.stringify([[...EMOTIONS].sort(), ['开心', '忧伤']]), mapping: { happy: '开心', sad: '忧伤', shy: null } })
    expect(mocks.broadcastEvent).not.toHaveBeenCalled()

    answers[1]('{"happy":"忧伤","sad":"开心","shy":"害羞"}')
    await flush()
    expect(refs.getVoiceReferencesStatus().state).toBe('ok')
    expect(refs.getVoiceReferencesStatus().entries).toEqual([
      { emotion: 'happy', group: null },
      { emotion: 'sad', group: '开心', clip: '开心/你好呀.wav' },
      { emotion: 'shy', group: null },
    ])
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).mapping).toEqual({ happy: '忧伤', sad: '开心', shy: '害羞' })
    expect(mocks.broadcastEvent).toHaveBeenCalledOnce()
    expect(mocks.completeSync).toHaveBeenCalledTimes(2)
  })

  it('answers busy while matching and keeps a switched-away result under the old character', async () => {
    let answer = (_text: string) => {}
    mocks.completeSync.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const a = makeCharacter('refs-a')
    refs.loadVoiceReferences(a, MODEL)
    expect(refs.rematchVoiceReferences(a, MODEL)).toBe('busy')

    const b = makeCharacter('refs-b')
    fs.rmSync(voiceDir('refs-b'), { recursive: true, force: true })
    refs.loadVoiceReferences(b, MODEL)
    mocks.broadcastEvent.mockReset()
    answer(GOOD_ANSWER)
    await flush()
    expect(refs.getVoiceReferencesStatus()).toEqual({ state: 'none', entries: [], skipped: [] })
    expect(mocks.broadcastEvent).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(path.join(refs.VOICE_REFERENCES_DIR, 'refs-a.json'), 'utf-8')).mapping).toEqual({ happy: '开心', sad: '忧伤', shy: null })

    refs.loadVoiceReferences(a, MODEL)
    expect(refs.getVoiceReferencesStatus().state).toBe('ok')
    expect(mocks.completeSync).toHaveBeenCalledOnce()
  })

  it('joins a rematch still running when switching back and applies its new result', async () => {
    const a = makeCharacter('refs-a')
    refs.loadVoiceReferences(a, MODEL)
    await flush()
    let answer = (_text: string) => {}
    mocks.completeSync.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    expect(refs.rematchVoiceReferences(a, MODEL)).toBe('started')

    const b = makeCharacter('refs-b')
    fs.rmSync(voiceDir('refs-b'), { recursive: true, force: true })
    refs.loadVoiceReferences(b, MODEL)
    refs.loadVoiceReferences(a, MODEL)
    expect(refs.getVoiceReferencesStatus().state).toBe('matching')
    expect(refs.rematchVoiceReferences(a, MODEL)).toBe('busy')

    mocks.broadcastEvent.mockReset()
    answer('{"happy":"忧伤","sad":"开心","shy":"开心"}')
    await flush()
    expect(refs.getVoiceReferencesStatus().entries).toEqual([
      { emotion: 'happy', group: null },
      { emotion: 'sad', group: '开心', clip: '开心/你好呀.wav' },
      { emotion: 'shy', group: '开心', clip: '开心/你好呀.wav' },
    ])
    expect(refs.getVoiceReferencesStatus().state).toBe('ok')
    expect(mocks.broadcastEvent).toHaveBeenCalledOnce()
    expect(mocks.completeSync).toHaveBeenCalledTimes(2)
  })
})
