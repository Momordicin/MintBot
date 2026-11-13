// src/settings/HotkeysSection.tsx — 设置窗口的"快捷键"分区：按传入的动作列表显示各行按键、录入新按键、恢复本分区默认值
// 用法：VoicePanel 传入聆听 / 转写、WindowBehaviorPanel 传入专注模式 / 角色智能避让，渲染 <HotkeysSection actions={...} />；electronAPI.getHotkeys / setHotkeys / setHotkeyCapture
// 对应文件：src/settings/VoicePanel.tsx / src/settings/WindowBehaviorPanel.tsx / src/settings/settings.css / shared/hotkeys.ts / src/electron-api.d.ts / electron/preload/index.ts / electron/main/hotkeys.ts
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import './settings.css'

import { DEFAULT_HOTKEYS, resolveHotkeyCapture } from '../../shared/hotkeys.js'
import type { HotkeyAction, HotkeyCaptureEvent, HotkeyFailure, HotkeysState } from '../../shared/hotkeys.js'

type HotkeyRowReason = HotkeyFailure | 'incomplete' | 'failed'

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

export function HotkeysSection({ actions }: { actions: ReadonlyArray<{ action: HotkeyAction; label: string }> }) {
  const { t } = useTranslation()
  const [hotkeys, setHotkeys] = useState<HotkeysState | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null)
  const [rowError, setRowError] = useState<{ action: HotkeyAction; reason: HotkeyRowReason } | null>(null)
  const [titleError, setTitleError] = useState<HotkeyRowReason | null>(null)

  useEffect(() => {
    window.electronAPI.getHotkeys().then(setHotkeys).catch(() => setLoadFailed(true))
  }, [])

  const submit = async (action: HotkeyAction, accelerator: string) => {
    setSaving(true)
    setRowError(null)
    setTitleError(null)
    try {
      const result = await window.electronAPI.setHotkeys({ [action]: accelerator })
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
      const result = await window.electronAPI.setHotkeys(Object.fromEntries(actions.map(({ action }) => [action, DEFAULT_HOTKEYS[action]])))
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
    void window.electronAPI.setHotkeyCapture(true)
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
      window.electronAPI.setHotkeyCapture(false).then(setHotkeys).catch(() => setLoadFailed(true))
    }
  }, [capturing])

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
          {actions.map(({ action, label }) => {
            const key = hotkeys.keys[action]
            const combo = key === '' ? t('未设置') : key
            const capturePrompt = t('按下新的快捷键，Esc 取消')
            return (
              <React.Fragment key={action}>
                <span>{label}</span>
                <button
                  className="memory-btn voice-hotkeys__field"
                  disabled={saving}
                  aria-label={t('{{action}}快捷键：{{combo}}', { action: label, combo: capturing === action ? capturePrompt : combo })}
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
                    : !hotkeys.registered[action] && key !== '' ? t('已被其他程序占用，未生效') : null}
                </div>
              </React.Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
