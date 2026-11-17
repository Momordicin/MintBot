// services/core/tts/narration.test.ts — 朗读测试：括号与断句、多条回复按顺序、按情绪选参考音频与回退到试听参考、各前提不满足时不朗读、停止、合成失败与失败静音、播放不可用时丢弃剩余句子、上次失败记录的代码、朗读中状态的广播
// 用法：pnpm test；voice/agent.ts、tts/manager.ts、tts/voiceRefs.ts、config、broadcast 换成假实现，不启动语音组件或 GPT-SoVITS，不写 data/
// 对应文件：services/core/tts/narration.ts / services/core/tts/voiceRefs.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import { AgentHttpError, PlaybackError, TtsError, type PlaybackEvent } from '@mintbot/voice-agent-client'
import { CHARACTERS_ROOT, type CharacterManifest } from '../characters/manifest.js'

interface Listener {
  onPlayback(ev: PlaybackEvent): void
  onPlaybackFailed(message: string): void
  onPlaybackIdle(): void
  onLeftRunning(): void
}

const mocks = vi.hoisted(() => ({
  VoiceOperationError: class extends Error {
    constructor(readonly status: number, readonly errorCode: string) {
      super(errorCode)
    }
  },
  listener: null as Listener | null,
  playbackSupported: true as boolean | null,
  playClip: vi.fn<(wav: Buffer) => Promise<number>>(),
  stopPlayback: vi.fn<() => Promise<void>>(),
  synthesize: vi.fn<(r: { text: string }) => Promise<Buffer>>(),
  service: { state: 'running', modelState: 'loaded' } as { state: string; modelState: string },
  hasManager: true,
  voiceOk: true,
  enabled: true,
  broadcastEvent: vi.fn(),
  voiceReferenceFor: vi.fn<(characterId: string, emotion: string | null) => unknown>(),
}))

vi.mock('../voice/agent.js', () => ({
  setPlaybackListener: (listener: Listener) => {
    mocks.listener = listener
  },
  getPlaybackSupported: () => mocks.playbackSupported,
  playClip: mocks.playClip,
  stopPlayback: mocks.stopPlayback,
  VoiceOperationError: mocks.VoiceOperationError,
}))
vi.mock('./manager.js', () => ({
  getTtsManager: () =>
    mocks.hasManager ? { status: () => ({ service: mocks.service }), synthesize: mocks.synthesize } : null,
  characterVoiceStatus: () => ({ voice: mocks.voiceOk ? 'ok' : 'missing', missing: [], model: null }),
}))
vi.mock('./voiceRefs.js', () => ({ voiceReferenceFor: mocks.voiceReferenceFor }))
vi.mock('../config/index.js', () => ({ getTtsEnabled: () => mocks.enabled }))
vi.mock('../events/broadcast.js', () => ({ broadcastEvent: mocks.broadcastEvent }))

type Narration = typeof import('./narration.js')
let narration: Narration

const CHARACTER = {
  characterId: 'narration-test',
  manifest: {
    voice: { gptWeights: 'g.ckpt', sovitsWeights: 's.pth', preview: { audio: 'voice/ref.wav', text: '参考', lang: 'ja' } },
  } as CharacterManifest,
}

function wav(rate: number, samples: number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, i) => data.writeInt16LE(sample, i * 2))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const SPEECH = wav(32000, [100, -200, 300])
const SILENCE = wav(16000, [0, 0, 0, 0])

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
}

function speakingBroadcasts(): boolean[] {
  return mocks.broadcastEvent.mock.calls.filter(([event]) => event === 'narration-changed').map(([, data]) => data.speaking)
}

function playedTexts(): string[] {
  return mocks.synthesize.mock.calls.map(([r]) => r.text)
}

let nextId = 0

beforeEach(async () => {
  vi.resetModules()
  mocks.listener = null
  mocks.playbackSupported = true
  mocks.service = { state: 'running', modelState: 'loaded' }
  mocks.hasManager = true
  mocks.voiceOk = true
  mocks.enabled = true
  mocks.broadcastEvent.mockReset()
  mocks.voiceReferenceFor.mockReset().mockReturnValue(null)
  mocks.synthesize.mockReset().mockResolvedValue(SPEECH)
  nextId = 0
  mocks.playClip.mockReset().mockImplementation(async () => ++nextId)
  mocks.stopPlayback.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  narration = await import('./narration.js')
})

