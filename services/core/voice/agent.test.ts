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
  supervisorOptions: null as { onEvent: (ev: unknown) => void; onState: (s: unknown) => void; listen?: boolean } | null,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  call: vi.fn(),
  setListening: vi.fn(),
  store: { listenEnabled: true },
  getVoiceListenEnabled: vi.fn(),
  setVoiceListenEnabled: vi.fn(),
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
  getVoiceListenEnabled: mocks.getVoiceListenEnabled,
  setVoiceListenEnabled: mocks.setVoiceListenEnabled,
}))
vi.mock('@mintbot/voice-agent-client', () => ({
  API_VERSION: 1,
  VoiceAgentSupervisor: class {
    constructor(options: { onEvent: (ev: unknown) => void; onState: (s: unknown) => void; listen?: boolean }) {
      mocks.supervisorOptions = options
    }
    start = mocks.start
    stop = mocks.stop
    call = mocks.call
    setListening = mocks.setListening
  },
}))

import { startVoice, stopVoice, takePending } from './agent.js'
import { voiceRoutes } from './routes.js'
import { ConfigFileUnreadableError } from '../config/configFileError.js'
import Fastify from 'fastify'

let dataDir: string

function resetListenMocks(stored: boolean) {
  mocks.store.listenEnabled = stored
  mocks.setListening.mockClear()
  mocks.getVoiceListenEnabled.mockReset()
  mocks.getVoiceListenEnabled.mockImplementation(() => mocks.store.listenEnabled)
  mocks.setVoiceListenEnabled.mockReset()
  mocks.setVoiceListenEnabled.mockImplementation((enabled: boolean) => {
    mocks.store.listenEnabled = enabled
  })
}

function lastListening(): boolean | undefined {
  return mocks.setListening.mock.calls.at(-1)?.[0]
}

function final(data: Record<string, unknown>) {
  mocks.supervisorOptions!.onEvent({ id: 1, type: 'final', data })
}

describe('voice agent', () => {
  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-voice-test-'))
    mocks.readVoiceInstallation.mockReset()
    mocks.broadcastEvent.mockReset()
    mocks.start.mockClear()
    mocks.stop.mockClear()
    mocks.supervisorOptions = null
    resetListenMocks(true)
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.1.0' })
    await startVoice(dataDir)
    takePending()
  })

  afterEach(async () => {
    await stopVoice()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('does not throw and starts nothing when the component is not installed', async () => {
    mocks.readVoiceInstallation.mockResolvedValue(null)
    mocks.supervisorOptions = null
    mocks.start.mockClear()
    await expect(startVoice(dataDir)).resolves.toBeUndefined()
    expect(mocks.supervisorOptions).toBeNull()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(takePending()).toEqual([])
  })

  it('take returns pending texts once and empties them', () => {
    final({ text: '你好', end_unix_ms: 1, language: 'zh', emotion: 'neutral' })
    final({ text: 'world', end_unix_ms: 2, language: 'en', emotion: 'neutral' })
    expect(takePending()).toEqual(['你好', 'world'])
    expect(takePending()).toEqual([])
  })

  it('discards enrolling and blank finals and non-final events', () => {
    final({ text: '录声纹', enrolling: true, end_unix_ms: 1 })
    final({ text: '   ', end_unix_ms: 2 })
    final({ end_unix_ms: 3 })
    mocks.supervisorOptions!.onEvent({ id: 2, type: 'status', data: { text: 'x' } })
    expect(takePending()).toEqual([])
    expect(mocks.broadcastEvent).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(dataDir, 'transcripts.jsonl'))).toBe(false)
  })

  it('appends a transcript line, queues the text and broadcasts', () => {
    final({ text: '你好', end_unix_ms: 42, language: 'zh', emotion: 'happy', speaker_score: 0.9, is_owner: true })
    final({ text: 'hi', end_unix_ms: 43, language: 'en', emotion: 'neutral' })
    const lines = fs.readFileSync(path.join(dataDir, 'transcripts.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toEqual([
      { at: 42, text: '你好', language: 'zh', emotion: 'happy', mode: 'normal', speaker_score: 0.9, is_owner: true },
      { at: 43, text: 'hi', language: 'en', emotion: 'neutral', mode: 'normal' },
    ])
    expect(mocks.broadcastEvent).toHaveBeenCalledTimes(2)
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-pending', {})
  })

  it('still queues and broadcasts when the transcript write fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fs.rmSync(dataDir, { recursive: true, force: true })
    final({ text: '你好', end_unix_ms: 1, language: 'zh', emotion: 'neutral' })
    expect(errorSpy).toHaveBeenCalled()
    expect(mocks.broadcastEvent).toHaveBeenCalledTimes(1)
    expect(takePending()).toEqual(['你好'])
    errorSpy.mockRestore()
  })

  it('POST /voice/take returns the pending texts and clears them', async () => {
    const app = Fastify()
    await app.register(voiceRoutes)
    final({ text: '你好', end_unix_ms: 1, language: 'zh', emotion: 'neutral' })
    const first = await app.inject({ method: 'POST', url: '/voice/take' })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ texts: ['你好'] })
    const second = await app.inject({ method: 'POST', url: '/voice/take' })
    expect(second.json()).toEqual({ texts: [] })
    await app.close()
  })

  it('stopVoice stops the supervisor', async () => {
    await stopVoice()
    expect(mocks.stop).toHaveBeenCalledTimes(1)
  })
})

