// services/core/voice/agent.ts — 托管语音输入进程：转写结果追加到本地记录，并累积为待放入聊天输入框的文字
// 用法：index.ts 的 start() 调 startVoice()，SIGINT/SIGTERM 时调 stopVoice()；voice/routes.ts 调 takePending()；有新文字时 broadcastEvent('voice-pending')
// 对应文件：services/core/voice/install.ts / services/core/voice/routes.ts / services/core/events/broadcast.ts / services/core/voice/agent.test.ts
import fs from 'fs'
import path from 'path'
import { API_VERSION, VoiceAgentSupervisor, type AgentEvent, type SupervisorState } from '@mintbot/voice-agent-client'
import { ERROR_CODES, type ErrorCode } from '../../../shared/errorCodes.js'
import { getVoiceListenEnabled, setVoiceListenEnabled } from '../config/index.js'
import { broadcastEvent } from '../events/broadcast.js'
import {
  fetchRemoteManifestInfo,
  installVoice,
  readVoiceInstallation,
  removeStaleVoiceVersions,
  resolveManifestUrl,
} from './install.js'

export const VOICE_DATA_DIR = path.resolve(process.cwd(), 'data', 'voice')

const MODE_TIMEOUT_MS = 10 * 60 * 1000
const MIN_COMMIT_UTTERANCES = 5
const MODE_HISTORY_LIMIT = 8
const INSTALL_NOTIFY_INTERVAL_MS = 500
const UPDATE_CHECK_CACHE_MS = 10 * 60 * 1000

export type VoiceMode = 'normal' | 'enrolling' | 'testing'

export interface TestResult {
  kind: 'owner' | 'other' | 'unenrolled'
  score?: number
  threshold?: number
  uncertain: boolean
  durationMs: number
  text?: string
}

export interface SpeakerStatus {
  enrolled: boolean
  utterances: number
  speechMs: number
  enrolling: boolean
  enrollUtterances: number
  enrollSpeechMs: number
  enrollReady: boolean
}

export interface EnrollSentence {
  text: string
  durationMs: number
}

export interface InstallStatus {
  state: 'idle' | 'installing' | 'failed'
  package?: 'agent' | 'models'
  phase?: 'starting' | 'skip' | 'download' | 'verify' | 'extract' | 'done'
  bytes?: number
  total?: number
  errorCode?: string
  errorDetails?: Record<string, unknown>
}

export interface VoiceStatus {
  installed: boolean
  version: string | null
  updateVersion: string | null
  enrollInterrupted: boolean
  phase: string | null
  listening: boolean
  errorCode: string | null
  speaker: SpeakerStatus | null
  mode: VoiceMode
  listenEnabled: boolean
  enroll: { completed: EnrollSentence[]; current: EnrollSentence[] }
  test: { results: TestResult[]; hasRun: boolean }
  install: InstallStatus
}

export class VoiceOperationError extends Error {
  constructor(readonly status: number, readonly errorCode: ErrorCode) {
    super(errorCode)
  }
}

let supervisor: VoiceAgentSupervisor | null = null
let voiceDataDir = VOICE_DATA_DIR
let transcriptsPath = path.join(VOICE_DATA_DIR, 'transcripts.jsonl')
let pending: string[] = []
let latestState: SupervisorState | null = null
let mode: VoiceMode = 'normal'
let modeSeq = 0
let modeHistory: Array<{ mode: VoiceMode; since: number; seq: number }> = [{ mode: 'normal', since: Date.now(), seq: 0 }]
let listenEnabled = false
let testResults: TestResult[] = []
let testSeq: number | null = null
let testHasRun = false
let enrollCompleted: EnrollSentence[] = []
let enrollCurrent: EnrollSentence[] = []
let enrollSeq: number | null = null
let committedSeq: number | null = null
let modeTimer: ReturnType<typeof setTimeout> | null = null
let install: InstallStatus = { state: 'idle' }
let installAbort: AbortController | null = null
let installTask: Promise<void> | null = null
let skipInstallRecovery = false
let installedVersion: string | null = null
let updateCheck: { at: number; version: string | null } | null = null
let enrollInterrupted = false
let enrollBaseline: { enrolled: boolean; utterances: number } | null = null

