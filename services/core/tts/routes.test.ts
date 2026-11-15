// services/core/tts/routes.test.ts — 语音合成组件路由与管理器测试：状态透传、安装不等待与同步错误映射、指定文件夹的错误映射、新版本检查、退出时释放
// 用法：pnpm test；@mintbot/voice-agent-client 的 createTtsManager 换成假管理器，不下载、不启动进程、不写 data/
// 对应文件：services/core/tts/routes.ts / services/core/tts/manager.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import os from 'os'
import path from 'path'
import { TtsError, type TtsErrorCode, type TtsStatus } from '@mintbot/voice-agent-client'

const mocks = vi.hoisted(() => ({
  resolveManifestUrl: vi.fn<() => string | null>(),
  broadcastEvent: vi.fn(),
  createOptions: null as { root: string; manifest: string; onState?: (s: unknown) => void } | null,
  manager: {
    status: vi.fn(),
    install: vi.fn(),
    useExisting: vi.fn(),
    checkUpdate: vi.fn(),
    cancel: vi.fn(),
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

import { checkTtsUpdate, disposeTts, initTts, TTS_DEFAULT_ROOT } from './manager.js'
import { ttsRoutes } from './routes.js'

const ROOT = path.join(os.tmpdir(), 'mintbot-tts-routes-test')

function ttsStatus(overrides: Partial<TtsStatus> = {}): TtsStatus {
  return {
    installed: false,
    source: null,
    variant: null,
    dir: null,
    updateAvailable: false,
    install: { state: 'idle' },
    lastDownload: null,
    ...overrides,
  }
}

const installedDownload = ttsStatus({ installed: true, source: 'download', variant: 'v2pro', dir: 'D:\\tts\\GPT-SoVITS-v2pro' })

let app: FastifyInstance

beforeEach(async () => {
  for (const fn of Object.values(mocks.manager)) fn.mockReset()
  mocks.manager.status.mockReturnValue(ttsStatus())
  mocks.manager.dispose.mockResolvedValue(undefined)
  mocks.broadcastEvent.mockReset()
  mocks.resolveManifestUrl.mockReturnValue('https://example.invalid/manifest.json')
  initTts(ROOT)
  app = Fastify()
  await app.register(ttsRoutes)
})

afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
})

describe('tts routes', () => {
  it('creates the manager with the voice install root and broadcasts every state change', () => {
    expect(mocks.createOptions).toMatchObject({ root: ROOT, manifest: 'https://example.invalid/manifest.json' })
    mocks.createOptions?.onState?.(ttsStatus())
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('tts-status-changed', {})
  })

  it('passes the manager status through', async () => {
    mocks.manager.status.mockReturnValue(installedDownload)
    const res = await app.inject({ method: 'GET', url: '/tts/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(installedDownload)
  })

  it.each([
    ['GET', '/tts/status', undefined],
    ['POST', '/tts/install', { variant: 'v2pro' }],
    ['POST', '/tts/use-existing', { dir: 'D:\\GPT-SoVITS' }],
    ['POST', '/tts/install/cancel', undefined],
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

  it('cancels', async () => {
    const res = await app.inject({ method: 'POST', url: '/tts/install/cancel' })
    expect(res.statusCode).toBe(200)
    expect(mocks.manager.cancel).toHaveBeenCalledOnce()
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
