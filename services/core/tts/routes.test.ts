// services/core/tts/routes.test.ts — 语音合成组件路由与管理器测试：状态透传（含开关与当前角色语音模型）、安装不等待与同步错误映射、指定文件夹的错误映射、开关、试听与错误映射、切换角色时换模型、新版本检查、退出时释放
// 用法：pnpm test；@mintbot/voice-agent-client 的 createTtsManager 换成假管理器，config 与当前会话换成假实现，角色语音文件只建在测试临时素材目录下，不下载、不启动进程、不写 data/
// 对应文件：services/core/tts/routes.ts / services/core/tts/manager.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { TtsError, type TtsErrorCode, type TtsStatus } from '@mintbot/voice-agent-client'
import { CHARACTERS_ROOT, type CharacterManifest } from '../characters/manifest.js'
import { ConfigFileUnreadableError } from '../config/configFileError.js'

const mocks = vi.hoisted(() => ({
  resolveManifestUrl: vi.fn<() => string | null>(),
  broadcastEvent: vi.fn(),
  getTtsEnabled: vi.fn<() => boolean>(),
  setTtsEnabled: vi.fn(),
  getCurrentState: vi.fn<() => unknown>(),
  createOptions: null as { root: string; manifest: string; onState?: (s: unknown) => void } | null,
  manager: {
    status: vi.fn(),
    install: vi.fn(),
    useExisting: vi.fn(),
    checkUpdate: vi.fn(),
    cancel: vi.fn(),
    startService: vi.fn(),
    loadModel: vi.fn(),
    stopService: vi.fn(),
    synthesize: vi.fn(),
    dispose: vi.fn(async () => {}),
  },
}))

vi.mock('@mintbot/voice-agent-client', async importOriginal => ({
  ...(await importOriginal<typeof import('@mintbot/voice-agent-client')>()),
  createTtsManager: (options: { root: string; manifest: string; onState?: (s: unknown) => void }) => {
    mocks.createOptions = options
    return mocks.manager
  },
}))
vi.mock('../voice/install.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../voice/install.js')>()),
  resolveManifestUrl: mocks.resolveManifestUrl,
}))
vi.mock('../events/broadcast.js', () => ({ broadcastEvent: mocks.broadcastEvent }))
vi.mock('../config/index.js', () => ({ getTtsEnabled: mocks.getTtsEnabled, setTtsEnabled: mocks.setTtsEnabled }))
vi.mock('../session/index.js', () => ({ getCurrentState: mocks.getCurrentState }))

import { applyCharacterVoice, checkTtsUpdate, disposeTts, initTts, TTS_DEFAULT_ROOT } from './manager.js'
import { ttsRoutes } from './routes.js'

const ROOT = path.join(os.tmpdir(), 'mintbot-tts-routes-test')
const CHARACTER_ID = 'tts-routes-test'
const CHARACTER_DIR = path.join(CHARACTERS_ROOT, CHARACTER_ID)
const MODEL = {
  gptWeights: path.join(CHARACTER_DIR, 'voice', 'x.ckpt'),
  sovitsWeights: path.join(CHARACTER_DIR, 'voice', 'x.pth'),
}

function ttsStatus(overrides: Partial<TtsStatus> = {}): TtsStatus {
  return {
    installed: false,
    source: null,
    variant: null,
    dir: null,
    updateAvailable: false,
    install: { state: 'idle' },
    lastDownload: null,
    service: { state: 'stopped', model: null, modelState: 'none' },
    ...overrides,
  }
}

function manifest(voice: CharacterManifest['voice']): CharacterManifest {
  return { displayName: '薄荷', voice } as CharacterManifest
}

const fullVoice: CharacterManifest['voice'] = {
  gptWeights: 'voice/x.ckpt',
  sovitsWeights: 'voice/x.pth',
  preview: { audio: 'voice/中立/x.wav', text: '参考文本', lang: 'ja' },
}

function useCharacter(voice: CharacterManifest['voice']): void {
  mocks.getCurrentState.mockReturnValue({ preset: { characterId: CHARACTER_ID }, manifest: manifest(voice) })
}