export function takePending(): string[] {
  const texts = pending
  pending = []
  return texts
}

function notifyStatusChanged(): void {
  broadcastEvent('voice-status-changed', {})
}

function clearModeTimer(): void {
  if (modeTimer) {
    clearTimeout(modeTimer)
    modeTimer = null
  }
}

function applyListening(): void {
  supervisor?.setListening(listenEnabled || mode !== 'normal')
}

function recordMode(next: VoiceMode): void {
  modeHistory.push({ mode: next, since: Date.now(), seq: modeSeq })
  if (modeHistory.length > MODE_HISTORY_LIMIT) modeHistory.shift()
}

function ownerMode(data: Record<string, unknown>): { mode: VoiceMode; seq: number } {
  const { end_unix_ms: endUnixMs, end_ms: endMs, start_ms: startMs } = data
  if (!Number.isFinite(endUnixMs) || !Number.isFinite(endMs) || !Number.isFinite(startMs)) return { mode, seq: modeSeq }
  const startedAt = (endUnixMs as number) - ((endMs as number) - (startMs as number))
  let owner: { mode: VoiceMode; seq: number } = { mode: 'normal', seq: 0 }
  for (const entry of modeHistory) {
    if (entry.since <= startedAt) owner = { mode: entry.mode, seq: entry.seq }
  }
  return owner
}

function endMode(): void {
  clearModeTimer()
  mode = 'normal'
  enrollCurrent = []
  enrollSeq = null
  enrollBaseline = null
  modeSeq++
  recordMode('normal')
  applyListening()
  notifyStatusChanged()
}

