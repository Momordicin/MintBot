// src/settings/VoicePanel.tsx — 设置窗口的"语音"面板：语音组件与麦克风状态、主人声纹录入、自由测试、语音输入快捷键
// 用法：SettingsApp 里渲染 <VoicePanel />；GET /voice/status、GET /voice/update-check、POST /voice/enroll/*、POST /voice/test/*、GET /events 的 voice-status-changed；electronAPI.openMicSettings / getVoiceHotkeys / setVoiceHotkeys / setVoiceHotkeyCapture
// 对应文件：src/settings/SettingsApp.tsx / src/settings/voiceTestSummary.ts / shared/voiceHotkeys.ts / services/core/voice/routes.ts / services/core/voice/agent.ts
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'
import { createWatchdogEventSource } from '../eventsWatchdog.js'
import { isErrorBody } from '../../shared/errorCodes.js'
import type { VoiceInputMode } from '../../shared/voiceInputMode.js'
import { DEFAULT_VOICE_HOTKEYS, VOICE_HOTKEY_ACTIONS, resolveHotkeyCapture } from '../../shared/voiceHotkeys.js'
import type { HotkeyCaptureEvent, VoiceHotkeyAction, VoiceHotkeyFailure, VoiceHotkeysState } from '../../shared/voiceHotkeys.js'
import { errorText } from '../errorText.js'
import { deviceLineBetween, summarizeVoiceTest, testCutoff, type VoiceTestResultLike } from './voiceTestSummary.js'

type VoiceMode = 'normal' | 'enrolling' | 'testing'

interface VoiceTestResult extends VoiceTestResultLike {
  threshold?: number
  uncertain: boolean
  durationMs: number
  text?: string
  sameDevice?: boolean
  deviceName?: string
}

interface SpeakerStatus {
  enrolled: boolean
  utterances: number
  speechMs: number
  enrolling: boolean
  enrollUtterances: number
  enrollSpeechMs: number
  enrollReady: boolean
  currentDevice: string | null
  enrolledDevice: string | null
  uncertainFloor: number | null
}

interface EnrollSentence {
  text: string
  durationMs: number
}

interface InstallStatus {
  state: 'idle' | 'installing' | 'failed'
  package?: 'agent' | 'models'
  phase?: 'starting' | 'skip' | 'download' | 'verify' | 'extract' | 'done'
  bytes?: number
  total?: number
  errorCode?: string
  errorDetails?: Record<string, unknown>
}

interface VoiceStatus {
  installed: boolean
  version: string | null
  updateVersion: string | null
  enrollInterrupted: boolean
  phase: string | null
  listening: boolean
  errorCode: string | null
  speaker: SpeakerStatus | null
  mode: VoiceMode
  inputMode: VoiceInputMode
  enroll: { completed: EnrollSentence[]; current: EnrollSentence[] }
  test: { results: VoiceTestResult[]; hasRun: boolean }
  install: InstallStatus
}

const MIN_ENROLL_UTTERANCES = 5
const MIN_ENROLL_SECONDS = 10

function seconds(ms: number, digits: number): string {
  return (ms / 1000).toFixed(digits)
}

const BYTES_PER_MB = 1024 * 1024

function megabytes(bytes: number | undefined): string {
  return ((bytes ?? 0) / BYTES_PER_MB).toFixed(1)
}

function installErrorText(install: InstallStatus, t: TFunction): string {
  const details = install.errorDetails ?? {}
  switch (install.errorCode) {
    case 'NETWORK_ERROR':
      return t('网络连接失败，请检查网络后重试')
    case 'HTTP_STATUS':
      return t('下载地址不可用（HTTP {{status}}）', { status: String(details.status) })
    case 'SHA256_MISMATCH':
      return t('下载的文件已损坏，请重试')
    case 'API_VERSION_MISMATCH':
      return t('语音组件版本与 MintBot 不兼容')
    case 'ENOSPC_PRECHECK':
      return t('磁盘空间不足：需要 {{required}} MB，剩余 {{available}} MB', {
        required: Math.round(Number(details.required) / BYTES_PER_MB),
        available: Math.round(Number(details.available) / BYTES_PER_MB),
      })
    case 'INVALID_MANIFEST':
      return t('安装信息无效')
    case 'EXTRACT_FAILED':
      return t('解压失败，请重试')
    case 'VERSION_MISMATCH':
      return t('安装后的程序版本不符')
    case 'UNSUPPORTED_PLATFORM':
      return t('只支持 Windows x64')
    default:
      return t('安装失败，请重试')
  }
}

