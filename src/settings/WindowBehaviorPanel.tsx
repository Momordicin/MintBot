import React, { useCallback, useEffect, useRef, useState } from 'react'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'
import { createWatchdogEventSource } from '../eventsWatchdog.js'
import { isNewerSnapshot } from '../../shared/windowBehavior.js'
import type {
  AppRuleEffect,
  ChatPinMode,
  WindowBehaviorConfig,
  WindowBehaviorSnapshot,
} from '../../shared/windowBehavior.js'

const CHAT_PIN_MODE_OPTIONS: ReadonlyArray<{ value: ChatPinMode; label: string }> = [
  { value: 'always', label: '始终置顶' },
  { value: 'smart', label: '智能置顶' },
  { value: 'off', label: '不置顶' },
]

const APP_RULE_EFFECT_OPTIONS: ReadonlyArray<{ value: AppRuleEffect; label: string }> = [
  { value: 'allow', label: '不避让' },
  { value: 'soft', label: '轻度避让' },
  { value: 'hard', label: '完全隐藏' },
]

export function WindowBehaviorPanel() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<WindowBehaviorSnapshot | null>(null)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const patchControllerRef = useRef<AbortController | null>(null)
  const snapshotRef = useRef<WindowBehaviorSnapshot | null>(null)

  const applySnapshot = useCallback((next: WindowBehaviorSnapshot) => {
    setSnapshot(prev => (isNewerSnapshot(prev, next) ? next : prev))
  }, [])

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useEffect(() => {
    return () => {
      patchControllerRef.current?.abort()
    }
  }, [])

  const fetchSnapshot = useCallback(async () => {
    const response = await fetch(`${CORE_URL}/config/window-behavior`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as WindowBehaviorSnapshot
  }, [])

  useEffect(() => {
    fetchSnapshot()
      .then(applySnapshot)
      .catch(() => setLoadError('加载窗口行为配置失败，请稍后重试'))
      .finally(() => setLoading(false))
  }, [fetchSnapshot, applySnapshot])

  useEffect(() => {
    const watchdog = createWatchdogEventSource({
      url: `${CORE_URL}/events`,
      listeners: {
        'window-behavior-changed': (event: MessageEvent) => {
          try {
            applySnapshot(JSON.parse(event.data))
          } catch {
          }
        },
      },
      onOpen: () => {
        fetchSnapshot()
          .then(applySnapshot)
          .catch(() => {
          })
      },
    })
    return () => {
      watchdog.close()
    }
  }, [applySnapshot, fetchSnapshot])

  const patchConfig = useCallback(async (partial: Partial<WindowBehaviorConfig>) => {
    const controller = new AbortController()
    patchControllerRef.current = controller
    setSaving(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${CORE_URL}/config/window-behavior`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
        signal: controller.signal,
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }

      applySnapshot((await response.json()) as WindowBehaviorSnapshot)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setErrorMessage(err instanceof Error ? err.message : '保存窗口行为配置失败，请稍后重试')
    } finally {
      if (!controller.signal.aborted) setSaving(false)
    }
  }, [applySnapshot])

  const handleAddRule = useCallback(async () => {
    const result = await window.electronAPI.selectExeFile()
    if (!result) return

    const current = snapshotRef.current?.config
    if (!current) return

    const lower = result.filename.toLowerCase()
    if (current.appRules.some(rule => rule.exeName.toLowerCase() === lower)) return

    patchConfig({ appRules: [...current.appRules, { exeName: result.filename, effect: 'soft' }] })
  }, [patchConfig])

  const handleRuleEffectChange = useCallback((exeName: string, effect: AppRuleEffect) => {
    const current = snapshot?.config
    if (!current) return
    patchConfig({ appRules: current.appRules.map(rule => (rule.exeName === exeName ? { ...rule, effect } : rule)) })
  }, [snapshot, patchConfig])

  const handleRemoveRule = useCallback((exeName: string) => {
    const current = snapshot?.config
    if (!current) return
    patchConfig({ appRules: current.appRules.filter(rule => rule.exeName !== exeName) })
  }, [snapshot, patchConfig])

  if (loading) {
    return <div className="memory-loading">加载中…</div>
  }

  if (!snapshot) {
    return <div className="character-panel__error">{loadError ?? '加载窗口行为配置失败，请稍后重试'}</div>
  }

  const config = snapshot.config

  return (
    <div className="window-behavior-panel">
      <div className="window-behavior-panel__section">
        <div className="window-behavior-panel__section-label">聊天窗口置顶</div>
        <div className="character-panel__hint">只影响聊天窗口，不影响桌宠。</div>
        {CHAT_PIN_MODE_OPTIONS.map(option => (
          <label key={option.value} className="window-behavior-panel__choice">
            <input
              type="radio"
              name="chat-pin-mode"
              value={option.value}
              checked={config.chatPinMode === option.value}
              disabled={saving}
              onChange={() => patchConfig({ chatPinMode: option.value })}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>

      <div className="window-behavior-panel__section">
        <div className="window-behavior-panel__section-label">智能避让</div>
        <label className="window-behavior-panel__choice">
          <input
            type="checkbox"
            checked={config.petAvoidanceEnabled}
            disabled={saving}
            onChange={e => patchConfig({ petAvoidanceEnabled: e.target.checked })}
          />
          <span>开启</span>
        </label>
        <div className="character-panel__hint">
          {config.petAvoidanceEnabled
            ? '桌宠会避让全屏或指定应用，必要时自动移动到其他屏幕、贴边或暂时隐藏。'
            : '桌宠保持悬浮，但不会再自动避让其他应用。'}
        </div>
      </div>

      <div className="window-behavior-panel__section">
        <div className="window-behavior-panel__section-label">应用规则</div>
        <div className="character-panel__hint">
          为单个程序指定避让方式。「不避让」表示即使它全屏，桌宠也照常显示。
        </div>
        <div className="memory-list">
          {config.appRules.length === 0 && <div className="memory-empty">暂无</div>}
          {config.appRules.map(rule => (
            <div key={rule.exeName} className="window-behavior-panel__list-row">
              <span>{rule.exeName}</span>
              <div className="window-behavior-panel__list-actions">
                <select
                  className="window-behavior-panel__select"
                  value={rule.effect}
                  disabled={saving}
                  onChange={e => handleRuleEffectChange(rule.exeName, e.target.value as AppRuleEffect)}
                >
                  {APP_RULE_EFFECT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <button className="memory-btn memory-btn--danger" disabled={saving} onClick={() => handleRemoveRule(rule.exeName)}>删除</button>
              </div>
            </div>
          ))}
        </div>
        <button className="memory-btn" disabled={saving} onClick={handleAddRule}>添加</button>
      </div>

      {errorMessage && <div className="character-panel__error">{errorMessage}</div>}
    </div>
  )
}
