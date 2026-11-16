// src/settings/TtsSection.tsx — 设置窗口"语音"面板里的"语音合成组件"分区：指定已下载的 GPT-SoVITS 文件夹，或由 MintBot 下载安装（v2Pro / v5），显示安装进度、安装位置、失败原因（上次下载安装的失败单独保留并可重试）、已安装位置与新版本更新；开关语音合成，显示服务状态与当前角色语音模型的加载状态，试听
// 用法：VoicePanel 渲染 <TtsSection />；GET /tts/status、POST /tts/use-existing、POST /tts/install、POST /tts/install/cancel、POST /tts/enabled、POST /tts/preview、GET /events 的 tts-status-changed 与 preset-switched；electronAPI.selectTtsDir
// 对应文件：src/settings/VoicePanel.tsx / services/core/tts/routes.ts / services/core/tts/manager.ts / src/errorText.ts / src/electron-api.d.ts / electron/preload/index.ts / electron/main/index.ts
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'
import { createWatchdogEventSource } from '../eventsWatchdog.js'
import { isErrorBody, type ErrorCode } from '../../shared/errorCodes.js'
import { errorText } from '../errorText.js'

type TtsVariant = 'v2pro' | 'v5'

interface TtsInstallTarget {
  variant: TtsVariant
  root: string
}

interface TtsInstallStatus {
  state: 'idle' | 'installing' | 'failed'
  action?: 'download' | 'existing'
  target?: TtsInstallTarget
  phase?: 'checking' | 'download' | 'verify' | 'extract' | 'probe'
  bytes?: number
  total?: number
  errorCode?: ErrorCode
  errorDetails?: Record<string, unknown>
}

interface TtsLastDownload {
  target: TtsInstallTarget
  errorCode: ErrorCode
  errorDetails: Record<string, unknown>
}

interface TtsServiceStatus {
  state: 'stopped' | 'starting' | 'running' | 'failed'
  modelState: 'none' | 'loading' | 'loaded' | 'failed'
  errorCode?: ErrorCode
  errorDetails?: Record<string, unknown>
}

interface TtsCharacterStatus {
  name: string
  voice: 'unconfigured' | 'missing' | 'ok'
  missing: string[]
}

interface TtsStatus {
  installed: boolean
  source: 'download' | 'existing' | null
  variant: TtsVariant | null
  dir: string | null
  updateAvailable: boolean
  install: TtsInstallStatus
  lastDownload: TtsLastDownload | null
  service: TtsServiceStatus
  enabled: boolean
  character: TtsCharacterStatus
}

type TtsFailure = Pick<TtsInstallStatus, 'errorCode' | 'errorDetails'>

const BYTES_PER_GB = 1024 * 1024 * 1024

function gigabytes(bytes: unknown): string {
  return (Number(bytes ?? 0) / BYTES_PER_GB).toFixed(1)
}