function scoreText(score: number | null | undefined): string {
  return typeof score === 'number' ? score.toFixed(2) : '-'
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

type HotkeyRowReason = VoiceHotkeyFailure | 'incomplete' | 'failed'

function VoiceHotkeysSection() {
  const { t } = useTranslation()
  const [hotkeys, setHotkeys] = useState<VoiceHotkeysState | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [capturing, setCapturing] = useState<VoiceHotkeyAction | null>(null)
  const [rowError, setRowError] = useState<{ action: VoiceHotkeyAction; reason: HotkeyRowReason } | null>(null)
  const [titleError, setTitleError] = useState<HotkeyRowReason | null>(null)

  useEffect(() => {
    window.electronAPI.getVoiceHotkeys().then(setHotkeys).catch(() => setLoadFailed(true))
  }, [])

  const submit = async (action: VoiceHotkeyAction, accelerator: string) => {
    setSaving(true)
    setRowError(null)
    setTitleError(null)
    try {
      const result = await window.electronAPI.setVoiceHotkeys({ [action]: accelerator })
      setHotkeys(result.state)
      if (!result.ok) setRowError({ action, reason: result.reason })
    } catch {
      setRowError({ action, reason: 'failed' })
    } finally {
      setSaving(false)
    }
  }

  const restoreDefaults = async () => {
    setSaving(true)
    setRowError(null)
    setTitleError(null)
    try {
      const result = await window.electronAPI.setVoiceHotkeys({ listen: DEFAULT_VOICE_HOTKEYS.listen, transcribe: DEFAULT_VOICE_HOTKEYS.transcribe })
      setHotkeys(result.state)
      if (!result.ok) setTitleError(result.reason)
    } catch {
      setTitleError('failed')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (capturing === null) return
    const action = capturing
    const events: HotkeyCaptureEvent[] = []
    void window.electronAPI.setVoiceHotkeyCapture(true)
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      events.push({ type: event.type === 'keyup' ? 'keyup' : 'keydown', code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey })
      const result = resolveHotkeyCapture(events)
      if (result.status === 'pending') return
      setCapturing(null)
      if (result.status === 'cancelled') return
      if (result.accelerator === null) setRowError({ action, reason: 'incomplete' })
      else void submit(action, result.accelerator)
    }
    const onBlur = () => setCapturing(null)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', onBlur)
      window.electronAPI.setVoiceHotkeyCapture(false).then(setHotkeys).catch(() => setLoadFailed(true))
    }
  }, [capturing])

  const actionLabel: Record<VoiceHotkeyAction, string> = { listen: t('聆听'), transcribe: t('转写') }

  const reasonText = (reason: HotkeyRowReason): string => {
    if (reason === 'invalid') return t('组合无效，请尝试其他组合')
    if (reason === 'duplicate') return t('与另一个快捷键相同，请尝试其他组合')
    if (reason === 'taken') return t('此按键已被其他程序占用，请尝试其他组合')
    if (reason === 'incomplete') return t('此组合已被占用或无效，请尝试其他组合')
    return t('操作失败，请稍后重试')
  }

  return (
    <div className="window-behavior-panel__section">
      <div className="voice-hotkeys__title">
        <div className="window-behavior-panel__section-label">{t('快捷键')}</div>
        {hotkeys !== null && (
          <button
            type="button"
            className="voice-hotkeys__icon-btn"
            disabled={saving || capturing !== null}
            aria-label={t('恢复默认快捷键')}
            onClick={restoreDefaults}
          >
            <RefreshIcon />
          </button>
        )}
        {titleError !== null && <div className="character-panel__error" role="alert">{reasonText(titleError)}</div>}
      </div>
      {loadFailed && hotkeys === null ? (
        <div className="character-panel__error">{t('加载快捷键失败，请稍后重试')}</div>
      ) : hotkeys === null ? (
        <div className="memory-loading">{t('加载中…')}</div>
      ) : (
        <div className="voice-hotkeys__grid">
          {VOICE_HOTKEY_ACTIONS.map(action => {
            const registered = action === 'listen' ? hotkeys.listenRegistered : hotkeys.transcribeRegistered
            const combo = hotkeys[action] === '' ? t('未设置') : hotkeys[action]
            const capturePrompt = t('按下新的快捷键，Esc 取消')
            return (
              <React.Fragment key={action}>
                <span>{actionLabel[action]}</span>
                <button
                  className="memory-btn voice-hotkeys__field"
                  disabled={saving}
                  aria-label={t('{{action}}快捷键：{{combo}}', { action: actionLabel[action], combo: capturing === action ? capturePrompt : combo })}
                  onClick={() => {
                    setRowError(null)
                    setTitleError(null)
                    setCapturing(action)
                  }}
                >
                  {capturing === action ? capturePrompt : combo}
                </button>
                <div className="character-panel__error" role="alert">
                  {rowError?.action === action
                    ? reasonText(rowError.reason)
                    : !registered && hotkeys[action] !== '' ? t('已被其他程序占用，未生效') : null}
                </div>
              </React.Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function VoicePanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const modeRef = useRef<VoiceMode>('normal')
  const loadSeqRef = useRef(0)
  const interruptedRef = useRef(false)
  const installStateRef = useRef<InstallStatus['state']>('idle')
  const installState = status?.install.state

  const load = useCallback(async (): Promise<boolean> => {
    const seq = ++loadSeqRef.current
    try {
      const response = await fetch(`${CORE_URL}/voice/status`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const next: VoiceStatus = await response.json()
      if (seq !== loadSeqRef.current) return true
      modeRef.current = next.mode
      if (next.enrollInterrupted && !interruptedRef.current) setActionError(null)
      interruptedRef.current = next.enrollInterrupted
      if (next.mode !== 'normal' || !next.speaker?.enrolled) setConfirmingDelete(false)
      setStatus(next)
      setLoadFailed(false)
      return true
    } catch {
      if (seq === loadSeqRef.current) setLoadFailed(true)
      return false
    }
  }, [])

  useEffect(() => {
    load()
    fetch(`${CORE_URL}/voice/update-check`)
      .then(() => load())
      .catch(() => {})
    const watchdog = createWatchdogEventSource({
      url: `${CORE_URL}/events`,
      listeners: {
        'voice-status-changed': () => {
          load()
        },
      },
      onOpen: () => {
        load()
      },
    })
    return () => {
      watchdog.close()
    }
  }, [load])

  useEffect(() => {
    if (installState === undefined) return
    const previous = installStateRef.current
    installStateRef.current = installState
    if (previous === 'installing' && installState === 'idle') {
      fetch(`${CORE_URL}/voice/update-check`)
        .then(() => load())
        .catch(() => {})
    }
  }, [installState, load])

  useEffect(() => {
    const dismissInterrupted = (keepalive: boolean) => {
      if (interruptedRef.current) {
        fetch(`${CORE_URL}/voice/enroll/dismiss-interrupted`, { method: 'POST', keepalive }).catch(() => {})
      }
    }
    const endPath = (): string | null => {
      if (modeRef.current === 'enrolling') return '/voice/enroll/cancel'
      if (modeRef.current === 'testing') return '/voice/test/stop'
      return null
    }
    const onPageHide = () => {
      const target = endPath()
      if (target) fetch(`${CORE_URL}${target}`, { method: 'POST', keepalive: true }).catch(() => {})
      dismissInterrupted(true)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      const target = endPath()
      if (target) fetch(`${CORE_URL}${target}`, { method: 'POST' }).catch(() => {})
      dismissInterrupted(false)
    }
  }, [])

  const request = async (target: string, method: 'POST' | 'DELETE' = 'POST') => {
    setBusy(true)
    setActionError(null)
    if (target === '/voice/enroll/start') modeRef.current = 'enrolling'
    if (target === '/voice/test/start') modeRef.current = 'testing'
    try {
      const response = await fetch(`${CORE_URL}${target}`, { method })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(isErrorBody(payload) ? errorText(payload, t) : `HTTP ${response.status}`)
      }
    } catch (err) {
      if (!(target === '/voice/enroll/commit' && interruptedRef.current)) {
        setActionError(err instanceof Error ? err.message : t('操作失败，请稍后重试'))
      }
    } finally {
      if (!(await load())) setActionError(t('加载语音状态失败，请稍后重试'))
      setBusy(false)
    }
  }

  const post = (target: string) => request(target)

  if (loadFailed && status === null) return <div className="character-panel__error">{t('加载语音状态失败，请稍后重试')}</div>
  if (status === null) return <div className="memory-loading">{t('加载中…')}</div>

  const { speaker, mode } = status
  const running = status.phase === 'running'
  const micDenied = status.errorCode === 'mic_access_denied'
  const results = status.test.results
  const enrollCurrent = status.enroll.current
  const enrollCompleted = status.enroll.completed
  const remainingSentences = Math.max(0, MIN_ENROLL_UTTERANCES - (speaker?.enrollUtterances ?? 0))
  const remainingSeconds = Math.max(0, Math.ceil(MIN_ENROLL_SECONDS - (speaker?.enrollSpeechMs ?? 0) / 1000))
  const summary = summarizeVoiceTest(results)
  const { install } = status
  const installing = install.state === 'installing'
  const locked = busy || installing

  let statusLabel: string
  if (!status.installed) statusLabel = t('未安装')
  else if (micDenied) statusLabel = t('麦克风被系统禁用')
  else if (status.phase === 'failed') statusLabel = t('已停止重试')
  else if (running && status.inputMode === 'off' && mode === 'normal') statusLabel = t('语音输入已关闭')
  else if (running && status.listening) statusLabel = t('正在收听')
  else statusLabel = t('启动中')

  const verdictText = (result: VoiceTestResult): string => {
    if (result.kind === 'owner' && result.uncertain) return t('主人（短句）')
    const base = result.kind === 'owner' ? t('主人') : result.kind === 'other' ? t('其他人') : t('未录入')
    return result.uncertain ? `${base}?` : base
  }

  const deviceLabel = (device: { name: string; sameDevice?: boolean }): string => {
    if (device.sameDevice === true) return `${device.name}${t('（原生）')}`
    if (device.sameDevice === false) return `${device.name}${t('（非录入时原生设备）')}`
    return device.name
  }

  const sentenceList = (label: string, sentences: EnrollSentence[]) => (
    <div className="forget-panel__result">
      <div>{label}</div>
      {sentences.map((sentence, index) => (
        <div key={index}>{t('{{text}}（{{sec}} 秒）', { text: sentence.text, sec: seconds(sentence.durationMs, 1) })}</div>
      ))}
    </div>
  )

  return (
    <div className="window-behavior-panel">
      <div className="window-behavior-panel__section">
        <div className="window-behavior-panel__section-label">{t('状态')}</div>
        <div>
          {installing ? t('正在安装语音组件') : statusLabel}
          {status.installed && !installing && micDenied && (
            <button
              className="memory-btn"
              onClick={() => window.electronAPI.openMicSettings().catch(() => setActionError(t('操作失败，请稍后重试')))}
            >
              {t('打开麦克风设置')}
            </button>
          )}
          {!status.installed && !installing && install.state === 'idle' && (
            <button className="memory-btn" disabled={locked} onClick={() => post('/voice/install')}>
              {t('下载并安装语音组件')}
            </button>
          )}
          {status.installed && !installing && install.state === 'idle' && status.updateVersion !== null && (
            <>
              {' '}
              {t('当前 {{current}}，可更新到 {{next}}', { current: status.version ?? '', next: status.updateVersion })}
              <button className="memory-btn" disabled={locked || mode !== 'normal'} onClick={() => post('/voice/install')}>
                {t('更新')}
              </button>
            </>
          )}
          {status.installed && !installing && install.state === 'idle' && status.phase === 'failed' && (
            <button className="memory-btn" disabled={locked} onClick={() => post('/voice/install')}>
              {t('修复语音组件')}
            </button>
          )}
        </div>
        {status.installed && !installing && speaker?.currentDevice && (
          <div>{t('当前麦克风：{{name}}', { name: speaker.currentDevice })}</div>
        )}
        {status.installed && !installing && speaker?.enrolledDevice && (
          <div>{t('声纹录入于：{{name}}', { name: speaker.enrolledDevice })}</div>
        )}
        {installing && (
          <div>
            {install.phase === 'starting' && t('正在启动语音组件')}
            {install.phase === 'download' &&
              (install.package === 'models'
                ? t('正在下载语音模型（{{done}} / {{total}} MB）', { done: megabytes(install.bytes), total: megabytes(install.total) })
                : t('正在下载语音程序（{{done}} / {{total}} MB）', { done: megabytes(install.bytes), total: megabytes(install.total) }))}
            {install.phase === 'download' && (install.total ?? 0) > 0 && (
              <progress value={install.bytes ?? 0} max={install.total} />
            )}
            {install.phase === 'verify' && t('正在校验…')}
            {install.phase === 'extract' && t('正在解压…')}
            {install.phase !== 'starting' && (
              <button className="memory-btn" disabled={busy} onClick={() => post('/voice/install/cancel')}>
                {t('取消')}
              </button>
            )}
          </div>
        )}
        {install.state === 'failed' && (
          <div>
            <span className="character-panel__error">{installErrorText(install, t)}</span>
            <button className="memory-btn" disabled={locked} onClick={() => post('/voice/install')}>
              {t('重试')}
            </button>
          </div>
        )}
      </div>

      {status.installed && (mode === 'enrolling' || speaker !== null) && (
        <div className="window-behavior-panel__section">
          <div className="window-behavior-panel__section-label">{t('主人声纹')}</div>
          {status.enrollInterrupted && (
            <div className="character-panel__error">
              {t('录入时请勿切换输入设备，否则会显著降低对主人的识别准确率；本次录入已终止，原声纹继续使用。')}
            </div>
          )}
          {mode === 'enrolling' ? (
            <>
              <div>{t('请在安静的环境里用正常语速说完整的句子，每句 5 到 10 秒，总共 35 到 45 秒更好；至少 5 句且累计超过 10 秒才能完成')}</div>
              <div>
                {t('已录 {{n}} 句 / {{sec}} 秒', {
                  n: speaker?.enrollUtterances ?? 0,
                  sec: (Math.floor((speaker?.enrollSpeechMs ?? 0) / 100) / 10).toFixed(1),
                })}
              </div>
              {remainingSentences > 0 && <div>{t('还需要 {{count}} 句', { count: remainingSentences })}</div>}
              {remainingSeconds > 0 && <div>{t('还需要 {{count}} 秒', { count: remainingSeconds })}</div>}
              <button
                className="memory-btn"
                disabled={locked || !speaker || speaker.enrollUtterances < MIN_ENROLL_UTTERANCES || !speaker.enrollReady}
                onClick={() => post('/voice/enroll/commit')}
              >
                {t('完成')}
              </button>
              <button className="memory-btn" disabled={locked} onClick={() => post('/voice/enroll/cancel')}>
                {t('取消')}
              </button>
              {sentenceList(t('本次录入'), enrollCurrent)}
              {enrollCompleted.length > 0 && sentenceList(t('上一次录入'), enrollCompleted)}
            </>
          ) : speaker?.enrolled ? (
            <>
              <div>{t('已录入（{{n}} 句，{{sec}} 秒）', { n: speaker.utterances, sec: seconds(speaker.speechMs, 1) })}</div>
              <button
                className="memory-btn"
                disabled={locked || mode !== 'normal' || !running}
                onClick={() => post('/voice/enroll/start')}
              >
                {t('重新录入')}
              </button>
              <button
                className="memory-btn"
                disabled={locked || mode !== 'normal'}
                onClick={() => setConfirmingDelete(true)}
              >
                {t('删除声纹')}
              </button>
              {confirmingDelete && (
                <div className="character-panel__confirm-row">
                  <span>{t('删除声纹？删除后所有人的声音都会被识别，需要重新录入。')}</span>
                  <button className="memory-btn" disabled={locked} onClick={() => setConfirmingDelete(false)}>
                    {t('取消')}
                  </button>
                  <button
                    className="memory-btn"
                    disabled={locked || mode !== 'normal'}
                    onClick={async () => {
                      setConfirmingDelete(false)
                      await request('/voice/speaker', 'DELETE')
                    }}
                  >
                    {t('确认删除')}
                  </button>
                </div>
              )}
              {enrollCompleted.length > 0 && sentenceList(t('上一次录入'), enrollCompleted)}
            </>
          ) : (
            <>
              <div>{t('未录入，所有人的声音都会被识别')}</div>
              <button
                className="memory-btn"
                disabled={locked || mode !== 'normal' || !running}
                onClick={() => post('/voice/enroll/start')}
              >
                {t('开始录入')}
              </button>
              {enrollCompleted.length > 0 && sentenceList(t('上一次录入'), enrollCompleted)}
            </>
          )}
        </div>
      )}

      {status.installed && (
        <div className="window-behavior-panel__section">
          <div className="window-behavior-panel__section-label">{t('自由测试')}</div>
          {mode === 'testing' ? (
            <button className="memory-btn" disabled={locked} onClick={() => post('/voice/test/stop')}>
              {t('结束测试')}
            </button>
          ) : (
            <button
              className="memory-btn"
              disabled={locked || mode !== 'normal' || !running}
              onClick={() => post('/voice/test/start')}
            >
              {status.test.hasRun ? t('重新测试') : t('开始测试')}
            </button>
          )}
          {mode !== 'testing' && results.length > 0 && (
            <button className="memory-btn" disabled={locked} onClick={() => post('/voice/test/clear')}>
              {t('清空测试结果')}
            </button>
          )}
          {results.length > 0 && (
            <div className="forget-panel__result">
              {results.map((result, index) => {
                const cutoff = testCutoff(result, speaker?.uncertainFloor)
                const deviceLine = deviceLineBetween(index === 0 ? null : results[index - 1], result)
                return (
                <React.Fragment key={index}>
                {deviceLine && (
                  <div className="character-panel__hint">
                    {deviceLine.from
                      ? t('{{from}} → {{to}}', { from: deviceLabel(deviceLine.from), to: deviceLabel(deviceLine.to) })
                      : deviceLabel(deviceLine.to)}
                  </div>
                )}
                <div>
                  {cutoff === null
                    ? t('{{verdict}}，得分 {{score}}，{{sec}} 秒，{{text}}', {
                        verdict: verdictText(result),
                        score: scoreText(result.score),
                        sec: seconds(result.durationMs, 1),
                        text: result.text ?? t('（未识别）'),
                      })
                    : t('{{verdict}}，得分 {{score}}（{{op}}{{cutoff}}），{{sec}} 秒，{{text}}', {
                        verdict: verdictText(result),
                        score: scoreText(result.score),
                        op: (result.score ?? 0) >= cutoff ? '≥' : '＜',
                        cutoff: scoreText(cutoff),
                        sec: seconds(result.durationMs, 1),
                        text: result.text ?? t('（未识别）'),
                      })}
                </div>
                </React.Fragment>
                )
              })}
            </div>
          )}
          {mode !== 'testing' && results.length > 0 && (
            <div className="forget-panel__result">
              <div>{t('判为主人 {{owner}} 句，其他人 {{other}} 句', { owner: summary.ownerCount, other: summary.otherCount })}</div>
              <div>
                {t('得分 最低 {{min}} / 中位 {{median}} / 最高 {{max}}', {
                  min: scoreText(summary.minScore),
                  median: scoreText(summary.medianScore),
                  max: scoreText(summary.maxScore),
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <VoiceHotkeysSection />

      {actionError && <div className="character-panel__error">{actionError}</div>}
    </div>
  )
}
