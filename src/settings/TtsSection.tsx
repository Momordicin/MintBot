// src/settings/TtsSection.tsx — 设置窗口"语音"面板里的"语音合成组件"分区：指定已下载的 GPT-SoVITS 文件夹，或由 MintBot 下载安装（v2Pro / v5），显示安装进度、安装位置、失败原因（上次下载安装的失败单独保留并可重试）、已安装位置与新版本更新
// 用法：VoicePanel 渲染 <TtsSection />；GET /tts/status、POST /tts/use-existing、POST /tts/install、POST /tts/install/cancel、GET /events 的 tts-status-changed；electronAPI.selectTtsDir
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

interface TtsStatus {
  installed: boolean
  source: 'download' | 'existing' | null
  variant: TtsVariant | null
  dir: string | null
  updateAvailable: boolean
  install: TtsInstallStatus
  lastDownload: TtsLastDownload | null
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
  const loadSeqRef = useRef(0)

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
      },
      onOpen: () => {
        load()
      },
    })
    return () => {
      watchdog.close()
    }
  }, [load])

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
              <button className="memory-btn" disabled={locked} onClick={() => startInstall({ variant: downloadedVariant })}>
                {t('更新')}
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
    </div>
  )
}