function percent(install: TtsInstallStatus): number {
  return install.total ? Math.floor(((install.bytes ?? 0) * 100) / install.total) : 0
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function variantName(variant: TtsVariant): string {
  return variant === 'v5' ? 'v5' : 'v2Pro'
}

function phaseText(install: TtsInstallStatus, t: TFunction): string {
  switch (install.phase) {
    case 'download':
      return t('正在下载（{{done}} / {{total}} GB，{{percent}}%）', {
        done: gigabytes(install.bytes),
        total: gigabytes(install.total),
        percent: percent(install),
      })
    case 'verify':
      return t('正在校验（{{percent}}%）', { percent: percent(install) })
    case 'extract':
      return t('正在解压（{{percent}}%）', { percent: percent(install) })
    case 'probe':
      return t('正在试运行…')
    default:
      return t('正在检查磁盘空间…')
  }
}

function failureText(failure: TtsFailure, installed: boolean, t: TFunction): string {
  const details = failure.errorDetails ?? {}
  switch (failure.errorCode) {
    case 'TTS_EXISTING_INVALID':
      return t('这个文件夹缺少：{{files}}', { files: stringList(details.missing).join('、') })
    case 'TTS_DISK_SPACE':
      return t('磁盘空间不足：需要 {{required}} GB，剩余 {{free}} GB', {
        required: gigabytes(details.requiredBytes),
        free: gigabytes(details.freeBytes),
      })
    case 'TTS_DOWNLOAD':
      return typeof details.status === 'number'
        ? t('下载地址不可用（HTTP {{status}}）', { status: String(details.status) })
        : t('下载中断，请检查网络后重试，已下载的部分会保留')
    case 'TTS_CHECKSUM':
      return t('下载的文件已损坏，请重试')
    case 'TTS_EXTRACT':
      return t('解压失败，请重试')
    case 'TTS_PROBE':
      return t('试运行失败：{{message}}', { message: String(details.message ?? '') })
    case 'TTS_MANIFEST':
      return t('读取安装清单失败，请检查网络后重试')
    case 'TTS_TARGET_EXISTS':
      if (installed) return t('安装位置已有同名文件夹：{{dir}}，请移走或删除它后再点"更新"', { dir: String(details.dir ?? '') })
      return t('安装位置已有同名文件夹：{{dir}}，请换一个位置，或改用已下载的文件夹', { dir: String(details.dir ?? '') })
    default:
      return t('安装失败，请重试')
  }
}

function reasonText(failure: TtsFailure, t: TFunction): string {
  if (failure.errorCode === 'TTS_NOT_INSTALLED') return t('语音合成组件未安装')
  const details = failure.errorDetails ?? {}
  const parts = [details.message, details.exception].filter((part): part is string => typeof part === 'string' && part !== '')
  if (parts.length > 0) return parts.join('：')
  if (typeof details.status === 'number') return `HTTP ${details.status}`
  return t('未知原因')
}

function serviceText(service: TtsServiceStatus, t: TFunction): string {
  switch (service.state) {
    case 'starting':
      return t('正在启动')
    case 'running':
      return t('运行中')
    case 'failed':
      return t('启动失败：{{reason}}', { reason: reasonText(service, t) })
    default:
      return t('未启动')
  }
}

function modelText(status: TtsStatus, t: TFunction): string {
  if (status.character.voice === 'unconfigured') return t('未配置')
  if (status.character.voice === 'missing') return t('文件缺失：{{files}}', { files: status.character.missing.join('、') })
  switch (status.service.modelState) {
    case 'loading':
      return t('加载中')
    case 'loaded':
      return t('已加载')
    case 'failed':
      return t('加载失败：{{reason}}', { reason: reasonText(status.service, t) })
    default:
      return t('未加载')
  }
}

function FailureLines({ failure, installed }: { failure: TtsFailure; installed: boolean }) {
  const { t } = useTranslation()
  return (
    <>
      <div className="character-panel__error">{failureText(failure, installed, t)}</div>
      {failure.errorCode === 'TTS_PROBE' &&
        stringList(failure.errorDetails?.stderr).map((line, index) => (
          <div key={index} className="character-panel__hint">{line}</div>
        ))}
    </>
  )
}

export function TtsSection() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<TtsStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [existingError, setExistingError] = useState<string | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [variant, setVariant] = useState<TtsVariant>('v2pro')
  const [root, setRoot] = useState<string | null>(null)
  const [enabledError, setEnabledError] = useState<string | null>(null)
  const [confirmingUpdate, setConfirmingUpdate] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const loadSeqRef = useRef(0)
  const previewAbortRef = useRef<AbortController | null>(null)
  const previewAudioRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null)

  const stopPreview = useCallback(() => {
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    const playing = previewAudioRef.current
    previewAudioRef.current = null
    if (playing !== null) {
      playing.audio.onended = null
      playing.audio.onerror = null
      playing.audio.pause()
      URL.revokeObjectURL(playing.url)
    }
    setPreviewing(false)
    setPreviewPlaying(false)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeqRef.current
    try {
      const response = await fetch(`${CORE_URL}/tts/status`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const next: TtsStatus = await response.json()
      if (seq !== loadSeqRef.current) return
      setStatus(next)
      setLoadFailed(false)
      if (next.install.state !== 'installing') setCancelRequested(false)
    } catch {
      if (seq === loadSeqRef.current) setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    load()
    const watchdog = createWatchdogEventSource({
      url: `${CORE_URL}/events`,
      listeners: {
        'tts-status-changed': () => {
          load()
        },
        'preset-switched': () => {
          stopPreview()
          setPreviewError(null)
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
  }, [load, stopPreview])

  useEffect(() => stopPreview, [stopPreview])

  const updateConfirmable =
    status !== null &&
    status.enabled &&
    (status.service.state === 'starting' || status.service.state === 'running') &&
    status.source === 'download' &&
    status.variant !== null &&
    status.updateAvailable

  useEffect(() => {
    if (!updateConfirmable) setConfirmingUpdate(false)
  }, [updateConfirmable])

  const post = async (target: string, body?: Record<string, unknown>): Promise<string | null> => {
    const response = await fetch(`${CORE_URL}${target}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (response.ok) return null
    const payload = await response.json().catch(() => null)
    if (!isErrorBody(payload)) return `HTTP ${response.status}`
    if (payload.code === 'TTS_EXISTING_INVALID' || payload.code === 'TTS_PROBE' || payload.code === 'TTS_FAILED') return null
    return errorText(payload, t)
  }

  const failedMessage = (err: unknown) => (err instanceof Error ? err.message : t('操作失败，请稍后重试'))

  const chooseExisting = async () => {
    setBusy(true)
    setExistingError(null)
    try {
      const picked = await window.electronAPI.selectTtsDir()
      if (picked !== null) setExistingError(await post('/tts/use-existing', { dir: picked.dir }))
    } catch (err) {
      setExistingError(failedMessage(err))
    } finally {
      await load()
      setBusy(false)
    }
  }

  const chooseRoot = async () => {
    setBusy(true)
    setRootError(null)
    try {
      const picked = await window.electronAPI.selectTtsDir()
      if (picked !== null) setRoot(picked.dir)
    } catch (err) {
      setRootError(failedMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const startInstall = async (body: Record<string, unknown>) => {
    setBusy(true)
    setInstallError(null)
    try {
      setInstallError(await post('/tts/install', body))
    } catch (err) {
      setInstallError(failedMessage(err))
    } finally {
      await load()
      setBusy(false)
    }
  }

  const cancelInstall = async () => {
    setCancelRequested(true)
    setCancelError(null)
    try {
      const message = await post('/tts/install/cancel')
      if (message !== null) {
        setCancelError(message)
        setCancelRequested(false)
      }
    } catch (err) {
      setCancelError(failedMessage(err))
      setCancelRequested(false)
    } finally {
      await load()
    }
  }

  const saveEnabled = async (enabled: boolean) => {
    if (!enabled) stopPreview()
    setBusy(true)
    setEnabledError(null)
    try {
      setEnabledError(await post('/tts/enabled', { enabled }))
    } catch (err) {
      setEnabledError(failedMessage(err))
    } finally {
      await load()
      setBusy(false)
    }
  }

  const playPreview = async () => {
    const controller = new AbortController()
    previewAbortRef.current = controller
    setPreviewing(true)
    setPreviewError(null)
    const fail = (message: string) => {
      if (controller.signal.aborted) return
      stopPreview()
      setPreviewError(message)
    }
    try {
      const response = await fetch(`${CORE_URL}/tts/preview`, { method: 'POST', signal: controller.signal })
      if (response.ok) {
        const blob = await response.blob()
        if (controller.signal.aborted) return
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audio.onended = stopPreview
        audio.onerror = () => fail(failedMessage(null))
        previewAudioRef.current = { audio, url }
        await audio.play()
        if (!controller.signal.aborted) setPreviewPlaying(true)
        return
      }
      const payload = await response.json().catch(() => null)
      if (!isErrorBody(payload)) {
        fail(`HTTP ${response.status}`)
      } else if (payload.code === 'TTS_SYNTHESIS') {
        const details = (payload as { details?: Record<string, unknown> }).details
        fail(t('合成失败：{{reason}}', { reason: reasonText({ errorCode: payload.code, errorDetails: details }, t) }))
      } else {
        fail(errorText(payload, t))
      }
    } catch (err) {
      fail(failedMessage(err))
    }
  }

  const label = <div className="window-behavior-panel__section-label">{t('语音合成组件')}</div>

  if (status === null) {
    return (
      <div className="window-behavior-panel__section">
        {label}
        {loadFailed ? (
          <div className="character-panel__error">{t('加载语音合成组件状态失败，请稍后重试')}</div>
        ) : (
          <div className="memory-loading">{t('加载中…')}</div>
        )}
      </div>
    )
  }

  const { install } = status
  const installing = install.state === 'installing'
  const locked = busy || installing
  const existingFailed = install.state === 'failed' && install.action === 'existing'
  const { lastDownload } = status
  const downloadedVariant = status.source === 'download' ? status.variant : null
  const { service } = status

  const runUpdate = () => {
    if (downloadedVariant !== null) startInstall({ variant: downloadedVariant })
  }

  const requestUpdate = () => {
    if (updateConfirmable) {
      setConfirmingUpdate(true)
    } else {
      runUpdate()
    }
  }

  return (
    <div className="window-behavior-panel__section">
      {label}
      {loadFailed && <div className="character-panel__error">{t('加载语音合成组件状态失败，请稍后重试')}</div>}
      {installing && (
        <>
          {install.action === 'download' && install.target && (
            <div>
              {t('正在安装 {{version}} 到：{{dir}}', { version: variantName(install.target.variant), dir: install.target.root })}
            </div>
          )}
          <div className="character-panel__row">
            <span>{phaseText(install, t)}</span>
            {(install.total ?? 0) > 0 && <progress value={install.bytes ?? 0} max={install.total} />}
            <button className="memory-btn" disabled={cancelRequested} onClick={cancelInstall}>
              {cancelRequested ? t('正在取消…') : t('取消')}
            </button>
          </div>
          {install.phase === 'probe' && (
            <div className="character-panel__hint">{t('正在试启动语音合成服务，首次启动可能需要几分钟')}</div>
          )}
          {cancelError && <div className="character-panel__error">{cancelError}</div>}
        </>
      )}
      {!installing && status.installed && (
        <>
          <div>{t('位置：{{dir}}', { dir: status.dir ?? '' })}</div>
          <div>
            {t('版本：{{version}}', {
              version: status.source === 'existing' ? t('自备') : variantName(status.variant ?? 'v2pro'),
            })}
          </div>
          {downloadedVariant !== null && status.updateAvailable && (
            <div className="character-panel__row">
              <span>{t('有新版本')}</span>
              <button className="memory-btn" disabled={locked} onClick={requestUpdate}>
                {t('更新')}
              </button>
            </div>
          )}
          {confirmingUpdate && (
            <div className="character-panel__confirm-row">
              <span>{t('需要重启语音合成，期间无法朗读和试听，可能需要几分钟。继续吗？')}</span>
              <button className="memory-btn" disabled={locked} onClick={() => setConfirmingUpdate(false)}>
                {t('取消')}
              </button>
              <button
                className="memory-btn"
                disabled={locked}
                onClick={() => {
                  setConfirmingUpdate(false)
                  runUpdate()
                }}
              >
                {t('继续')}
              </button>
            </div>
          )}
          {status.source === 'download' && lastDownload && <FailureLines failure={lastDownload} installed />}
          {installError && <div className="character-panel__error">{installError}</div>}
        </>
      )}
      {!installing && !status.installed && (
        <>
          <div className="character-panel__row">
            <span>{t('使用已下载的 GPT-SoVITS 文件夹')}</span>
            <button className="memory-btn" disabled={locked} onClick={chooseExisting}>
              {t('选择文件夹')}
            </button>
          </div>
          {existingFailed && <FailureLines failure={install} installed={false} />}
          {existingError && <div className="character-panel__error">{existingError}</div>}
          <div>{t('由 MintBot 下载')}</div>
          <label className="character-panel__role-config-option">
            <input
              type="radio"
              name="tts-variant"
              checked={variant === 'v2pro'}
              disabled={locked}
              onChange={() => setVariant('v2pro')}
            />
            <span>{t('v2Pro（支持 v2ProPlus 模型，约 7.6 GB）')}</span>
          </label>
          <label className="character-panel__role-config-option">
            <input
              type="radio"
              name="tts-variant"
              checked={variant === 'v5'}
              disabled={locked}
              onChange={() => setVariant('v5')}
            />
            <span>{t('v5（约 10.1 GB）')}</span>
          </label>
          <div className="character-panel__row">
            <span>{t('安装位置：{{dir}}', { dir: root ?? t('data/tts（默认）') })}</span>
            <button className="memory-btn" disabled={locked} onClick={chooseRoot}>
              {t('选择位置')}
            </button>
          </div>
          {rootError && <div className="character-panel__error">{rootError}</div>}
          {lastDownload && (
            <>
              <div>
                {t('上次安装 {{version}} 到：{{dir}}', { version: variantName(lastDownload.target.variant), dir: lastDownload.target.root })}
              </div>
              <FailureLines failure={lastDownload} installed={false} />
            </>
          )}
          <div className="character-panel__row">
            <button
              className="memory-btn"
              disabled={locked}
              onClick={() => startInstall(root === null ? { variant } : { variant, root })}
            >
              {t('安装')}
            </button>
            {lastDownload && (
              <button
                className="memory-btn"
                disabled={locked}
                onClick={() => startInstall({ variant: lastDownload.target.variant, root: lastDownload.target.root })}
              >
                {t('重试')}
              </button>
            )}
          </div>
          {installError && <div className="character-panel__error">{installError}</div>}
        </>
      )}
      <label className="model-config-panel__checkbox">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={!status.installed || locked}
          onChange={e => saveEnabled(e.target.checked)}
        />
        {t('启用语音合成')}
      </label>
      {enabledError && <div className="character-panel__error">{enabledError}</div>}
      <div>{t('服务：{{state}}', { state: serviceText(service, t) })}</div>
      {service.state === 'starting' && <div className="character-panel__hint">{t('首次启动可能需要几分钟')}</div>}
      {service.state === 'failed' &&
        stringList(service.errorDetails?.stderr).map((line, index) => (
          <div key={index} className="character-panel__hint">{line}</div>
        ))}
      <div>{t('当前角色语音模型：{{state}}', { state: modelText(status, t) })}</div>
      <div className="character-panel__row">
        <button className="memory-btn" disabled={service.modelState !== 'loaded' || previewing || locked} onClick={playPreview}>
          {previewPlaying ? t('播放中…') : previewing ? t('合成中…') : t('试听')}
        </button>
      </div>
      {previewError && <div className="character-panel__error">{previewError}</div>}
    </div>
  )
}
