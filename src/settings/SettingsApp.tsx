// src/settings/SettingsApp.tsx — 设置窗口根组件：加载当前预设并按其显示配置应用主题色，提供"角色设定 / 记忆管理 / 模型配置 / 窗口行为"四个标签页
// 用法：settings/main.tsx 渲染 <SettingsApp />；GET /state；CharacterPanel 通过 onSwitched 回传新的 AppState，记忆管理标签把 sessionId 传给 MemoryPanel
// 对应文件：src/settings/main.tsx / src/settings/CharacterPanel.tsx / src/settings/ModelConfigPanel.tsx / src/settings/WindowBehaviorPanel.tsx / src/settings/memory/MemoryPanel.tsx / src/settings/settings.css / src/chat/theme.ts / src/chat/themeVars.ts / services/core/index.ts / electron/main/index.ts（open-settings-window）
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppState } from '../../shared/types/index.js'
import { deriveTheme } from '../chat/theme.js'
import { DEFAULT_CHAT_BG_OPACITY, DEFAULT_THEME_INPUT, resolveThemeMode, themeCssVars } from '../chat/themeVars.js'
import { usePrefersDark } from '../usePrefersDark.js'
import { CharacterPanel } from './CharacterPanel'
import { MemoryPanel } from './memory/MemoryPanel'
import { ModelConfigPanel } from './ModelConfigPanel'
import { WindowBehaviorPanel } from './WindowBehaviorPanel'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'

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

  const prefersDark = usePrefersDark()
  const displayConfig = appState?.presetSnapshot?.displayConfig
  const resolvedMode = displayConfig ? resolveThemeMode(displayConfig.themeMode, prefersDark) : DEFAULT_THEME_INPUT.mode
  const theme = useMemo(() => {
    if (!displayConfig) return deriveTheme(DEFAULT_THEME_INPUT)
    return deriveTheme({
      accentRgb: displayConfig.accentRgb,
      mode: resolvedMode,
      tintStrength: displayConfig.tintStrength,
    })
  }, [displayConfig, resolvedMode])
  const chatBgOpacity = displayConfig?.chatBgOpacity ?? DEFAULT_CHAT_BG_OPACITY

  useLayoutEffect(() => {
    const root = document.documentElement
    const vars = themeCssVars(theme, chatBgOpacity)
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value)
    }
    root.style.colorScheme = resolvedMode === 'day' ? 'light' : 'dark'
  }, [theme, chatBgOpacity, resolvedMode])

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