describe('splitSentences', () => {
  it.each([
    ['removes full-width and ASCII bracket content', '（笑）你好。(waves)再见！', ['你好', '再见']],
    ['splits at every sentence mark and newline', '一；二;三…四?五!六\n七', ['一', '二', '三', '四', '五', '六', '七']],
    ['drops empty and punctuation-only pieces', '……。！  \n，，。好', ['好']],
    ['keeps unmatched brackets', '（没有结束。好', ['（没有结束', '好']],
    ['nothing readable', '（叹气）', []],
  ])('%s', (_name, text, expected) => {
    expect(narration.splitSentences(text)).toEqual(expected)
  })
})

describe('narrateReply', () => {
  it('reads two replies in order with the preview reference', async () => {
    narration.narrateReply('第一句。第二句', CHARACTER)
    narration.narrateReply('第三句', CHARACTER)
    await flush()
    expect(playedTexts()).toEqual(['第一句', '第二句', '第三句'])
    expect(mocks.synthesize.mock.calls[0][0]).toEqual({
      text: '第一句',
      textLang: 'ja',
      refAudio: path.join(CHARACTERS_ROOT, 'narration-test', 'voice', 'ref.wav'),
      refText: '参考',
      promptLang: 'ja',
    })
    expect(mocks.playClip).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['the emotion clip when one is mapped', { refAudio: '/refs/开心/开心.wav', refText: '开心', lang: 'ja' }, { refAudio: '/refs/开心/开心.wav', refText: '开心' }],
    ['the preview when no clip is mapped', null, { refAudio: path.join(CHARACTERS_ROOT, 'narration-test', 'voice', 'ref.wav'), refText: '参考' }],
  ])('reads with %s', async (_name, reference, expected) => {
    mocks.voiceReferenceFor.mockReturnValue(reference)
    narration.narrateReply('你好', CHARACTER, 'happy')
    await flush()
    expect(mocks.voiceReferenceFor).toHaveBeenCalledWith('narration-test', 'happy')
    expect(mocks.synthesize.mock.calls[0][0]).toMatchObject({ ...expected, textLang: 'ja', promptLang: 'ja' })
  })

  it.each([
    ['tts disabled', () => { mocks.enabled = false }],
    ['no manager', () => { mocks.hasManager = false }],
    ['character voice not ok', () => { mocks.voiceOk = false }],
    ['no preview', () => { CHARACTER.manifest.voice!.preview = null }],
    ['service starting', () => { mocks.service = { state: 'starting', modelState: 'none' } }],
    ['model loading', () => { mocks.service = { state: 'running', modelState: 'loading' } }],
    ['playback unknown', () => { mocks.playbackSupported = null }],
    ['playback unsupported', () => { mocks.playbackSupported = false }],
  ])('reads nothing when %s', async (_name, arrange) => {
    const preview = CHARACTER.manifest.voice!.preview
    arrange()
    narration.narrateReply('你好。', CHARACTER)
    await flush()
    CHARACTER.manifest.voice!.preview = preview
    expect(mocks.synthesize).not.toHaveBeenCalled()
    expect(speakingBroadcasts()).toEqual([])
  })

  it('stop during synthesis drops the result and broadcasts false once', async () => {
    let finishSynthesis = (_wav: Buffer) => {}
    mocks.synthesize.mockImplementationOnce(() => new Promise(resolve => { finishSynthesis = resolve }))
    narration.narrateReply('一。二', CHARACTER)
    await flush()
    await narration.stopNarration()
    expect(narration.isSpeaking()).toBe(false)
    expect(speakingBroadcasts()).toEqual([true, false])
    expect(mocks.stopPlayback).toHaveBeenCalledOnce()
    finishSynthesis(SPEECH)
    await flush()
    expect(mocks.playClip).not.toHaveBeenCalled()
    expect(playedTexts()).toEqual(['一'])
    expect(narration.isSpeaking()).toBe(false)
    expect(speakingBroadcasts()).toEqual([true, false])
  })

  it('reads a new reply after the discarded synthesis settles and stays speaking while it is queued', async () => {
    let finishSynthesis = (_wav: Buffer) => {}
    mocks.synthesize.mockImplementationOnce(() => new Promise(resolve => { finishSynthesis = resolve }))
    narration.narrateReply('一。二', CHARACTER)
    await flush()
    await narration.stopNarration()
    narration.narrateReply('三', CHARACTER)
    await flush()
    expect(narration.isSpeaking()).toBe(true)
    expect(mocks.synthesize).toHaveBeenCalledOnce()
    finishSynthesis(SPEECH)
    await flush()
    expect(playedTexts()).toEqual(['一', '三'])
    expect(mocks.playClip).toHaveBeenCalledOnce()
    expect(narration.isSpeaking()).toBe(true)
    mocks.listener!.onPlayback({ state: 'end', id: 1 })
    expect(narration.isSpeaking()).toBe(false)
    expect(speakingBroadcasts()).toEqual([true, false, true, false])
  })

  it('stops speaking once stopPlayback is sent for a playing clip', async () => {
    narration.narrateReply('一', CHARACTER)
    await flush()
    expect(narration.isSpeaking()).toBe(true)
    await narration.stopNarration()
    expect(mocks.stopPlayback).toHaveBeenCalledOnce()
    expect(narration.isSpeaking()).toBe(false)
    mocks.listener!.onPlayback({ state: 'stopped', id: 1 })
    expect(speakingBroadcasts()).toEqual([true, false])
  })

  it('stop while a clip is being queued waits for it before stopPlayback', async () => {
    const order: string[] = []
    let finishPlay = (_id: number) => {}
    mocks.playClip.mockImplementationOnce(() => new Promise(resolve => { finishPlay = resolve }))
    mocks.stopPlayback.mockImplementation(async () => { order.push('stop') })
    narration.narrateReply('一。二', CHARACTER)
    await flush()
    const stopped = narration.stopNarration()
    await flush()
    expect(mocks.stopPlayback).not.toHaveBeenCalled()
    order.push('play settled')
    finishPlay(1)
    await stopped
    expect(order).toEqual(['play settled', 'stop'])
    expect(playedTexts()).toEqual(['一'])
    expect(narration.isSpeaking()).toBe(false)
    expect(speakingBroadcasts()).toEqual([true, false])
  })

  it.each([
    ['two stops in a row', async () => {
      narration.narrateReply('一', CHARACTER)
      await flush()
      await narration.stopNarration()
      await narration.stopNarration()
    }, [true, false]],
    ['a stopped event while stopPlayback is pending', async () => {
      let finishStop = (_value: void) => {}
      mocks.stopPlayback.mockImplementationOnce(() => new Promise<void>(resolve => { finishStop = resolve }))
      narration.narrateReply('一', CHARACTER)
      await flush()
      const stopped = narration.stopNarration()
      await flush()
      mocks.listener!.onPlayback({ state: 'stopped', id: 1 })
      finishStop()
      await stopped
    }, [true, false]],
    ['the agent leaving running while stopPlayback is pending', async () => {
      let finishStop = (_value: void) => {}
      mocks.stopPlayback.mockImplementationOnce(() => new Promise<void>(resolve => { finishStop = resolve }))
      narration.narrateReply('一', CHARACTER)
      await flush()
      const stopped = narration.stopNarration()
      await flush()
      mocks.listener!.onLeftRunning()
      finishStop()
      await stopped
    }, [true, false]],
    ['a stop while nothing is narrating', () => narration.stopNarration(), []],
  ])('ends not speaking after %s', async (_name, act, broadcasts) => {
    await act()
    expect(narration.isSpeaking()).toBe(false)
    expect(speakingBroadcasts()).toEqual(broadcasts)
  })

  it.each([
    ['a rejected synthesis', () => mocks.synthesize.mockRejectedValueOnce(new TtsError('TTS_SYNTHESIS', { message: 'boom' })), { code: 'TTS_SYNTHESIS', message: 'boom' }],
    ['a synthesis rejected without a TTS code', () => mocks.synthesize.mockRejectedValueOnce(new Error('broken')), { code: 'TTS_SYNTHESIS', message: 'broken' }],
    ['failure silence', () => mocks.synthesize.mockResolvedValueOnce(SILENCE), { code: 'TTS_SILENT', message: '' }],
  ])('skips the sentence after %s and records the error', async (_name, arrange, error) => {
    arrange()
    narration.narrateReply('一。二', CHARACTER)
    await flush()
    expect(playedTexts()).toEqual(['一', '二'])
    expect(mocks.playClip).toHaveBeenCalledOnce()
    expect(narration.getNarrationLastError()).toMatchObject(error)
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('tts-status-changed', {})
  })

  it('does not treat 16 kHz speech as failure silence', () => {
    expect(narration.isFailureSilence(wav(16000, [0, 5, 0]))).toBe(false)
    expect(narration.isFailureSilence(SILENCE)).toBe(true)
  })

  it.each([
    ['the agent is not running', new PlaybackError('PLAYBACK_NOT_RUNNING', { phase: 'restarting' }), { code: 'PLAYBACK_NOT_RUNNING' }],
    ['the agent rejects the clip', new AgentHttpError('POST', '/v1/play', 500, 'bad'), { code: 'AGENT_HTTP', status: 500 }],
    ['there is no voice agent', new mocks.VoiceOperationError(503, 'VOICE_UNAVAILABLE'), { code: 'VOICE_UNAVAILABLE' }],
    ['the request fails on the network', new TypeError('fetch failed'), { code: 'AGENT_UNREACHABLE', message: 'fetch failed' }],
  ])('records the playback error code when %s', async (_name, err, error) => {
    mocks.playClip.mockRejectedValueOnce(err)
    narration.narrateReply('一。二', CHARACTER)
    await flush()
    expect(playedTexts()).toEqual(['一'])
    expect(narration.getNarrationLastError()).toMatchObject(error)
  })

  it('skips a clip with an unsupported format and records the code', async () => {
    mocks.playClip.mockRejectedValueOnce(new PlaybackError('PLAYBACK_UNSUPPORTED_WAV', {}))
    narration.narrateReply('一。二', CHARACTER)
    await flush()
    expect(playedTexts()).toEqual(['一', '二'])
    expect(narration.getNarrationLastError()).toMatchObject({ code: 'PLAYBACK_UNSUPPORTED_WAV' })
  })

  it('drops the rest of the queue when the agent is not running', async () => {
    mocks.playClip.mockRejectedValueOnce(new PlaybackError('PLAYBACK_NOT_RUNNING', { phase: 'restarting' }))
    narration.narrateReply('一。二。三', CHARACTER)
    await flush()
    expect(playedTexts()).toEqual(['一'])
    expect(narration.getNarrationLastError()).toMatchObject({ code: 'PLAYBACK_NOT_RUNNING' })
    expect(narration.isSpeaking()).toBe(false)
    narration.narrateReply('四', CHARACTER)
    await flush()
    expect(playedTexts()).toEqual(['一', '四'])
  })

  it('broadcasts speaking true then false once, including an end that arrives before play resolves', async () => {
    let finishPlay = (_id: number) => {}
    mocks.playClip.mockImplementationOnce(() => new Promise(resolve => { finishPlay = resolve }))
    narration.narrateReply('一', CHARACTER)
    await flush()
    mocks.listener!.onPlayback({ state: 'start', id: 1 })
    mocks.listener!.onPlayback({ state: 'end', id: 1 })
    finishPlay(1)
    await flush()
    expect(narration.isSpeaking()).toBe(false)
    expect(speakingBroadcasts()).toEqual([true, false])
  })

  it('stays speaking until the clip ends and clears the last error on a successful end', async () => {
    mocks.listener!.onPlaybackFailed('device lost')
    expect(narration.getNarrationLastError()).toMatchObject({ code: 'playback_failed', message: 'device lost' })
    narration.narrateReply('一', CHARACTER)
    await flush()
    expect(narration.isSpeaking()).toBe(true)
    mocks.listener!.onPlayback({ state: 'end', id: 1 })
    expect(narration.isSpeaking()).toBe(false)
    expect(narration.getNarrationLastError()).toBeNull()
    expect(speakingBroadcasts()).toEqual([true, false])
  })

  it('forgets queued sentences and playing clips when the agent leaves running', async () => {
    let finishSynthesis = (_wav: Buffer) => {}
    narration.narrateReply('一', CHARACTER)
    await flush()
    mocks.synthesize.mockImplementationOnce(() => new Promise(resolve => { finishSynthesis = resolve }))
    narration.narrateReply('二。三', CHARACTER)
    await flush()
    mocks.listener!.onLeftRunning()
    finishSynthesis(SPEECH)
    await flush()
    expect(playedTexts()).toEqual(['一', '二'])
    expect(mocks.playClip).toHaveBeenCalledOnce()
    expect(narration.isSpeaking()).toBe(false)
    expect(speakingBroadcasts()).toEqual([true, false])
  })
})