const installedDownload = ttsStatus({ installed: true, source: 'download', variant: 'v2pro', dir: 'D:\\tts\\GPT-SoVITS-v2pro' })

let app: FastifyInstance

beforeEach(async () => {
  for (const fn of Object.values(mocks.manager)) fn.mockReset()
  mocks.manager.status.mockReturnValue(ttsStatus())
  mocks.manager.dispose.mockResolvedValue(undefined)
  mocks.manager.startService.mockResolvedValue(undefined)
  mocks.manager.loadModel.mockResolvedValue(undefined)
  mocks.manager.stopService.mockResolvedValue(undefined)
  mocks.broadcastEvent.mockReset()
  mocks.getTtsEnabled.mockReset().mockReturnValue(false)
  mocks.setTtsEnabled.mockReset().mockImplementation((enabled: boolean) => mocks.getTtsEnabled.mockReturnValue(enabled))
  mocks.getCurrentState.mockReset().mockReturnValue(null)
  mocks.resolveManifestUrl.mockReturnValue('https://example.invalid/manifest.json')
  fs.mkdirSync(path.join(CHARACTER_DIR, 'voice'), { recursive: true })
  fs.writeFileSync(MODEL.gptWeights, '')
  fs.writeFileSync(MODEL.sovitsWeights, '')
  initTts(ROOT)
  app = Fastify()
  await app.register(ttsRoutes)
})

