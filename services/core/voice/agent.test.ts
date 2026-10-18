import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mocks = vi.hoisted(() => ({
  readVoiceInstallation: vi.fn(),
  broadcastEvent: vi.fn(),
  supervisorOptions: null as { onEvent: (ev: unknown) => void } | null,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}))

vi.mock('./install.js', () => ({ readVoiceInstallation: mocks.readVoiceInstallation }))
vi.mock('../events/broadcast.js', () => ({ broadcastEvent: mocks.broadcastEvent }))
vi.mock('@mintbot/voice-agent-client', () => ({
  VoiceAgentSupervisor: class {
    constructor(options: { onEvent: (ev: unknown) => void }) {
      mocks.supervisorOptions = options
    }
    start = mocks.start
    stop = mocks.stop
  },
}))

import { startVoice, stopVoice, takePending } from './agent.js'
import { voiceRoutes } from './routes.js'
import Fastify from 'fastify'

let dataDir: string

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
      { at: 42, text: '你好', language: 'zh', emotion: 'happy', speaker_score: 0.9, is_owner: true },
      { at: 43, text: 'hi', language: 'en', emotion: 'neutral' },
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