function armModeTimer(onTimeout: () => Promise<void>): void {
  clearModeTimer()
  modeTimer = setTimeout(() => {
    modeTimer = null
    onTimeout().catch(() => {})
  }, MODE_TIMEOUT_MS)
  modeTimer.unref()
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function testResult(kind: TestResult['kind'], data: Record<string, unknown>, text?: string): TestResult {
  const result: TestResult = {
    kind,
    uncertain: data.speaker_uncertain === true,
    durationMs: num(data.end_ms) - num(data.start_ms),
  }
  if (typeof data.speaker_score === 'number') result.score = data.speaker_score
  if (typeof data.speaker_threshold === 'number') result.threshold = data.speaker_threshold
  if (text !== undefined) result.text = text
  return result
}

function parseVersion(version: string): number[] | null {
  return /^\d+(\.\d+)*$/.test(version) ? version.split('.').map(Number) : null
}

function isNewerVersion(remote: string, local: string): boolean {
  const a = parseVersion(remote)
  const b = parseVersion(local)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

export async function checkVoiceUpdate(): Promise<void> {
  if (installedVersion === null) return
  if (updateCheck && Date.now() - updateCheck.at < UPDATE_CHECK_CACHE_MS) return
  const manifest = resolveManifestUrl()
  if (manifest === null) return
  try {
    const remote = await fetchRemoteManifestInfo(manifest)
    updateCheck = { at: Date.now(), version: remote.apiVersion === API_VERSION ? remote.version : null }
  } catch (err) {
    console.error('[Voice] Update check failed:', err)
  }
}

async function verifyVoiceprintKept(
  current: VoiceAgentSupervisor,
  baseline: { enrolled: boolean; utterances: number }
): Promise<void> {
  const speaker = await fetchSpeaker(current)
  if (!speaker) return
  if (speaker.enrolled !== baseline.enrolled || speaker.utterances !== baseline.utterances) {
    console.error('[Voice] Voiceprint changed after the enrollment was interrupted by a device change:', baseline, speaker)
  }
}

function handleEvent(ev: AgentEvent): void {
  if (ev.type === 'enroll_progress' || ev.type === 'speaker') {
    notifyStatusChanged()
    return
  }
  if (ev.type === 'enroll_failed') {
    if (ev.data?.code === 'device_changed' && mode === 'enrolling') {
      const baseline = enrollBaseline
      enrollInterrupted = true
      endMode()
      if (supervisor && baseline) verifyVoiceprintKept(supervisor, baseline).catch(() => {})
    }
    return
  }
  if (ev.type === 'speech_other') {
    const otherData = ev.data ?? {}
    const otherOwner = ownerMode(otherData)
    if (otherOwner.mode !== 'testing' || otherOwner.seq !== testSeq) return
    testResults.push(testResult('other', otherData))
    notifyStatusChanged()
    return
  }
  if (ev.type !== 'final') return
  const data = ev.data ?? {}
  const text = data.text
  if (data.enrolling === true) {
    if (typeof text === 'string' && text.trim() !== '') {
      const enrollOwner = ownerMode(data)
      const sentence = { text, durationMs: num(data.end_ms) - num(data.start_ms) }
      if (enrollOwner.seq === enrollSeq && enrollOwner.mode === 'enrolling') {
        enrollCurrent.push(sentence)
        notifyStatusChanged()
      } else if (enrollOwner.seq === committedSeq) {
        enrollCompleted.push(sentence)
        notifyStatusChanged()
      }
    }
    return
  }
  if (typeof text !== 'string' || text.trim() === '') return
  const { mode: owner, seq: ownerSeq } = ownerMode(data)
  if (owner === 'enrolling') return

  const record: Record<string, unknown> = {
    at: data.end_unix_ms,
    text,
    language: data.language,
    emotion: data.emotion,
    mode: owner,
  }
  if (data.speaker_score !== undefined) record.speaker_score = data.speaker_score
  if (data.is_owner !== undefined) record.is_owner = data.is_owner
  try {
    fs.appendFileSync(transcriptsPath, JSON.stringify(record) + '\n')
  } catch (err) {
    console.error('[Voice] Failed to append transcript:', err, record)
  }

  if (owner === 'testing') {
    if (ownerSeq !== testSeq) return
    const kind = data.speaker_enrolled !== true ? 'unenrolled' : 'owner'
    testResults.push(testResult(kind, data, text))
    notifyStatusChanged()
    return
  }

  if (owner === 'normal' && listenEnabled) {
    pending.push(text)
    broadcastEvent('voice-pending', {})
  }
}

function resetState(): void {
  clearModeTimer()
  latestState = null
  mode = 'normal'
  modeSeq++
  modeHistory = [{ mode: 'normal', since: Date.now(), seq: modeSeq }]
  listenEnabled = false
  testResults = []
  testSeq = null
  testHasRun = false
  enrollCompleted = []
  enrollCurrent = []
  enrollSeq = null
  committedSeq = null
  installedVersion = null
  updateCheck = null
  enrollInterrupted = false
  enrollBaseline = null
}

function readSpeaker(raw: Record<string, unknown>): SpeakerStatus {
  return {
    enrolled: raw.enrolled === true,
    utterances: num(raw.utterances),
    speechMs: num(raw.speech_ms),
    enrolling: raw.enrolling === true,
    enrollUtterances: num(raw.enroll_utterances),
    enrollSpeechMs: num(raw.enroll_speech_ms),
    enrollReady: raw.enroll_ready === true,
  }
}

async function fetchSpeaker(current: VoiceAgentSupervisor): Promise<SpeakerStatus | null> {
  try {
    return readSpeaker(await current.call('GET', '/v1/speaker'))
  } catch {
    return null
  }
}

export async function getVoiceStatus(): Promise<VoiceStatus> {
  const current = supervisor
  const running = current !== null && latestState?.phase === 'running'
  return {
    installed: current !== null,
    version: installedVersion,
    updateVersion:
      installedVersion !== null && updateCheck?.version && isNewerVersion(updateCheck.version, installedVersion)
        ? updateCheck.version
        : null,
    enrollInterrupted,
    phase: latestState?.phase ?? null,
    listening: latestState?.listening ?? false,
    errorCode: latestState?.error?.code ?? null,
    speaker: running ? await fetchSpeaker(current) : null,
    mode,
    listenEnabled,
    enroll: { completed: enrollCompleted, current: enrollCurrent },
    test: { results: testResults, hasRun: testHasRun },
    install: { ...install },
  }
}

function requireRunning(): VoiceAgentSupervisor {
  if (!supervisor || latestState?.phase !== 'running') {
    throw new VoiceOperationError(503, ERROR_CODES.VOICE_UNAVAILABLE)
  }
  return supervisor
}

async function callAgent(
  current: VoiceAgentSupervisor,
  agentPath: string,
  conflictCode: ErrorCode
): Promise<void> {
  try {
    await current.call('POST', agentPath)
  } catch (err) {
    if ((err as { status?: unknown }).status === 409) throw new VoiceOperationError(409, conflictCode)
    throw new VoiceOperationError(503, ERROR_CODES.VOICE_UNAVAILABLE)
  }
}

export async function startEnroll(): Promise<void> {
  const current = requireRunning()
  if (mode !== 'normal') throw new VoiceOperationError(409, ERROR_CODES.VOICE_BUSY)
  mode = 'enrolling'
  enrollInterrupted = false
  enrollBaseline = null
  enrollCurrent = []
  const seq = ++modeSeq
  enrollSeq = seq
  recordMode('enrolling')
  applyListening()
  armModeTimer(cancelEnroll)
  notifyStatusChanged()

  const speaker = await fetchSpeaker(current)
  if (seq !== modeSeq) return
  if (!speaker) {
    endMode()
    throw new VoiceOperationError(503, ERROR_CODES.VOICE_UNAVAILABLE)
  }
  enrollBaseline = { enrolled: speaker.enrolled, utterances: speaker.utterances }
  try {
    await callAgent(current, '/v1/speaker/enroll/start', ERROR_CODES.VOICE_BUSY)
  } catch (err) {
    if (seq === modeSeq) endMode()
    throw err
  }
  if (seq !== modeSeq) await callAgent(current, '/v1/speaker/enroll/cancel', ERROR_CODES.VOICE_BUSY).catch(() => {})
}

export async function commitEnroll(): Promise<void> {
  const current = requireRunning()
  if (mode !== 'enrolling') throw new VoiceOperationError(409, ERROR_CODES.VOICE_BUSY)
  const seq = modeSeq
  const speaker = await fetchSpeaker(current)
  if (!speaker) throw new VoiceOperationError(503, ERROR_CODES.VOICE_UNAVAILABLE)
  if (speaker.enrollUtterances < MIN_COMMIT_UTTERANCES) {
    throw new VoiceOperationError(409, ERROR_CODES.VOICE_ENROLL_NOT_READY)
  }
  await callAgent(current, '/v1/speaker/enroll/commit', ERROR_CODES.VOICE_ENROLL_NOT_READY)
  if (seq === modeSeq) {
    enrollCompleted = enrollCurrent
    committedSeq = enrollSeq
    enrollInterrupted = false
    endMode()
  }
}

export async function deleteSpeaker(): Promise<void> {
  const current = requireRunning()
  if (mode !== 'normal') throw new VoiceOperationError(409, ERROR_CODES.VOICE_BUSY)
  try {
    await current.call('DELETE', '/v1/speaker')
  } catch {
    throw new VoiceOperationError(503, ERROR_CODES.VOICE_UNAVAILABLE)
  }
  enrollCompleted = []
  enrollCurrent = []
  committedSeq = null
  enrollInterrupted = false
  notifyStatusChanged()
}

export function clearEnrollInterrupted(): void {
  if (!enrollInterrupted) return
  enrollInterrupted = false
  notifyStatusChanged()
}

export async function cancelEnroll(): Promise<void> {
  if (mode === 'enrolling') endMode()
  const current = requireRunning()
  try {
    await callAgent(current, '/v1/speaker/enroll/cancel', ERROR_CODES.VOICE_BUSY)
  } catch (err) {
    if (err instanceof VoiceOperationError && err.status === 409) return
    throw err
  }
}

export async function startTest(): Promise<void> {
  requireRunning()
  if (mode !== 'normal') throw new VoiceOperationError(409, ERROR_CODES.VOICE_BUSY)
  testResults = []
  testHasRun = true
  mode = 'testing'
  modeSeq++
  testSeq = modeSeq
  recordMode('testing')
  applyListening()
  armModeTimer(stopTest)
  notifyStatusChanged()
}

export function clearTest(): void {
  if (mode === 'testing') throw new VoiceOperationError(409, ERROR_CODES.VOICE_BUSY)
  testResults = []
  testSeq = null
  notifyStatusChanged()
}

export async function stopTest(): Promise<void> {
  if (mode === 'testing') endMode()
  requireRunning()
}

export function setListenEnabled(enabled: boolean): void {
  if (!supervisor) throw new VoiceOperationError(503, ERROR_CODES.VOICE_UNAVAILABLE)
  if (mode !== 'normal') throw new VoiceOperationError(409, ERROR_CODES.VOICE_BUSY)
  setVoiceListenEnabled(enabled)
  listenEnabled = enabled
  applyListening()
  notifyStatusChanged()
}

export async function startVoice(dataDir: string = VOICE_DATA_DIR): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true })
  voiceDataDir = dataDir
  transcriptsPath = path.join(dataDir, 'transcripts.jsonl')
  resetState()

  const installation = await readVoiceInstallation()
  if (!installation) {
    console.log('[Voice] 语音组件未安装，运行 pnpm setup:voice --manifest <路径或网址> 安装')
    return
  }

  installedVersion = installation.version
  listenEnabled = getVoiceListenEnabled()
  supervisor = new VoiceAgentSupervisor({
    installation,
    listen: listenEnabled,
    voiceprintPath: path.join(dataDir, 'owner.voiceprint.json'),
    onEvent: handleEvent,
    onState: state => {
      latestState = state
      if (state.phase !== 'running' && mode === 'enrolling') {
        endMode()
        return
      }
      notifyStatusChanged()
    },
  })
  await supervisor.start()
}