afterEach(async () => {
  await app.close()
  fs.rmSync(CHARACTER_DIR, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('tts routes', () => {
  it('creates the manager with the voice install root and broadcasts every state change', () => {
    expect(mocks.createOptions).toMatchObject({ root: ROOT, manifest: 'https://example.invalid/manifest.json' })
    mocks.createOptions?.onState?.(ttsStatus())
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('tts-status-changed', {})
  })

  it.each([
    ['no session', null, false, { name: '', voice: 'unconfigured', missing: [] }],
    ['no voice', null, true, { name: '薄荷', voice: 'unconfigured', missing: [] }],
    ['weights present', fullVoice, true, { name: '薄荷', voice: 'ok', missing: [] }],
    ['weights absent', { ...fullVoice!, gptWeights: 'voice/none.ckpt' }, false, { name: '薄荷', voice: 'missing', missing: ['voice/none.ckpt'] }],
  ] as const)('passes the manager status through with enabled and the character voice: %s', async (name, voice, enabled, character) => {
    if (name !== 'no session') useCharacter(voice as CharacterManifest['voice'])
    mocks.getTtsEnabled.mockReturnValue(enabled)
    mocks.manager.status.mockReturnValue(installedDownload)
    const res = await app.inject({ method: 'GET', url: '/tts/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ...installedDownload, enabled, character })
  })

  it.each([
    ['GET', '/tts/status', undefined],
    ['POST', '/tts/install', { variant: 'v2pro' }],
    ['POST', '/tts/use-existing', { dir: 'D:\\GPT-SoVITS' }],
    ['POST', '/tts/install/cancel', undefined],
    ['POST', '/tts/enabled', { enabled: true }],
    ['POST', '/tts/preview', undefined],
  ] as const)('answers 503 to %s %s without a manifest', async (method, url, payload) => {
    mocks.resolveManifestUrl.mockReturnValue(null)
    initTts(ROOT)
    const res = await app.inject({ method, url, payload })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ code: 'VOICE_INSTALL_UNCONFIGURED' })
  })

  it.each([
    ['nothing installed, no root', ttsStatus(), { variant: 'v5' }, { variant: 'v5', root: TTS_DEFAULT_ROOT }],
    ['nothing installed, chosen root', ttsStatus(), { variant: 'v2pro', root: 'E:\\tts' }, { variant: 'v2pro', root: 'E:\\tts' }],
    ['update of a download', installedDownload, { variant: 'v2pro' }, { variant: 'v2pro', root: undefined }],
  ])('starts the install without awaiting it: %s', async (_name, current, payload, expected) => {
    mocks.manager.status.mockReturnValue(current)
    mocks.manager.install.mockReturnValue(new Promise(() => {}))
    const res = await app.inject({ method: 'POST', url: '/tts/install', payload })
    expect(res.statusCode).toBe(202)
    expect(mocks.manager.install).toHaveBeenCalledWith(expected)
  })

  it.each([
    ['TTS_BUSY', 409],
    ['TTS_DISPOSED', 503],
  ] as const)('maps a synchronous %s from install to %i', async (code, statusCode) => {
    mocks.manager.install.mockImplementation(() => {
      throw new TtsError(code)
    })
    const res = await app.inject({ method: 'POST', url: '/tts/install', payload: { variant: 'v2pro' } })
    expect(res.statusCode).toBe(statusCode)
    expect(res.json()).toEqual({ code })
  })

  it('rejects an unknown variant', async () => {
    const res = await app.inject({ method: 'POST', url: '/tts/install', payload: { variant: 'v3' } })
    expect(res.statusCode).toBe(400)
    expect(mocks.manager.install).not.toHaveBeenCalled()
  })

  it.each([
    ['TTS_BUSY', 409, {}],
    ['TTS_EXISTING_INVALID', 400, { missing: ['api_v2.py'] }],
    ['TTS_PROBE', 400, { message: 'exited', stderr: ['line'] }],
    ['TTS_FAILED', 500, { message: 'EPERM' }],
    ['TTS_DISPOSED', 503, {}],
  ] as const)('maps %s from use-existing to %i with details', async (code, statusCode, details) => {
    mocks.manager.useExisting.mockRejectedValue(new TtsError(code as TtsErrorCode, { ...details }))
    const res = await app.inject({ method: 'POST', url: '/tts/use-existing', payload: { dir: 'D:\\GPT-SoVITS' } })
    expect(res.statusCode).toBe(statusCode)
    expect(res.json()).toEqual({ code, details })
  })

  it('answers the use-existing outcome', async () => {
    mocks.manager.useExisting.mockResolvedValue(true)
    const res = await app.inject({ method: 'POST', url: '/tts/use-existing', payload: { dir: 'D:\\GPT-SoVITS' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ installed: true })
    expect(mocks.manager.useExisting).toHaveBeenCalledWith('D:\\GPT-SoVITS')
  })

  it.each([
    ['enabled and accepted', true, true, true, false],
    ['disabled', false, true, false, false],
    ['cancelled', true, false, false, false],
    ['disposed while starting', true, true, true, true],
  ] as const)('applies the character voice after use-existing: %s', async (_name, enabled, installed, started, disposed) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    if (disposed) mocks.manager.startService.mockImplementation(() => { throw new TtsError('TTS_DISPOSED') })
    useCharacter(fullVoice)
    mocks.getTtsEnabled.mockReturnValue(enabled)
    mocks.manager.useExisting.mockImplementation(async () => {
      mocks.manager.status.mockReturnValue(ttsStatus({ installed }))
      return installed
    })
    const res = await app.inject({ method: 'POST', url: '/tts/use-existing', payload: { dir: 'D:\\GPT-SoVITS' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ installed })
    expect(error).not.toHaveBeenCalled()
    if (started) expect(mocks.manager.startService).toHaveBeenCalledWith(MODEL)
    else expect(mocks.manager.startService).not.toHaveBeenCalled()
    expect(mocks.manager.loadModel).not.toHaveBeenCalled()
  })

  it.each([
    ['enabled and installed', true, true, true, false],
    ['disabled', false, true, false, false],
    ['failed', true, false, false, false],
    ['disposed while starting', true, true, true, true],
  ] as const)('applies the character voice once the install settles: %s', async (_name, enabled, installed, started, disposed) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      if (disposed) mocks.manager.startService.mockImplementation(() => { throw new TtsError('TTS_DISPOSED') })
      let settle = () => {}
      mocks.manager.install.mockReturnValue(new Promise<void>(resolve => { settle = resolve }))
      const res = await app.inject({ method: 'POST', url: '/tts/install', payload: { variant: 'v2pro' } })
      expect(res.statusCode).toBe(202)
      expect(mocks.manager.startService).not.toHaveBeenCalled()
      useCharacter(fullVoice)
      mocks.getTtsEnabled.mockReturnValue(enabled)
      mocks.manager.status.mockReturnValue(ttsStatus({ installed }))
      settle()
      await new Promise(resolve => setImmediate(resolve))
      expect(rejections).toEqual([])
      expect(error).not.toHaveBeenCalled()
      if (started) expect(mocks.manager.startService).toHaveBeenCalledWith(MODEL)
      else expect(mocks.manager.startService).not.toHaveBeenCalled()
      expect(mocks.manager.loadModel).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('cancels', async () => {
    const res = await app.inject({ method: 'POST', url: '/tts/install/cancel' })
    expect(res.statusCode).toBe(200)
    expect(mocks.manager.cancel).toHaveBeenCalledOnce()
  })
})

describe('tts enabled', () => {
  it.each([
    ['enable with an ok character', true, fullVoice, true, 'startService', [MODEL], false, 200, { ok: true }],
    ['enable with no voice', true, null, true, 'loadModel', [null], false, 200, { ok: true }],
    ['enable without an install', true, fullVoice, false, null, [], false, 200, { ok: true }],
    ['disable', false, fullVoice, true, 'stopService', [], false, 200, { ok: true }],
    ['enable while disposed', true, fullVoice, true, 'startService', [MODEL], true, 503, { code: 'TTS_DISPOSED' }],
  ] as const)('%s saves and applies the character voice or stops the service', async (_name, enabled, voice, installed, called, args, disposed, statusCode, body) => {
    if (disposed) mocks.manager.startService.mockImplementation(() => { throw new TtsError('TTS_DISPOSED') })
    useCharacter(voice)
    mocks.manager.status.mockReturnValue(ttsStatus({ installed }))
    const res = await app.inject({ method: 'POST', url: '/tts/enabled', payload: { enabled } })
    expect(res.statusCode).toBe(statusCode)
    expect(res.json()).toEqual(body)
    expect(mocks.setTtsEnabled).toHaveBeenCalledWith(enabled)
    for (const name of ['startService', 'loadModel', 'stopService'] as const) {
      if (name === called) expect(mocks.manager[name]).toHaveBeenCalledWith(...args)
      else expect(mocks.manager[name]).not.toHaveBeenCalled()
    }
  })

  it('answers 500 CONFIG_FILE_UNREADABLE when the config cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.setTtsEnabled.mockImplementation(() => {
      throw new ConfigFileUnreadableError('bad json')
    })
    mocks.manager.status.mockReturnValue(ttsStatus({ installed: true }))
    const res = await app.inject({ method: 'POST', url: '/tts/enabled', payload: { enabled: true } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ code: 'CONFIG_FILE_UNREADABLE' })
    expect(error).toHaveBeenCalled()
    expect(mocks.manager.startService).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean', async () => {
    const res = await app.inject({ method: 'POST', url: '/tts/enabled', payload: { enabled: 'yes' } })
    expect(res.statusCode).toBe(400)
    expect(mocks.setTtsEnabled).not.toHaveBeenCalled()
  })
})

describe('tts preview', () => {
  it('synthesizes the greeting with the preview reference and answers audio/wav', async () => {
    useCharacter(fullVoice)
    mocks.manager.synthesize.mockResolvedValue(Buffer.from('RIFFwav'))
    const res = await app.inject({ method: 'POST', url: '/tts/preview' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('audio/wav')
    expect(res.rawPayload).toEqual(Buffer.from('RIFFwav'))
    expect(mocks.manager.synthesize).toHaveBeenCalledWith({
      text: '你好，我是薄荷，很高兴见到你。',
      textLang: 'zh',
      refAudio: path.join(CHARACTER_DIR, 'voice', '中立', 'x.wav'),
      refText: '参考文本',
      promptLang: 'ja',
    })
  })

  it.each([
    ['no session', undefined],
    ['no voice', null],
    ['no preview', { ...fullVoice!, preview: null }],
  ] as const)('answers 400 TTS_VOICE_UNCONFIGURED with %s', async (name, voice) => {
    if (name !== 'no session') useCharacter(voice as CharacterManifest['voice'])
    const res = await app.inject({ method: 'POST', url: '/tts/preview' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'TTS_VOICE_UNCONFIGURED' })
    expect(mocks.manager.synthesize).not.toHaveBeenCalled()
  })

  it.each([
    ['TTS_NOT_READY', 409, {}],
    ['TTS_SYNTHESIS', 502, { status: 400, message: 'bad ref' }],
    ['TTS_DISPOSED', 503, {}],
  ] as const)('maps %s to %i with details', async (code, statusCode, details) => {
    useCharacter(fullVoice)
    mocks.manager.synthesize.mockRejectedValue(new TtsError(code as TtsErrorCode, { ...details }))
    const res = await app.inject({ method: 'POST', url: '/tts/preview' })
    expect(res.statusCode).toBe(statusCode)
    expect(res.json()).toEqual({ code, details })
  })
})

describe('applyCharacterVoice', () => {
  it.each([
    ['an ok character starts the service with its model', fullVoice, 'startService', MODEL],
    ['a character without voice clears the model', null, 'loadModel', null],
    ['a character with missing weights clears the model', { ...fullVoice!, sovitsWeights: 'voice/none.pth' }, 'loadModel', null],
  ] as const)('%s', (_name, voice, called, arg) => {
    mocks.getTtsEnabled.mockReturnValue(true)
    mocks.manager.status.mockReturnValue(ttsStatus({ installed: true }))
    applyCharacterVoice({ characterId: CHARACTER_ID, manifest: manifest(voice) })
    expect(mocks.manager[called]).toHaveBeenCalledWith(arg)
    expect(mocks.manager[called === 'startService' ? 'loadModel' : 'startService']).not.toHaveBeenCalled()
  })

  it.each([
    ['disabled', false, true],
    ['not installed', true, false],
  ])('does nothing when %s', (_name, enabled, installed) => {
    mocks.getTtsEnabled.mockReturnValue(enabled)
    mocks.manager.status.mockReturnValue(ttsStatus({ installed }))
    applyCharacterVoice({ characterId: CHARACTER_ID, manifest: manifest(fullVoice) })
    expect(mocks.manager.startService).not.toHaveBeenCalled()
    expect(mocks.manager.loadModel).not.toHaveBeenCalled()
  })
})

describe('checkTtsUpdate', () => {
  it.each([
    ['not installed', ttsStatus()],
    ['an existing folder', ttsStatus({ installed: true, source: 'existing', dir: 'D:\\GPT-SoVITS' })],
  ])('skips %s', async (_name, current) => {
    mocks.manager.status.mockReturnValue(current)
    await checkTtsUpdate()
    expect(mocks.manager.checkUpdate).not.toHaveBeenCalled()
  })

  it('checks a download with a timeout signal and caches a success', async () => {
    mocks.manager.status.mockReturnValue(installedDownload)
    mocks.manager.checkUpdate.mockResolvedValue(undefined)
    await checkTtsUpdate()
    await checkTtsUpdate()
    expect(mocks.manager.checkUpdate).toHaveBeenCalledOnce()
    expect(mocks.manager.checkUpdate.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal)
  })

  it('logs a failure and checks again next time', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.manager.status.mockReturnValue(installedDownload)
    mocks.manager.checkUpdate.mockRejectedValue(new TtsError('TTS_MANIFEST'))
    await checkTtsUpdate()
    await checkTtsUpdate()
    expect(mocks.manager.checkUpdate).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith('[TTS] Update check failed:', expect.any(TtsError))
  })
})

it('disposes the manager on shutdown', async () => {
  await disposeTts()
  expect(mocks.manager.dispose).toHaveBeenCalledOnce()
})
