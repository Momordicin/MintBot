// src/settings/VoicePanel.tsx — 设置窗口的"语音"面板：语音组件与麦克风状态、主人声纹录入、自由测试
// 用法：SettingsApp 里渲染 <VoicePanel />；GET /voice/status、POST /voice/enroll/*、POST /voice/test/*、GET /events 的 voice-status-changed；electronAPI.openMicSettings
// 对应文件：src/settings/SettingsApp.tsx / src/settings/voiceTestSummary.ts / services/core/voice/routes.ts / services/core/voice/agent.ts
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'
import { createWatchdogEventSource } from '../eventsWatchdog.js'
import { isErrorBody } from '../../shared/errorCodes.js'
import { errorText } from '../errorText.js'
import { summarizeVoiceTest, type VoiceTestResultLike } from './voiceTestSummary.js'

type VoiceMode = 'normal' | 'enrolling' | 'testing'

interface VoiceTestResult extends VoiceTestResultLike {
  uncertain: boolean
  durationMs: number
  text?: string
}

interface SpeakerStatus {
  enrolled: boolean
  utterances: number
  speechMs: number
  enrolling: boolean
  enrollUtterances: number
  enrollSpeechMs: number
  enrollReady: boolean
}

interface EnrollSentence {
  text: string
  durationMs: number
}

interface VoiceStatus {
  installed: boolean
  phase: string | null
  listening: boolean
  errorCode: string | null
  speaker: SpeakerStatus | null
  mode: VoiceMode
  listenEnabled: boolean
  enroll: { completed: EnrollSentence[]; current: EnrollSentence[] }
  test: { results: VoiceTestResult[]; hasRun: boolean }
}

const MIN_ENROLL_UTTERANCES = 5
const MIN_ENROLL_SECONDS = 10

function seconds(ms: number, digits: number): string {
  return (ms / 1000).toFixed(digits)
}

function scoreText(score: number | null | undefined): string {
  return typeof score === 'number' ? score.toFixed(2) : '-'
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

  const load = useCallback(async (): Promise<boolean> => {
    const seq = ++loadSeqRef.current
    try {
      const response = await fetch(`${CORE_URL}/voice/status`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const next: VoiceStatus = await response.json()
      if (seq !== loadSeqRef.current) return true
      modeRef.current = next.mode
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
    const endPath = (): string | null => {
      if (modeRef.current === 'enrolling') return '/voice/enroll/cancel'
      if (modeRef.current === 'testing') return '/voice/test/stop'
      return null
    }
    const onPageHide = () => {
      const target = endPath()
      if (target) fetch(`${CORE_URL}${target}`, { method: 'POST', keepalive: true }).catch(() => {})
    }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      const target = endPath()
      if (target) fetch(`${CORE_URL}${target}`, { method: 'POST' }).catch(() => {})
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
      setActionError(err instanceof Error ? err.message : t('操作失败，请稍后重试'))
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

  let statusLabel: string
  if (!status.installed) statusLabel = t('未安装')
  else if (micDenied) statusLabel = t('麦克风被系统禁用')
  else if (status.phase === 'failed') statusLabel = t('已停止重试')
  else if (running && !status.listenEnabled && mode === 'normal') statusLabel = t('语音输入已关闭')
  else if (running && status.listening) statusLabel = t('正在收听')
  else statusLabel = t('启动中')

  const verdictText = (result: VoiceTestResult): string => {
    const base = result.kind === 'owner' ? t('主人') : result.kind === 'other' ? t('其他人') : t('未录入')
    return result.uncertain ? `${base}?` : base
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
          {statusLabel}
          {status.installed && micDenied && (
            <button
              className="memory-btn"
              onClick={() => window.electronAPI.openMicSettings().catch(() => setActionError(t('操作失败，请稍后重试')))}
            >
              {t('打开麦克风设置')}
            </button>
          )}
        </div>
      </div>

      {status.installed && (mode === 'enrolling' || speaker !== null) && (
        <div className="window-behavior-panel__section">
          <div className="window-behavior-panel__section-label">{t('主人声纹')}</div>
          {mode === 'enrolling' ? (
            <>
              <div>{t('请在安静的环境里用正常语速说完整的句子，每句 5 到 10 秒，总共 35 到 45 秒更好；至少 5 句且累计超过 10 秒才能完成')}</div>
              <div>
                {t('已录 {{n}} 句 / {{sec}} 秒', {
                  n: speaker?.enrollUtterances ?? 0,
                  sec: seconds(speaker?.enrollSpeechMs ?? 0, 1),
                })}
              </div>
              {remainingSentences > 0 && <div>{t('还需要 {{n}} 句', { n: remainingSentences })}</div>}
              {remainingSeconds > 0 && <div>{t('还需要 {{sec}} 秒', { sec: remainingSeconds })}</div>}
              <button
                className="memory-btn"
                disabled={busy || !speaker || speaker.enrollUtterances < MIN_ENROLL_UTTERANCES || !speaker.enrollReady}
                onClick={() => post('/voice/enroll/commit')}
              >
                {t('完成')}
              </button>
              <button className="memory-btn" disabled={busy} onClick={() => post('/voice/enroll/cancel')}>
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
                disabled={busy || mode !== 'normal' || !running}
                onClick={() => post('/voice/enroll/start')}
              >
                {t('重新录入')}
              </button>
              <button
                className="memory-btn"
                disabled={busy || mode !== 'normal'}
                onClick={() => setConfirmingDelete(true)}
              >
                {t('删除声纹')}
              </button>
              {confirmingDelete && (
                <div className="character-panel__confirm-row">
                  <span>{t('删除声纹？删除后所有人的声音都会被识别，需要重新录入。')}</span>
                  <button className="memory-btn" disabled={busy} onClick={() => setConfirmingDelete(false)}>
                    {t('取消')}
                  </button>
                  <button
                    className="memory-btn"
                    disabled={busy || mode !== 'normal'}
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
                disabled={busy || mode !== 'normal' || !running}
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
            <button className="memory-btn" disabled={busy} onClick={() => post('/voice/test/stop')}>
              {t('结束测试')}
            </button>
          ) : (
            <button
              className="memory-btn"
              disabled={busy || mode !== 'normal' || !running}
              onClick={() => post('/voice/test/start')}
            >
              {status.test.hasRun ? t('重新测试') : t('开始测试')}
            </button>
          )}
          {mode !== 'testing' && results.length > 0 && (
            <button className="memory-btn" disabled={busy} onClick={() => post('/voice/test/clear')}>
              {t('清空测试结果')}
            </button>
          )}
          {results.length > 0 && (
            <div className="forget-panel__result">
              {results.map((result, index) => (
                <div key={index}>
                  {t('{{verdict}}，得分 {{score}}，{{sec}} 秒，{{text}}', {
                    verdict: verdictText(result),
                    score: scoreText(result.score),
                    sec: seconds(result.durationMs, 1),
                    text: result.text ?? t('（未识别）'),
                  })}
                </div>
              ))}
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

      {actionError && <div className="character-panel__error">{actionError}</div>}
    </div>
  )
}
