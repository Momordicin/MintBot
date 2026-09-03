import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/types/index.js'
import { CharacterPanel } from './CharacterPanel'
import { MemoryPanel } from './memory/MemoryPanel'
import { ModelConfigPanel } from './ModelConfigPanel'
import { WindowBehaviorPanel } from './WindowBehaviorPanel'
import './settings.css'

const CORE_URL = 'http://127.0.0.1:3000'

type Tab = 'character' | 'memory' | 'model' | 'window'

export function SettingsApp() {
  const hasFetched = useRef(false)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [error, setError] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('character')

  const loadState = useCallback(() => {
    setError(false)
    fetch(`${CORE_URL}/state`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((state: AppState) => {
        setAppState(state)
      })
      .catch(() => {
        setError(true)
      })
  }, [])

  useEffect(() => {
    if (hasFetched.current) return
    hasFetched.current = true
    loadState()
  }, [loadState])

  if (error) {
    return (
      <div className="settings-window settings-window--error">
        <p className="settings-error-text">无法连接核心服务</p>
        <button className="settings-retry-btn" onClick={loadState}>重试</button>
      </div>
    )
  }

  return (
    <div className="settings-window">
      <div className="settings-current-preset">
        当前角色：{appState?.presetSnapshot?.name ?? '...'}
      </div>

      <div className="settings-tabs">
        <button
          className={`settings-tab${activeTab === 'character' ? ' settings-tab--active' : ''}`}
          onClick={() => setActiveTab('character')}
        >
          角色设定
        </button>
        <button
          className={`settings-tab${activeTab === 'memory' ? ' settings-tab--active' : ''}`}
          onClick={() => setActiveTab('memory')}
        >
          记忆管理
        </button>
        <button
          className={`settings-tab${activeTab === 'model' ? ' settings-tab--active' : ''}`}
          onClick={() => setActiveTab('model')}
        >
          模型配置
        </button>
        <button
          className={`settings-tab${activeTab === 'window' ? ' settings-tab--active' : ''}`}
          onClick={() => setActiveTab('window')}
        >
          窗口行为
        </button>
      </div>

      <div className="settings-panel">
        {activeTab === 'character' && (
          <CharacterPanel presetSnapshot={appState?.presetSnapshot ?? null} onSwitched={setAppState} />
        )}
        {activeTab === 'memory' && <MemoryPanel sessionId={appState?.sessionId ?? null} />}
        {activeTab === 'model' && <ModelConfigPanel />}
        {activeTab === 'window' && <WindowBehaviorPanel />}
      </div>
    </div>
  )
}