describe('voice settings page', () => {
  let speaker: Record<string, unknown>
  let commitConflict: boolean
  let app: ReturnType<typeof Fastify>

  const running = { phase: 'running', listening: true, restarts: 0 }

  function setState(state: Record<string, unknown>) {
    mocks.supervisorOptions!.onState(state)
  }

  function calledPaths(): string[] {
    return mocks.call.mock.calls.map(c => `${c[0]} ${c[1]}`)
  }

  async function post(url: string) {
    return app.inject({ method: 'POST', url })
  }

  async function status() {
    return (await app.inject({ method: 'GET', url: '/voice/status' })).json()
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-voice-test-'))
    mocks.readVoiceInstallation.mockReset()
    mocks.broadcastEvent.mockReset()
    mocks.call.mockReset()
    mocks.supervisorOptions = null
    resetListenMocks(true)
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.1.0' })
    speaker = {
      enrolled: false,
      utterances: 0,
      speech_ms: 0,
      enrolling: false,
      enroll_utterances: 0,
      enroll_speech_ms: 0,
      enroll_ready: false,
    }
    commitConflict = false
    mocks.call.mockImplementation(async (_method: string, url: string) => {
      if (url === '/v1/speaker') return speaker
      if (url.endsWith('/commit') && commitConflict) throw Object.assign(new Error('conflict'), { status: 409 })
      return {}
    })
    await startVoice(dataDir)
    setState(running)
    mocks.broadcastEvent.mockClear()
    app = Fastify()
    await app.register(voiceRoutes)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await app.close()
    await stopVoice()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('reports the status structure and broadcasts on state changes', async () => {
    setState({ phase: 'running', listening: true, restarts: 0, error: { code: 'mic_access_denied', message: 'x' } })
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
    speaker = { ...speaker, enrolled: true, utterances: 6, speech_ms: 12000 }
    expect(await status()).toEqual({
      installed: true,
      version: '0.1.0',
      updateVersion: null,
      enrollInterrupted: false,
      phase: 'running',
      listening: true,
      errorCode: 'mic_access_denied',
      install: { state: 'idle' },
      speaker: {
        enrolled: true,
        utterances: 6,
        speechMs: 12000,
        enrolling: false,
        enrollUtterances: 0,
        enrollSpeechMs: 0,
        enrollReady: false,
      },
      mode: 'normal',
      listenEnabled: true,
      enroll: { completed: [], current: [] },
      test: { results: [], hasRun: false },
    })
  })

  describe('update check', () => {
    async function check() {
      const res = await app.inject({ method: 'GET', url: '/voice/update-check' })
      expect(res.statusCode).toBe(200)
      return status()
    }

    async function restartInstalled(version: string) {
      await stopVoice()
      mocks.readVoiceInstallation.mockResolvedValue({ version })
      await startVoice(dataDir)
      setState(running)
    }

    beforeEach(() => {
      mocks.resolveManifestUrl.mockReset()
      mocks.resolveManifestUrl.mockReturnValue('https://example.invalid/manifest.json')
      mocks.fetchRemoteManifestInfo.mockReset()
      mocks.installVoice.mockReset()
    })

    it.each([
      ['0.1.0', '0.2.0', 1, '0.2.0'],
      ['0.2.0', '0.10.0', 1, '0.10.0'],
      ['0.2.0', '0.2.0', 1, null],
      ['0.2.0', '0.1.9', 1, null],
      ['0.1.0', '0.2.0', 2, null],
    ])('installed %s, remote %s with api %s gives update %s', async (installed, remote, apiVersion, expected) => {
      await restartInstalled(installed)
      mocks.fetchRemoteManifestInfo.mockResolvedValue({ version: remote, apiVersion })
      const body = await check()
      expect(mocks.fetchRemoteManifestInfo).toHaveBeenCalledWith('https://example.invalid/manifest.json')
      expect(body.version).toBe(installed)
      expect(body.updateVersion).toBe(expected)
    })

    it('reports no update and logs one line when the remote manifest cannot be read, then retries on the next check', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mocks.fetchRemoteManifestInfo.mockRejectedValueOnce(new Error('offline'))
      expect((await check()).updateVersion).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      mocks.fetchRemoteManifestInfo.mockResolvedValue({ version: '0.2.0', apiVersion: 1 })
      expect((await check()).updateVersion).toBe('0.2.0')
      errorSpy.mockRestore()
    })

    it('caches a successful result for 10 minutes', async () => {
      vi.useFakeTimers()
      mocks.fetchRemoteManifestInfo.mockResolvedValue({ version: '0.2.0', apiVersion: 1 })
      await check()
      await check()
      expect(mocks.fetchRemoteManifestInfo).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      await check()
      expect(mocks.fetchRemoteManifestInfo).toHaveBeenCalledTimes(2)
    })

    it('does not fetch when the component is not installed or no manifest address is configured', async () => {
      mocks.resolveManifestUrl.mockReturnValue(null)
      expect((await check()).updateVersion).toBeNull()
      await stopVoice()
      mocks.readVoiceInstallation.mockResolvedValue(null)
      await startVoice(dataDir)
      mocks.resolveManifestUrl.mockReturnValue('https://example.invalid/manifest.json')
      expect((await check()).updateVersion).toBeNull()
      expect(mocks.fetchRemoteManifestInfo).not.toHaveBeenCalled()
    })

    it('an update is rejected with VOICE_BUSY while enrolling or testing', async () => {
      mocks.fetchRemoteManifestInfo.mockResolvedValue({ version: '0.2.0', apiVersion: 1 })
      await check()
      await post('/voice/enroll/start')
      const whileEnrolling = await post('/voice/install')
      expect(whileEnrolling.statusCode).toBe(409)
      expect(whileEnrolling.json()).toEqual({ code: 'VOICE_BUSY' })
      await post('/voice/enroll/cancel')
      await post('/voice/test/start')
      expect((await post('/voice/install')).statusCode).toBe(409)
      expect(mocks.installVoice).not.toHaveBeenCalled()
    })
  })

  it('reports speaker null when the agent is not running or the read fails', async () => {
    mocks.call.mockRejectedValue(new Error('down'))
    expect((await status()).speaker).toBeNull()
    setState({ phase: 'restarting', listening: false, restarts: 1 })
    mocks.call.mockClear()
    const body = await status()
    expect(body.speaker).toBeNull()
    expect(body.phase).toBe('restarting')
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('returns a normal status and 503 for every operation when not installed', async () => {
    await stopVoice()
    mocks.readVoiceInstallation.mockResolvedValue(null)
    await startVoice(dataDir)
    expect(await status()).toEqual({
      installed: false,
      version: null,
      updateVersion: null,
      enrollInterrupted: false,
      phase: null,
      listening: false,
      errorCode: null,
      install: { state: 'idle' },
      speaker: null,
      mode: 'normal',
      listenEnabled: false,
      enroll: { completed: [], current: [] },
      test: { results: [], hasRun: false },
    })
    for (const url of ['/voice/enroll/start', '/voice/enroll/commit', '/voice/enroll/cancel', '/voice/test/start', '/voice/test/stop']) {
      const res = await post(url)
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ code: 'VOICE_UNAVAILABLE' })
    }
  })

  it('returns 503 for operations while the agent is not running', async () => {
    setState({ phase: 'restarting', listening: false, restarts: 1 })
    expect((await post('/voice/enroll/start')).statusCode).toBe(503)
    expect((await post('/voice/test/start')).statusCode).toBe(503)
  })

  it('enroll start forwards to the agent and enters enrolling mode', async () => {
    const res = await post('/voice/enroll/start')
    expect(res.statusCode).toBe(200)
    expect(calledPaths()).toContain('POST /v1/speaker/enroll/start')
    expect((await status()).mode).toBe('enrolling')
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
  })

  it('enroll start is allowed when already enrolled', async () => {
    speaker = { ...speaker, enrolled: true }
    const res = await post('/voice/enroll/start')
    expect(res.statusCode).toBe(200)
    expect(calledPaths()).toContain('POST /v1/speaker/enroll/start')
    expect((await status()).mode).toBe('enrolling')
  })

  describe('enrollment sentence lists', () => {
    function enrolling(text: string, startMs: number, endMs: number) {
      final({ text, enrolling: true, start_ms: startMs, end_ms: endMs })
    }

    async function lists() {
      return (await status()).enroll
    }

    async function commitOne(text: string, durationMs: number) {
      await post('/voice/enroll/start')
      enrolling(text, 0, durationMs)
      speaker = { ...speaker, enrolling: true, enroll_utterances: 5, enroll_ready: true }
      await post('/voice/enroll/commit')
    }

    it('appends enrolling sentences to the current list and notifies', async () => {
      await post('/voice/enroll/start')
      expect(await lists()).toEqual({ completed: [], current: [] })
      mocks.broadcastEvent.mockClear()
      enrolling('第一句', 1000, 6500)
      expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
      enrolling('   ', 0, 100)
      enrolling('第二句', 7000, 9000)
      expect(await lists()).toEqual({
        completed: [],
        current: [
          { text: '第一句', durationMs: 5500 },
          { text: '第二句', durationMs: 2000 },
        ],
      })
      expect(takePending()).toEqual([])
      expect(fs.existsSync(path.join(dataDir, 'transcripts.jsonl'))).toBe(false)
    })

    it('commit moves the current list to completed and a new start keeps completed', async () => {
      await commitOne('甲', 1000)
      expect(await lists()).toEqual({ completed: [{ text: '甲', durationMs: 1000 }], current: [] })
      await post('/voice/enroll/start')
      expect(await lists()).toEqual({ completed: [{ text: '甲', durationMs: 1000 }], current: [] })
      enrolling('乙', 0, 2000)
      expect(await lists()).toEqual({
        completed: [{ text: '甲', durationMs: 1000 }],
        current: [{ text: '乙', durationMs: 2000 }],
      })
    })

    it('cancel discards the current list and keeps completed', async () => {
      await commitOne('甲', 1000)
      await post('/voice/enroll/start')
      enrolling('乙', 0, 2000)
      await post('/voice/enroll/cancel')
      expect(await lists()).toEqual({ completed: [{ text: '甲', durationMs: 1000 }], current: [] })
      enrolling('迟到', 0, 500)
      expect((await lists()).current).toEqual([])
    })

    it('a timeout and the agent leaving running discard the current list', async () => {
      vi.useFakeTimers()
      await post('/voice/enroll/start')
      enrolling('甲', 0, 1000)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect((await lists()).current).toEqual([])
      await post('/voice/enroll/start')
      enrolling('乙', 0, 1000)
      setState({ phase: 'restarting', listening: false, restarts: 1 })
      expect((await lists()).current).toEqual([])
    })

    it('delete speaker clears both lists', async () => {
      await commitOne('甲', 1000)
      await post('/voice/enroll/start')
      enrolling('乙', 0, 2000)
      expect(await lists()).toEqual({
        completed: [{ text: '甲', durationMs: 1000 }],
        current: [{ text: '乙', durationMs: 2000 }],
      })
      await post('/voice/enroll/cancel')
      await commitOne('丙', 3000)
      await post('/voice/enroll/start')
      enrolling('丁', 0, 1000)
      await post('/voice/enroll/cancel')
      expect((await app.inject({ method: 'DELETE', url: '/voice/speaker' })).statusCode).toBe(200)
      expect(await lists()).toEqual({ completed: [], current: [] })
    })

    describe('late sentences by round', () => {
      const T0 = new Date('2026-01-01T00:00:00Z').getTime()

      function lateEnrolling(text: string, startOffsetMs: number, endOffsetMs: number) {
        final({ text, enrolling: true, start_ms: 0, end_ms: endOffsetMs - startOffsetMs, end_unix_ms: T0 + endOffsetMs })
      }

      beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(T0)
      })

      it('a sentence of the committed round that arrives after commit joins completed', async () => {
        await post('/voice/enroll/start')
        lateEnrolling('甲', 100, 1000)
        speaker = { ...speaker, enrolling: true, enroll_utterances: 5, enroll_ready: true }
        vi.setSystemTime(T0 + 5000)
        await post('/voice/enroll/commit')
        lateEnrolling('乙', 3000, 4000)
        expect(await lists()).toEqual({
          completed: [
            { text: '甲', durationMs: 900 },
            { text: '乙', durationMs: 1000 },
          ],
          current: [],
        })
      })

      it('a late sentence of a cancelled round does not enter the next round', async () => {
        await post('/voice/enroll/start')
        vi.setSystemTime(T0 + 1000)
        await post('/voice/enroll/cancel')
        vi.setSystemTime(T0 + 2000)
        await post('/voice/enroll/start')
        lateEnrolling('迟到', 500, 900)
        expect(await lists()).toEqual({ completed: [], current: [] })
      })

      it('a late sentence of the committed round after delete speaker is discarded', async () => {
        await post('/voice/enroll/start')
        speaker = { ...speaker, enrolling: true, enroll_utterances: 5, enroll_ready: true }
        vi.setSystemTime(T0 + 5000)
        await post('/voice/enroll/commit')
        expect((await app.inject({ method: 'DELETE', url: '/voice/speaker' })).statusCode).toBe(200)
        lateEnrolling('迟到', 3000, 4000)
        expect(await lists()).toEqual({ completed: [], current: [] })
      })
    })

    it('a restart clears both lists', async () => {
      await commitOne('甲', 1000)
      await post('/voice/enroll/start')
      enrolling('乙', 0, 2000)
      await stopVoice()
      await startVoice(dataDir)
      setState(running)
      expect(await lists()).toEqual({ completed: [], current: [] })
    })
  })

  describe('delete speaker', () => {
    function del() {
      return app.inject({ method: 'DELETE', url: '/voice/speaker' })
    }

    it('forwards DELETE to the agent and notifies', async () => {
      const res = await del()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
      expect(calledPaths()).toContain('DELETE /v1/speaker')
      expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
    })

    it('is 409 VOICE_BUSY while enrolling or testing and does not call the agent', async () => {
      await post('/voice/enroll/start')
      const whileEnrolling = await del()
      expect(whileEnrolling.statusCode).toBe(409)
      expect(whileEnrolling.json()).toEqual({ code: 'VOICE_BUSY' })
      await post('/voice/enroll/cancel')
      await post('/voice/test/start')
      expect((await del()).statusCode).toBe(409)
      expect(calledPaths()).not.toContain('DELETE /v1/speaker')
    })

    it('is 503 VOICE_UNAVAILABLE when the agent call fails or the agent is not running', async () => {
      mocks.call.mockImplementation(async (method: string) => {
        if (method === 'DELETE') throw new Error('down')
        return {}
      })
      const failed = await del()
      expect(failed.statusCode).toBe(503)
      expect(failed.json()).toEqual({ code: 'VOICE_UNAVAILABLE' })
      setState({ phase: 'restarting', listening: false, restarts: 1 })
      expect((await del()).statusCode).toBe(503)
    })
  })

  describe('test rounds', () => {
    const T0 = new Date('2026-01-01T00:00:00Z').getTime()

    function at(offsetMs: number) {
      vi.setSystemTime(T0 + offsetMs)
    }

    function timed(text: string, startOffsetMs: number, endOffsetMs: number) {
      final({ text, start_ms: 0, end_ms: endOffsetMs - startOffsetMs, end_unix_ms: T0 + endOffsetMs, speaker_enrolled: false })
    }

    function other(startOffsetMs: number, endOffsetMs: number) {
      mocks.supervisorOptions!.onEvent({
        id: 1,
        type: 'speech_other',
        data: { start_ms: 0, end_ms: endOffsetMs - startOffsetMs, end_unix_ms: T0 + endOffsetMs },
      })
    }

    function records(): Array<Record<string, unknown>> {
      const file = path.join(dataDir, 'transcripts.jsonl')
      if (!fs.existsSync(file)) return []
      return fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    }

    beforeEach(() => {
      vi.useFakeTimers()
      at(0)
    })

    it('a late result from the previous test does not enter the new test but is still recorded', async () => {
      at(1000)
      await post('/voice/test/start')
      at(5000)
      await post('/voice/test/stop')
      at(6000)
      await post('/voice/test/start')
      at(7000)
      timed('上一次测试说的', 2000, 4000)
      other(2500, 3500)
      expect((await status()).test.results).toEqual([])
      expect(records().map(r => r.mode)).toEqual(['testing'])
      timed('这一次测试说的', 6200, 6800)
      expect((await status()).test.results).toHaveLength(1)
      expect(records().map(r => r.mode)).toEqual(['testing', 'testing'])
    })

    it('a result arriving after clear is not listed but is still recorded', async () => {
      at(1000)
      await post('/voice/test/start')
      at(5000)
      await post('/voice/test/stop')
      at(6000)
      expect((await post('/voice/test/clear')).statusCode).toBe(200)
      at(7000)
      timed('清空后才到', 2000, 4000)
      other(2500, 3500)
      expect((await status()).test.results).toEqual([])
      expect(records().map(r => r.mode)).toEqual(['testing'])
    })

    it('clear is 409 while testing and empties results otherwise', async () => {
      await post('/voice/test/start')
      final({ text: 'a', start_ms: 0, end_ms: 1000, speaker_enrolled: false })
      const busy = await post('/voice/test/clear')
      expect(busy.statusCode).toBe(409)
      expect(busy.json()).toEqual({ code: 'VOICE_BUSY' })
      expect((await status()).test.results).toHaveLength(1)
      await post('/voice/test/stop')
      mocks.broadcastEvent.mockClear()
      expect((await post('/voice/test/clear')).statusCode).toBe(200)
      expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
      expect((await status()).test.results).toEqual([])
    })

    it('hasRun turns true on start, survives stop and clear, and resets on restart', async () => {
      expect((await status()).test.hasRun).toBe(false)
      await post('/voice/test/start')
      expect((await status()).test.hasRun).toBe(true)
      await post('/voice/test/stop')
      await post('/voice/test/clear')
      expect((await status()).test.hasRun).toBe(true)
      await stopVoice()
      await startVoice(dataDir)
      setState(running)
      expect((await status()).test.hasRun).toBe(false)
    })
  })

  it('enroll commit is rejected below 5 utterances and when the agent reports 409', async () => {
    await post('/voice/enroll/start')
    speaker = { ...speaker, enrolling: true, enroll_utterances: 4, enroll_ready: true }
    const tooFew = await post('/voice/enroll/commit')
    expect(tooFew.statusCode).toBe(409)
    expect(tooFew.json()).toEqual({ code: 'VOICE_ENROLL_NOT_READY' })
    expect(calledPaths()).not.toContain('POST /v1/speaker/enroll/commit')

    speaker = { ...speaker, enroll_utterances: 5, enroll_ready: false }
    commitConflict = true
    const notReady = await post('/voice/enroll/commit')
    expect(notReady.statusCode).toBe(409)
    expect((await status()).mode).toBe('enrolling')
  })

  it('enroll commit succeeds with 5 utterances and returns to normal', async () => {
    await post('/voice/enroll/start')
    speaker = { ...speaker, enrolling: true, enroll_utterances: 5, enroll_speech_ms: 11000, enroll_ready: true }
    const res = await post('/voice/enroll/commit')
    expect(res.statusCode).toBe(200)
    expect(calledPaths()).toContain('POST /v1/speaker/enroll/commit')
    expect((await status()).mode).toBe('normal')
  })

  it('enroll commit without an enrollment in progress is 409', async () => {
    const res = await post('/voice/enroll/commit')
    expect(res.statusCode).toBe(409)
  })

  it('enroll cancel forwards to the agent and returns to normal', async () => {
    await post('/voice/enroll/start')
    const res = await post('/voice/enroll/cancel')
    expect(res.statusCode).toBe(200)
    expect(calledPaths()).toContain('POST /v1/speaker/enroll/cancel')
    expect((await status()).mode).toBe('normal')
  })

  it('enrolling and testing are mutually exclusive', async () => {
    await post('/voice/enroll/start')
    const testWhileEnrolling = await post('/voice/test/start')
    expect(testWhileEnrolling.statusCode).toBe(409)
    expect(testWhileEnrolling.json()).toEqual({ code: 'VOICE_BUSY' })
    await post('/voice/enroll/cancel')
    expect((await post('/voice/test/start')).statusCode).toBe(200)
    const enrollWhileTesting = await post('/voice/enroll/start')
    expect(enrollWhileTesting.statusCode).toBe(409)
    expect(enrollWhileTesting.json()).toEqual({ code: 'VOICE_BUSY' })
    expect((await post('/voice/test/start')).statusCode).toBe(409)
  })

  it('auto-cancels an enrollment after 10 minutes', async () => {
    vi.useFakeTimers()
    await post('/voice/enroll/start')
    mocks.broadcastEvent.mockClear()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(calledPaths()).toContain('POST /v1/speaker/enroll/cancel')
    expect((await status()).mode).toBe('normal')
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
  })

  it('auto-stops a test after 10 minutes and keeps its results', async () => {
    vi.useFakeTimers()
    await post('/voice/test/start')
    mocks.supervisorOptions!.onEvent({ id: 1, type: 'speech_other', data: { start_ms: 0, end_ms: 500 } })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    const body = await status()
    expect(body.mode).toBe('normal')
    expect(body.test.results).toHaveLength(1)
  })

  it('does not fire the timeout after commit or stop and tolerates a lost enrollment', async () => {
    vi.useFakeTimers()
    await post('/voice/enroll/start')
    speaker = { ...speaker, enrolling: true, enroll_utterances: 5, enroll_ready: true }
    await post('/voice/enroll/commit')
    mocks.call.mockClear()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(mocks.call).not.toHaveBeenCalled()

    await post('/voice/test/start')
    await post('/voice/test/stop')
    mocks.broadcastEvent.mockClear()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(mocks.broadcastEvent).not.toHaveBeenCalled()

    speaker = { ...speaker, enrolled: false, enrolling: false }
    await post('/voice/enroll/start')
    setState({ phase: 'restarting', listening: false, restarts: 1 })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect((await status()).mode).toBe('normal')
  })

  it('leaves enrolling mode when the agent stops running, so later speech is queued normally', async () => {
    vi.useFakeTimers()
    await post('/voice/enroll/start')
    mocks.broadcastEvent.mockClear()
    setState({ phase: 'restarting', listening: false, restarts: 1 })
    expect(mocks.broadcastEvent).toHaveBeenCalledTimes(1)
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
    expect((await status()).mode).toBe('normal')
    final({ text: '你好', start_ms: 0, end_ms: 1000, end_unix_ms: 7 })
    expect(takePending()).toEqual(['你好'])
    mocks.call.mockClear()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('in testing mode a final is recorded and listed but never queued', async () => {
    await post('/voice/test/start')
    mocks.broadcastEvent.mockClear()
    final({ text: '你好', start_ms: 1000, end_ms: 2500, end_unix_ms: Date.now() + 2000, language: 'zh', emotion: 'neutral', speaker_enrolled: true, is_owner: true, speaker_score: 0.81, speaker_uncertain: true })
    expect(takePending()).toEqual([])
    expect(mocks.broadcastEvent).not.toHaveBeenCalledWith('voice-pending', {})
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
    const lines = fs.readFileSync(path.join(dataDir, 'transcripts.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect((await status()).test.results).toEqual([
      { kind: 'owner', score: 0.81, uncertain: true, durationMs: 1500, text: '你好' },
    ])
  })

  it('classifies a transcribed final as owner when enrolled, unenrolled otherwise', async () => {
    await post('/voice/test/start')
    final({ text: 'a', start_ms: 0, end_ms: 1000, speaker_enrolled: true, is_owner: true, speaker_score: 0.9 })
    final({ text: 'b', start_ms: 0, end_ms: 500, speaker_enrolled: true, is_owner: false, speaker_uncertain: true, speaker_score: 0.426, speaker_threshold: 0.5 })
    final({ text: 'c', start_ms: 0, end_ms: 1000, speaker_enrolled: false })
    final({ text: 'd', start_ms: 0, end_ms: 1000, speaker_enrolled: true })
    const results = (await status()).test.results
    expect(results.map((r: { kind: string }) => r.kind)).toEqual(['owner', 'owner', 'unenrolled', 'owner'])
    expect(results[1]).toEqual({ kind: 'owner', score: 0.426, threshold: 0.5, uncertain: true, durationMs: 500, text: 'b' })
    expect(results[2]).toEqual({ kind: 'unenrolled', uncertain: false, durationMs: 1000, text: 'c' })
  })

  it('speech_other is listed only while testing', async () => {
    mocks.supervisorOptions!.onEvent({ id: 1, type: 'speech_other', data: { start_ms: 0, end_ms: 400, speaker_score: 0.1 } })
    expect((await status()).test.results).toEqual([])
    await post('/voice/test/start')
    mocks.supervisorOptions!.onEvent({ id: 2, type: 'speech_other', data: { start_ms: 100, end_ms: 900, speaker_score: 0.12, speaker_threshold: 0.5, speaker_uncertain: true } })
    expect((await status()).test.results).toEqual([
      { kind: 'other', score: 0.12, threshold: 0.5, uncertain: true, durationMs: 800 },
    ])
  })

  it('keeps results after stop and clears them on the next start', async () => {
    await post('/voice/test/start')
    final({ text: 'a', start_ms: 0, end_ms: 1000, speaker_enrolled: false })
    await post('/voice/test/stop')
    expect((await status()).test.results).toHaveLength(1)
    await post('/voice/test/start')
    expect((await status()).test.results).toEqual([])
  })

  it('enrolling finals stay discarded and agent progress events broadcast a status change', async () => {
    await post('/voice/test/start')
    mocks.broadcastEvent.mockClear()
    final({ text: '录声纹', enrolling: true, start_ms: 0, end_ms: 1000 })
    expect((await status()).test.results).toEqual([])
    mocks.supervisorOptions!.onEvent({ id: 3, type: 'enroll_progress', data: {} })
    mocks.supervisorOptions!.onEvent({ id: 4, type: 'speaker', data: {} })
    expect(mocks.broadcastEvent).toHaveBeenCalledTimes(2)
  })
})

