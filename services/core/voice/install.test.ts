// services/core/voice/install.test.ts — 语音组件一键安装流程的测试：状态、进度节流、取消、失败恢复、互斥、退出
// 用法：pnpm test；mock voice/install.js 的安装函数与 supervisor，经 voiceRoutes 的 /voice/install 与 /voice/status 驱动
// 对应文件：services/core/voice/agent.ts / services/core/voice/routes.ts / services/core/voice/install.ts / services/core/voice/agent.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mocks = vi.hoisted(() => ({
  readVoiceInstallation: vi.fn(),
  installVoice: vi.fn(),
  resolveManifestUrl: vi.fn(),
  fetchRemoteManifestInfo: vi.fn(),
  removeStaleVoiceVersions: vi.fn(async () => {}),
  broadcastEvent: vi.fn(),
  supervisorOptions: null as { onState: (s: unknown) => void; voiceprintPath: string } | null,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  call: vi.fn(),
  setListening: vi.fn(),
  getVoiceInputMode: vi.fn(() => 'off'),
  setVoiceInputMode: vi.fn(),
}))

vi.mock('./install.js', () => ({
  readVoiceInstallation: mocks.readVoiceInstallation,
  installVoice: mocks.installVoice,
  resolveManifestUrl: mocks.resolveManifestUrl,
  fetchRemoteManifestInfo: mocks.fetchRemoteManifestInfo,
  removeStaleVoiceVersions: mocks.removeStaleVoiceVersions,
}))
vi.mock('../events/broadcast.js', () => ({ broadcastEvent: mocks.broadcastEvent }))
vi.mock('../config/index.js', () => ({
  getVoiceInputMode: mocks.getVoiceInputMode,
  setVoiceInputMode: mocks.setVoiceInputMode,
}))
vi.mock('@mintbot/voice-agent-client', () => ({
  API_VERSION: 1,
  VoiceAgentSupervisor: class {
    constructor(options: { onState: (s: unknown) => void; voiceprintPath: string }) {
      mocks.supervisorOptions = options
    }
    start = mocks.start
    stop = mocks.stop
    call = mocks.call
    setListening = mocks.setListening
  },
}))

import { cancelInstallForShutdown, startVoice, stopVoice } from './agent.js'
import { voiceRoutes } from './routes.js'
import Fastify from 'fastify'

interface InstallCall {
  manifest: string
  signal: AbortSignal
  onStep: (p: Record<string, unknown>) => void
}

let dataDir: string
let app: ReturnType<typeof Fastify>
let installCall: InstallCall
let finishInstall: () => void
let failInstall: (err: unknown) => void

function post(url: string) {
  return app.inject({ method: 'POST', url })
}

async function status() {
  return (await app.inject({ method: 'GET', url: '/voice/status' })).json()
}

function statusChangedCount(): number {
  return mocks.broadcastEvent.mock.calls.filter(c => c[0] === 'voice-status-changed').length
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0)
}

function installError(code: string, details: Record<string, unknown> = {}) {
  return Object.assign(new Error(code), { name: 'VoiceInstallError', code, details })
}

