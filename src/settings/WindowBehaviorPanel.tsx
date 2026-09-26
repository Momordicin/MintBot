import React, { useCallback, useEffect, useRef, useState } from 'react'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'

type ChatPinMode = 'always' | 'smart' | 'off'
type AppRuleEffect = 'allow' | 'soft' | 'hard'

interface AppRule {
  exeName: string
  effect: AppRuleEffect
}

interface WindowBehaviorConfig {
  chatPinMode: ChatPinMode
  petAvoidanceEnabled: boolean
  appRules: AppRule[]
}

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
  const [config, setConfig] = useState<WindowBehaviorConfig | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const patchControllerRef = useRef<AbortController | null>(null)

  const configRef = useRef<WindowBehaviorConfig | null>(null)

  const applyConfig = useCallback((next: WindowBehaviorConfig) => {
    configRef.current = next
    setConfig(next)
  }, [])

  useEffect(() => {
    return () => {
      patchControllerRef.current?.abort()
    }
  }, [])

  const fetchConfig = useCallback(async () => {
    const response = await fetch(`${CORE_URL}/config/window-behavior`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as WindowBehaviorConfig
  }, [])

  useEffect(() => {
    fetchConfig()
      .then(applyConfig)
      .catch(() => setLoadError('加载窗口行为配置失败，请稍后重试'))
      .finally(() => setLoading(false))
  }, [fetchConfig, applyConfig])

  useEffect(() => {
    const source = new EventSource(`${CORE_URL}/events`)
    source.addEventListener('window-behavior-changed', (event: MessageEvent) => {
      try {
        applyConfig(JSON.parse(event.data))
      } catch {
      }
    })
    return () => {
      source.close()
    }
  }, [applyConfig])

  const patchConfig = useCallback(async (partial: Partial<WindowBehaviorConfig>) => {
    const base = configRef.current
    if (!base) return

    patchControllerRef.current?.abort()
    const controller = new AbortController()
    patchControllerRef.current = controller
    setErrorMessage(null)

    applyConfig({ ...base, ...partial })

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

      const data: WindowBehaviorConfig = await response.json()
      if (controller.signal.aborted) return
      applyConfig(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setErrorMessage(err instanceof Error ? err.message : '保存窗口行为配置失败，请稍后重试')

      if (patchControllerRef.current !== controller) return
      fetchConfig()
        .then(applyConfig)
        .catch(() => {
        })
    }
  }, [applyConfig, fetchConfig])

  const handleAddRule = useCallback(async () => {
    const result = await window.electronAPI.selectExeFile()
    if (!result) return

    const current = configRef.current
    if (!current) return

    const lower = result.filename.toLowerCase()
    if (current.appRules.some(rule => rule.exeName.toLowerCase() === lower)) return

    patchConfig({ appRules: [...current.appRules, { exeName: result.filename, effect: 'soft' }] })
  }, [patchConfig])

  const handleRuleEffectChange = useCallback((exeName: string, effect: AppRuleEffect) => {
    const current = configRef.current
    if (!current) return
    patchConfig({ appRules: current.appRules.map(rule => (rule.exeName === exeName ? { ...rule, effect } : rule)) })
  }, [patchConfig])

  const handleRemoveRule = useCallback((exeName: string) => {
    const current = configRef.current
    if (!current) return
    patchConfig({ appRules: current.appRules.filter(rule => rule.exeName !== exeName) })
  }, [patchConfig])

  if (loading) {
    return <div className="memory-loading">加载中…</div>
  }

  if (loadError || !config) {
    return <div className="character-panel__error">{loadError ?? '加载窗口行为配置失败，请稍后重试'}</div>
  }

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
                  onChange={e => handleRuleEffectChange(rule.exeName, e.target.value as AppRuleEffect)}
                >
                  {APP_RULE_EFFECT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <button className="memory-btn memory-btn--danger" onClick={() => handleRemoveRule(rule.exeName)}>删除</button>
              </div>
            </div>
          ))}
        </div>
        <button className="memory-btn" onClick={handleAddRule}>添加</button>
      </div>

      {errorMessage && <div className="character-panel__error">{errorMessage}</div>}
    </div>
  )
}