describe('voice input toggle', () => {
  let speaker: Record<string, unknown>
  let app: ReturnType<typeof Fastify>
  let hold: { speaker: Promise<void> | null; start: Promise<void> | null }
  let entered: { speaker: (() => void) | null; start: (() => void) | null }

  const running = { phase: 'running', listening: true, restarts: 0 }

  function setState(state: Record<string, unknown>) {
    mocks.supervisorOptions!.onState(state)
  }

  function calledPaths(): string[] {
    return mocks.call.mock.calls.map(c => `${c[0]} ${c[1]}`)
  }

  function post(url: string, payload?: unknown) {
    return app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> | undefined })
  }

  async function status() {
    return (await app.inject({ method: 'GET', url: '/voice/status' })).json()
  }

  async function expectNoModeTimer() {
    mocks.call.mockClear()
    mocks.broadcastEvent.mockClear()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.broadcastEvent).not.toHaveBeenCalled()
  }

  function deferred() {
    let release!: () => void
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    return { promise, release }
  }

  async function begin(stored: boolean) {
    mocks.store.listenEnabled = stored
    await startVoice(dataDir)
    setState(running)
    mocks.setListening.mockClear()
    mocks.broadcastEvent.mockClear()
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-voice-test-'))
    mocks.readVoiceInstallation.mockReset()
    mocks.broadcastEvent.mockReset()
    mocks.call.mockReset()
    mocks.supervisorOptions = null
    resetListenMocks(false)
    mocks.readVoiceInstallation.mockResolvedValue({ version: '0.1.0' })
    speaker = {
      enrolled: false,
      utterances: 0,
      speech_ms: 0,
      enrolling: false,
      enroll_utterances: 0,
      enroll_speech_ms: 0,
      enroll_ready: false,
    }
    hold = { speaker: null, start: null }
    entered = { speaker: null, start: null }
    mocks.call.mockImplementation(async (_method: string, url: string) => {
      if (url === '/v1/speaker') {
        entered.speaker?.()
        if (hold.speaker) await hold.speaker
        return speaker
      }
      if (url === '/v1/speaker/enroll/start') {
        entered.start?.()
        if (hold.start) await hold.start
        return {}
      }
      return {}
    })
    app = Fastify()
    await app.register(voiceRoutes)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await app.close()
    await stopVoice()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('defaults to off, passes the stored value to the supervisor and reports it in status', async () => {
    await begin(false)
    expect(mocks.supervisorOptions!.listen).toBe(false)
    expect((await status()).listenEnabled).toBe(false)
    await stopVoice()
    await begin(true)
    expect(mocks.supervisorOptions!.listen).toBe(true)
    expect((await status()).listenEnabled).toBe(true)
  })

  it('POST /voice/listen persists the value, updates the supervisor and returns the status', async () => {
    await begin(false)
    const res = await post('/voice/listen', { enabled: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().listenEnabled).toBe(true)
    expect(mocks.setVoiceListenEnabled).toHaveBeenCalledWith(true)
    expect(lastListening()).toBe(true)
    expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
    await post('/voice/listen', { enabled: false })
    expect(mocks.setVoiceListenEnabled).toHaveBeenLastCalledWith(false)
    expect(lastListening()).toBe(false)
    expect((await status()).listenEnabled).toBe(false)
  })

  it('POST /voice/listen rejects a bad body, a missing component and a busy mode', async () => {
    await begin(false)
    for (const payload of [undefined, {}, { enabled: 'yes' }, { enabled: 1 }]) {
      const res = await post('/voice/listen', payload)
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('INVALID_REQUEST')
    }
    expect(mocks.setVoiceListenEnabled).not.toHaveBeenCalled()

    await post('/voice/enroll/start')
    const whileEnrolling = await post('/voice/listen', { enabled: true })
    expect(whileEnrolling.statusCode).toBe(409)
    expect(whileEnrolling.json()).toEqual({ code: 'VOICE_BUSY' })
    await post('/voice/enroll/cancel')
    await post('/voice/test/start')
    expect((await post('/voice/listen', { enabled: true })).statusCode).toBe(409)
    expect(mocks.setVoiceListenEnabled).not.toHaveBeenCalled()

    await stopVoice()
    mocks.readVoiceInstallation.mockResolvedValue(null)
    await startVoice(dataDir)
    const missing = await post('/voice/listen', { enabled: true })
    expect(missing.statusCode).toBe(503)
    expect(missing.json()).toEqual({ code: 'VOICE_UNAVAILABLE' })
  })

  it('POST /voice/listen is accepted while the agent is restarting and reports an unreadable config as 500', async () => {
    await begin(false)
    setState({ phase: 'restarting', listening: false, restarts: 1 })
    expect((await post('/voice/listen', { enabled: true })).statusCode).toBe(200)
    expect(lastListening()).toBe(true)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.setVoiceListenEnabled.mockImplementation(() => {
      throw new ConfigFileUnreadableError('bad')
    })
    const res = await post('/voice/listen', { enabled: false })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ code: 'CONFIG_FILE_UNREADABLE' })
    expect((await status()).listenEnabled).toBe(true)
    errorSpy.mockRestore()
  })

  it('enrolling and testing force listening on and restore the switch value when they end', async () => {
    vi.useFakeTimers()
    await begin(false)

    await post('/voice/enroll/start')
    expect(lastListening()).toBe(true)
    speaker = { ...speaker, enrolling: true, enroll_utterances: 5, enroll_ready: true }
    await post('/voice/enroll/commit')
    expect(lastListening()).toBe(false)

    await post('/voice/enroll/start')
    expect(lastListening()).toBe(true)
    await post('/voice/enroll/cancel')
    expect(lastListening()).toBe(false)

    await post('/voice/test/start')
    expect(lastListening()).toBe(true)
    await post('/voice/test/stop')
    expect(lastListening()).toBe(false)

    await post('/voice/test/start')
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect((await status()).mode).toBe('normal')
    expect(lastListening()).toBe(false)

    await post('/voice/enroll/start')
    expect(lastListening()).toBe(true)
    setState({ phase: 'restarting', listening: false, restarts: 1 })
    expect(lastListening()).toBe(false)
    await expectNoModeTimer()
  })

  it('restores listening to true after a mode ends when the switch is on', async () => {
    await begin(true)
    await post('/voice/test/start')
    await post('/voice/test/stop')
    expect(lastListening()).toBe(true)
  })

  it('a final in normal mode is recorded but not queued while the switch is off', async () => {
    await begin(false)
    final({ text: '你好', end_unix_ms: 5, language: 'zh', emotion: 'neutral' })
    expect(takePending()).toEqual([])
    expect(mocks.broadcastEvent).not.toHaveBeenCalledWith('voice-pending', {})
    const lines = fs.readFileSync(path.join(dataDir, 'transcripts.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    await post('/voice/listen', { enabled: true })
    final({ text: 'hi', end_unix_ms: 6, language: 'en', emotion: 'neutral' })
    expect(takePending()).toEqual(['hi'])
  })

  it('a non-enrolling final during enrollment is neither recorded nor queued', async () => {
    await begin(true)
    await post('/voice/enroll/start')
    final({ text: '你好', end_unix_ms: 5, language: 'zh', emotion: 'neutral' })
    expect(takePending()).toEqual([])
    expect(fs.existsSync(path.join(dataDir, 'transcripts.jsonl'))).toBe(false)
  })

  describe('mode ownership by speech start time', () => {
    const T0 = new Date('2026-01-01T00:00:00Z').getTime()

    function at(offsetMs: number) {
      vi.setSystemTime(T0 + offsetMs)
    }

    function timed(text: string, startOffsetMs: number, endOffsetMs: number, extra: Record<string, unknown> = {}) {
      final({ text, start_ms: 0, end_ms: endOffsetMs - startOffsetMs, end_unix_ms: T0 + endOffsetMs, ...extra })
    }

    function records(): Array<Record<string, unknown>> {
      const file = path.join(dataDir, 'transcripts.jsonl')
      if (!fs.existsSync(file)) return []
      return fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    }

    beforeEach(async () => {
      vi.useFakeTimers()
      at(0)
      await begin(true)
    })

    it('a final spoken during a test but arriving after it is listed as testing and never queued', async () => {
      at(1000)
      await post('/voice/test/start')
      at(5000)
      await post('/voice/test/stop')
      at(6000)
      timed('测试中说的', 2000, 4000, { speaker_enrolled: false })
      expect(takePending()).toEqual([])
      expect(records().map(r => r.mode)).toEqual(['testing'])
      expect((await status()).test.results).toHaveLength(1)
    })

    it('a final spoken before a test but arriving after it starts is queued as normal and not listed', async () => {
      at(1000)
      await post('/voice/test/start')
      at(2000)
      timed('测试前说的', 100, 900)
      expect(takePending()).toEqual(['测试前说的'])
      expect(records().map(r => r.mode)).toEqual(['normal'])
      expect((await status()).test.results).toEqual([])
    })

    it('a non-enrolling final spoken during enrollment but arriving after it is dropped entirely', async () => {
      at(1000)
      await post('/voice/enroll/start')
      at(5000)
      await post('/voice/enroll/cancel')
      at(6000)
      timed('录入中说的', 2000, 4000)
      expect(takePending()).toEqual([])
      expect(records()).toEqual([])
    })

    it('a speech_other spoken during a test but arriving after it is still listed', async () => {
      at(1000)
      await post('/voice/test/start')
      at(5000)
      await post('/voice/test/stop')
      at(6000)
      mocks.supervisorOptions!.onEvent({ id: 1, type: 'speech_other', data: { start_ms: 0, end_ms: 800, end_unix_ms: T0 + 4000 } })
      expect((await status()).test.results).toHaveLength(1)
    })

    it('falls back to the current mode when timing fields are missing', async () => {
      final({ text: 'a', end_unix_ms: T0 })
      expect(takePending()).toEqual(['a'])
      await post('/voice/test/start')
      final({ text: 'b', start_ms: 0, end_ms: 100 })
      expect(takePending()).toEqual([])
      expect(records().map(r => r.mode)).toEqual(['normal', 'testing'])
    })

    it('keeps at most 8 mode changes and attributes by the retained ones', async () => {
      for (let i = 0; i < 10; i++) {
        at(1000 * (i + 1))
        await post('/voice/test/start')
        at(1000 * (i + 1) + 500)
        await post('/voice/test/stop')
      }
      at(30000)
      timed('old', 1200, 1400)
      expect(records().map(r => r.mode)).toEqual(['normal'])
    })
  })

  it('enroll start occupies enrolling before the speaker read finishes', async () => {
    vi.useFakeTimers()
    await begin(false)
    const gate = deferred()
    hold.speaker = gate.promise
    const reading = new Promise<void>(resolve => {
      entered.speaker = resolve
    })
    const pendingStart = post('/voice/enroll/start')
    await reading
    hold.speaker = null
    expect(lastListening()).toBe(true)
    expect((await status()).mode).toBe('enrolling')
    expect((await post('/voice/test/start')).statusCode).toBe(409)
    gate.release()
    expect((await pendingStart).statusCode).toBe(200)
    expect(calledPaths()).toContain('POST /v1/speaker/enroll/start')
  })

  it('cancelling while the speaker is being read ends in normal without starting the agent enrollment', async () => {
    vi.useFakeTimers()
    await begin(false)
    const gate = deferred()
    hold.speaker = gate.promise
    const reading = new Promise<void>(resolve => {
      entered.speaker = resolve
    })
    const pendingStart = post('/voice/enroll/start')
    await reading
    expect((await post('/voice/enroll/cancel')).statusCode).toBe(200)
    gate.release()
    expect((await pendingStart).statusCode).toBe(200)
    expect(calledPaths()).not.toContain('POST /v1/speaker/enroll/start')
    expect((await status()).mode).toBe('normal')
    expect(lastListening()).toBe(false)
    await expectNoModeTimer()
  })

  it('cancelling while the agent enrollment starts sends a second agent cancel and leaves no timer', async () => {
    vi.useFakeTimers()
    await begin(false)
    const gate = deferred()
    hold.start = gate.promise
    const starting = new Promise<void>(resolve => {
      entered.start = resolve
    })
    const pendingStart = post('/voice/enroll/start')
    await starting
    expect((await post('/voice/enroll/cancel')).statusCode).toBe(200)
    expect(calledPaths().filter(p => p === 'POST /v1/speaker/enroll/cancel')).toHaveLength(1)
    gate.release()
    expect((await pendingStart).statusCode).toBe(200)
    expect(calledPaths().filter(p => p === 'POST /v1/speaker/enroll/cancel')).toHaveLength(2)
    expect((await status()).mode).toBe('normal')
    expect(lastListening()).toBe(false)
    await expectNoModeTimer()
  })

  it('a failed speaker read releases the occupied mode', async () => {
    vi.useFakeTimers()
    await begin(false)
    mocks.call.mockImplementationOnce(async () => {
      throw new Error('down')
    })
    const unreadable = await post('/voice/enroll/start')
    expect(unreadable.statusCode).toBe(503)
    expect((await status()).mode).toBe('normal')
    expect(lastListening()).toBe(false)

    await expectNoModeTimer()
  })

  it('a failed agent enrollment start releases the occupied mode', async () => {
    vi.useFakeTimers()
    await begin(false)
    mocks.call.mockImplementation(async (_method: string, url: string) => {
      if (url === '/v1/speaker') return speaker
      throw Object.assign(new Error('conflict'), { status: 409 })
    })
    const res = await post('/voice/enroll/start')
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'VOICE_BUSY' })
    expect((await status()).mode).toBe('normal')
    expect(lastListening()).toBe(false)
    await expectNoModeTimer()
  })

  it('cancel tolerates the agent answering 409 when no enrollment is active', async () => {
    await begin(false)
    mocks.call.mockImplementation(async () => {
      throw Object.assign(new Error('conflict'), { status: 409 })
    })
    expect((await post('/voice/enroll/cancel')).statusCode).toBe(200)
  })

  describe('enrollment interrupted by a device change', () => {
    function deviceChanged(code = 'device_changed') {
      mocks.supervisorOptions!.onEvent({ id: 9, type: 'enroll_failed', data: { code, message: 'm', display_name: 'Mic' } })
    }

    function speakerReads(): number {
      return mocks.call.mock.calls.filter(c => c[1] === '/v1/speaker').length
    }

    async function enrollThenInterrupt() {
      await post('/voice/enroll/start')
      const readsBefore = speakerReads()
      deviceChanged()
      await vi.waitFor(() => expect(speakerReads()).toBeGreaterThan(readsBefore))
    }

    it('ends enrollment, restores listening, sets the flag and keeps an unchanged voiceprint silently', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await begin(false)
      speaker = { ...speaker, enrolled: true, utterances: 6 }
      await post('/voice/enroll/start')
      expect(lastListening()).toBe(true)
      const readsBefore = speakerReads()
      mocks.broadcastEvent.mockClear()
      deviceChanged()
      await vi.waitFor(() => expect(speakerReads()).toBeGreaterThan(readsBefore))
      const body = await status()
      expect(body.mode).toBe('normal')
      expect(body.enrollInterrupted).toBe(true)
      expect(body.enroll.current).toEqual([])
      expect(lastListening()).toBe(false)
      expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
      expect(errorSpy).not.toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('logs an error when the voiceprint is gone or changed afterwards', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await begin(false)
      speaker = { ...speaker, enrolled: true, utterances: 6 }
      await post('/voice/enroll/start')
      speaker = { ...speaker, enrolled: false, utterances: 0 }
      deviceChanged()
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1))
      errorSpy.mockRestore()
    })

    it('ignores other failure codes and device_changed outside enrollment', async () => {
      await begin(false)
      deviceChanged()
      expect((await status()).enrollInterrupted).toBe(false)
      await post('/voice/enroll/start')
      deviceChanged('other')
      const body = await status()
      expect(body.mode).toBe('enrolling')
      expect(body.enrollInterrupted).toBe(false)
    })

    it('is cleared by the next enrollment start and by deleting the speaker', async () => {
      await begin(false)
      await enrollThenInterrupt()
      expect((await status()).enrollInterrupted).toBe(true)
      await post('/voice/enroll/start')
      expect((await status()).enrollInterrupted).toBe(false)
      await enrollThenInterrupt()
      expect((await status()).enrollInterrupted).toBe(true)
      expect((await app.inject({ method: 'DELETE', url: '/voice/speaker' })).statusCode).toBe(200)
      expect((await status()).enrollInterrupted).toBe(false)
    })

    it('dismiss-interrupted clears the flag, notifies, and is a quiet no-op when it is not set', async () => {
      await begin(false)
      await enrollThenInterrupt()
      mocks.broadcastEvent.mockClear()
      expect((await post('/voice/enroll/dismiss-interrupted')).statusCode).toBe(200)
      expect((await status()).enrollInterrupted).toBe(false)
      expect(mocks.broadcastEvent).toHaveBeenCalledWith('voice-status-changed', {})
      mocks.broadcastEvent.mockClear()
      expect((await post('/voice/enroll/dismiss-interrupted')).statusCode).toBe(200)
      expect(mocks.broadcastEvent).not.toHaveBeenCalled()
    })

    it('a commit after the interruption fails and the flag stays set', async () => {
      await begin(false)
      await enrollThenInterrupt()
      expect((await post('/voice/enroll/commit')).statusCode).toBe(409)
      expect((await status()).enrollInterrupted).toBe(true)
    })
  })
})