async function runInstall(manifest: string, signal: AbortSignal): Promise<void> {
  let lastNotifyAt = 0
  let outcome: InstallStatus = { state: 'idle' }
  let installed = false
  try {
    await stopVoice()
    await installVoice(manifest, msg => console.log('[Voice] install:', msg), {
      signal,
      onStep: step => {
        const changed = step.package !== install.package || step.phase !== install.phase
        install = { state: 'installing', package: step.package, phase: step.phase, bytes: step.bytes, total: step.total }
        const now = Date.now()
        if (changed || now - lastNotifyAt >= INSTALL_NOTIFY_INTERVAL_MS) {
          lastNotifyAt = now
          notifyStatusChanged()
        }
      },
    })
    installed = true
  } catch (err) {
    const failure = err as { name?: string; code?: string; details?: Record<string, unknown> }
    if (failure.name !== 'AbortError') {
      console.error('[Voice] Install failed:', err)
      outcome = { state: 'failed', errorCode: failure.code ?? 'UNKNOWN', errorDetails: failure.details ?? {} }
    }
  } finally {
    installAbort = null
  }
  if (!skipInstallRecovery) {
    install = { state: 'installing', phase: 'starting' }
    notifyStatusChanged()
    await startVoice(voiceDataDir).catch(err => console.error('[Voice] Startup after install failed:', err))
    if (installed && supervisor !== null && latestState?.phase === 'running') {
      await removeStaleVoiceVersions().catch(err => console.error('[Voice] Failed to remove old voice versions:', err))
    }
  }
  install = outcome
  notifyStatusChanged()
}

export function startInstall(): void {
  if (install.state === 'installing' || mode !== 'normal') {
    throw new VoiceOperationError(409, ERROR_CODES.VOICE_BUSY)
  }
  const manifest = resolveManifestUrl()
  if (manifest === null) throw new VoiceOperationError(503, ERROR_CODES.VOICE_INSTALL_UNCONFIGURED)
  const controller = new AbortController()
  installAbort = controller
  skipInstallRecovery = false
  install = { state: 'installing' }
  notifyStatusChanged()
  installTask = runInstall(manifest, controller.signal).catch(err => console.error('[Voice] Install task error:', err))
}

export function cancelInstall(): void {
  installAbort?.abort()
}

export async function cancelInstallForShutdown(): Promise<void> {
  skipInstallRecovery = true
  cancelInstall()
  await installTask
}

export async function stopVoice(): Promise<void> {
  const current = supervisor
  supervisor = null
  resetState()
  if (!current) return
  try {
    await current.stop()
  } catch (err) {
    console.error('[Voice] Failed to stop voice agent:', err)
  }
}