describe('voice component install', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-voice-install-test-'))
    mocks.readVoiceInstallation.mockReset()
    mocks.broadcastEvent.mockReset()
    mocks.installVoice.mockReset()
    mocks.resolveManifestUrl.mockReset()
    mocks.removeStaleVoiceVersions.mockReset()
    mocks.removeStaleVoiceVersions.mockResolvedValue(undefined)
    mocks.call.mockReset()
    mocks.call.mockResolvedValue({})
    mocks.start.mockClear()
    mocks.stop.mockClear()
    mocks.supervisorOptions = null
    mocks.readVoiceInstallation.mockResolvedValue(null)
    mocks.resolveManifestUrl.mockReturnValue('https://example.invalid/manifest.json')
    mocks.installVoice.mockImplementation(
      (manifest: string, _onProgress: unknown, extra: { signal: AbortSignal; onStep: InstallCall['onStep'] }) =>
        new Promise((resolve, reject) => {
          installCall = { manifest, ...extra }
          finishInstall = () => resolve({ version: '0.3.0' })
          failInstall = reject
          extra.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })))
        })
    )
    await startVoice(dataDir)
    app = Fastify()
    await app.register(voiceRoutes)
    mocks.broadcastEvent.mockClear()
  })

  afterEach(async () => {
    finishInstall?.()
    await settle()
    vi.useRealTimers()
    await app.close()
    await stopVoice()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('starts in idle and reports it in status', async () => {
    expect((await status()).install).toEqual({ state: 'idle' })
  })

  it('answers 202, stops the running agent, installs with the resolved manifest and starts voice afterwards', async () => {
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.2.0' })
    await startVoice(dataDir)
    mocks.start.mockClear()
    mocks.stop.mockClear()
    mocks.getVoiceInputMode.mockClear()
    const res = await post('/voice/install')
    expect(res.statusCode).toBe(202)
    await settle()
    expect(mocks.stop).toHaveBeenCalledTimes(1)
    expect(installCall.manifest).toBe('https://example.invalid/manifest.json')
    expect(mocks.setVoiceInputMode).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    expect((await status()).install).toEqual({ state: 'installing' })
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.3.0' })
    finishInstall()
    await settle()
    expect(mocks.start).toHaveBeenCalledTimes(1)
    const body = await status()
    expect(body.install).toEqual({ state: 'idle' })
    expect(body.installed).toBe(true)
  })

  it('follows the steps and throttles progress notifications to one per 500 ms', async () => {
    await post('/voice/install')
    await settle()
    mocks.broadcastEvent.mockClear()
    installCall.onStep({ package: 'agent', phase: 'download', bytes: 0, total: 1000 })
    expect(statusChangedCount()).toBe(1)
    installCall.onStep({ package: 'agent', phase: 'download', bytes: 100, total: 1000 })
    installCall.onStep({ package: 'agent', phase: 'download', bytes: 200, total: 1000 })
    expect(statusChangedCount()).toBe(1)
    expect((await status()).install).toEqual({ state: 'installing', package: 'agent', phase: 'download', bytes: 200, total: 1000 })
    await vi.advanceTimersByTimeAsync(500)
    installCall.onStep({ package: 'agent', phase: 'download', bytes: 300, total: 1000 })
    expect(statusChangedCount()).toBe(2)
    installCall.onStep({ package: 'agent', phase: 'verify' })
    expect(statusChangedCount()).toBe(3)
    expect((await status()).install).toEqual({ state: 'installing', package: 'agent', phase: 'verify' })
    installCall.onStep({ package: 'models', phase: 'download', bytes: 1, total: 2 })
    expect(statusChangedCount()).toBe(4)
    installCall.onStep({ package: 'models', phase: 'extract' })
    expect(statusChangedCount()).toBe(5)
  })

  it('cancel returns to idle, restores voice, and answers 200 even when nothing is installing', async () => {
    expect((await post('/voice/install/cancel')).statusCode).toBe(200)
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.2.0' })
    await post('/voice/install')
    await settle()
    mocks.start.mockClear()
    expect((await post('/voice/install/cancel')).statusCode).toBe(200)
    await settle()
    expect((await status()).install).toEqual({ state: 'idle' })
    expect(mocks.start).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['NETWORK_ERROR', {}],
    ['HTTP_STATUS', { url: 'u', status: 404 }],
    ['SHA256_MISMATCH', { file: 'a' }],
    ['ENOSPC_PRECHECK', { required: 2097152, available: 1048576 }],
  ])('a %s failure enters failed with code and details and tries to restore voice', async (code, details) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.2.0' })
    await post('/voice/install')
    await settle()
    mocks.start.mockClear()
    failInstall(installError(code, details))
    await settle()
    expect((await status()).install).toEqual({ state: 'failed', errorCode: code, errorDetails: details })
    expect(mocks.start).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('an error without a code becomes UNKNOWN and a retry clears the previous error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await post('/voice/install')
    await settle()
    failInstall(new Error('boom'))
    await settle()
    expect((await status()).install).toEqual({ state: 'failed', errorCode: 'UNKNOWN', errorDetails: {} })
    expect((await post('/voice/install')).statusCode).toBe(202)
    expect((await status()).install).toEqual({ state: 'installing' })
    errorSpy.mockRestore()
  })

  it('is 409 VOICE_BUSY while installing', async () => {
    await post('/voice/install')
    const res = await post('/voice/install')
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'VOICE_BUSY' })
    expect(mocks.installVoice).toHaveBeenCalledTimes(1)
  })

  it('is 409 VOICE_BUSY while testing or enrolling', async () => {
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.2.0' })
    await startVoice(dataDir)
    mocks.supervisorOptions!.onState({ phase: 'running', listening: true, restarts: 0 })
    expect((await post('/voice/test/start')).statusCode).toBe(200)
    const whileTesting = await post('/voice/install')
    expect(whileTesting.statusCode).toBe(409)
    expect(whileTesting.json()).toEqual({ code: 'VOICE_BUSY' })
    await post('/voice/test/stop')
    expect((await post('/voice/enroll/start')).statusCode).toBe(200)
    expect((await post('/voice/install')).statusCode).toBe(409)
    expect(mocks.installVoice).not.toHaveBeenCalled()
  })

  it('is 503 VOICE_INSTALL_UNCONFIGURED without a manifest address', async () => {
    mocks.resolveManifestUrl.mockReturnValue(null)
    const res = await post('/voice/install')
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ code: 'VOICE_INSTALL_UNCONFIGURED' })
    expect(mocks.installVoice).not.toHaveBeenCalled()
    expect((await status()).install).toEqual({ state: 'idle' })
  })

  it('falls back to the pinned manifest address when the environment value is empty or blank', async () => {
    const actual = await vi.importActual<typeof import('./install.js')>('./install.js')
    const saved = process.env.MINTBOT_VOICE_MANIFEST
    try {
      for (const value of ['', '   ']) {
        process.env.MINTBOT_VOICE_MANIFEST = value
        expect(actual.resolveManifestUrl()).toBe(actual.PINNED_MANIFEST_URL)
      }
      process.env.MINTBOT_VOICE_MANIFEST = '  https://example.invalid/override.json  '
      expect(actual.resolveManifestUrl()).toBe('https://example.invalid/override.json')
    } finally {
      if (saved === undefined) delete process.env.MINTBOT_VOICE_MANIFEST
      else process.env.MINTBOT_VOICE_MANIFEST = saved
    }
    expect(actual.PINNED_MANIFEST_URL).toContain('/releases/latest/download/manifest.json')
  })

  it('restores voice with the data directory given to startVoice', async () => {
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.3.0' })
    await post('/voice/install')
    await settle()
    mocks.supervisorOptions = null
    finishInstall()
    await settle()
    expect(mocks.supervisorOptions!.voiceprintPath).toBe(path.join(dataDir, 'owner.voiceprint.json'))
  })

  it('stays installing and answers 409 while voice is being restored, then publishes the result', async () => {
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.3.0' })
    let releaseStart!: () => void
    mocks.start.mockImplementationOnce(() => new Promise<void>(resolve => { releaseStart = resolve }))
    await post('/voice/install')
    await settle()
    installCall.onStep({ package: 'models', phase: 'extract' })
    mocks.broadcastEvent.mockClear()
    finishInstall()
    await settle()
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect((await status()).install).toEqual({ state: 'installing', phase: 'starting' })
    expect(statusChangedCount()).toBe(1)
    const res = await post('/voice/install')
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'VOICE_BUSY' })
    mocks.broadcastEvent.mockClear()
    releaseStart()
    await settle()
    expect((await status()).install).toEqual({ state: 'idle' })
    expect(statusChangedCount()).toBeGreaterThan(0)
  })

  it('shows failed after restoring voice when the install had failed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let releaseStart!: () => void
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.2.0' })
    mocks.start.mockImplementationOnce(() => new Promise<void>(resolve => { releaseStart = resolve }))
    await post('/voice/install')
    await settle()
    installCall.onStep({ package: 'agent', phase: 'download', bytes: 5, total: 10 })
    failInstall(installError('NETWORK_ERROR'))
    await settle()
    expect((await status()).install).toEqual({ state: 'installing', phase: 'starting' })
    releaseStart()
    await settle()
    expect((await status()).install).toEqual({ state: 'failed', errorCode: 'NETWORK_ERROR', errorDetails: {} })
    errorSpy.mockRestore()
  })

  function startRunning() {
    mocks.start.mockImplementationOnce(async () => {
      mocks.supervisorOptions!.onState({ phase: 'running', listening: true, restarts: 0 })
    })
  }

  it('removes old version directories after a successful install once the agent is running', async () => {
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.2.0' })
    startRunning()
    await post('/voice/install')
    await settle()
    expect(mocks.removeStaleVoiceVersions).not.toHaveBeenCalled()
    finishInstall()
    await settle()
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(mocks.removeStaleVoiceVersions).toHaveBeenCalledTimes(1)
  })

  it('keeps old version directories when the new agent did not come up or nothing is installed', async () => {
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.2.0' })
    mocks.start.mockImplementationOnce(async () => {
      mocks.supervisorOptions!.onState({ phase: 'restarting', listening: false, restarts: 1 })
    })
    await post('/voice/install')
    await settle()
    finishInstall()
    await settle()
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(mocks.removeStaleVoiceVersions).not.toHaveBeenCalled()

    mocks.readVoiceInstallation.mockResolvedValue(null)
    await post('/voice/install')
    await settle()
    finishInstall()
    await settle()
    expect(mocks.installVoice).toHaveBeenCalledTimes(2)
    expect(mocks.removeStaleVoiceVersions).not.toHaveBeenCalled()
  })

  it('keeps old version directories when the install fails or is cancelled', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.2.0' })
    await post('/voice/install')
    await settle()
    failInstall(installError('NETWORK_ERROR'))
    await settle()
    await post('/voice/install')
    await settle()
    await post('/voice/install/cancel')
    await settle()
    expect(mocks.removeStaleVoiceVersions).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('only logs when removing old version directories fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.2.0' })
    mocks.removeStaleVoiceVersions.mockRejectedValue(new Error('locked'))
    startRunning()
    await post('/voice/install')
    await settle()
    finishInstall()
    await settle()
    expect((await status()).install).toEqual({ state: 'idle' })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('shutdown cancels the install, waits for it and does not restart voice', async () => {
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.2.0' })
    await post('/voice/install')
    await settle()
    mocks.start.mockClear()
    await cancelInstallForShutdown()
    expect(installCall.signal.aborted).toBe(true)
    expect(mocks.start).not.toHaveBeenCalled()
    expect((await status()).install).toEqual({ state: 'idle' })
  })
})
