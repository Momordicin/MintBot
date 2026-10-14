// src/settings/SettingsApp.tsx — 设置窗口根组件：加载当前预设并按其显示配置应用主题色，左栏角色下拉框与导航切换"角色 / 外观 / 人设与模型 / 记忆 / 模型服务 / 窗口行为"六个页面
// 用法：settings/main.tsx 渲染 <SettingsApp />；GET /state；useCharacterPanel 通过 onSwitched 回传新的 AppState，记忆页把 sessionId 传给 MemoryPanel
// 对应文件：src/settings/main.tsx / src/settings/useCharacterPanel.ts / src/settings/CharacterPanel.tsx / src/settings/AppearancePanel.tsx / src/settings/PersonaModelPanel.tsx / src/settings/ModelConfigPanel.tsx / src/settings/WindowBehaviorPanel.tsx / src/settings/memory/MemoryPanel.tsx / src/settings/settings.css / src/chat/theme.ts / src/chat/themeVars.ts / services/core/index.ts / electron/main/index.ts（open-settings-window）
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppState } from '../../shared/types/index.js'
import { deriveTheme } from '../chat/theme.js'
import { DEFAULT_CHAT_BG_OPACITY, DEFAULT_THEME_INPUT, resolveThemeMode, themeCssVars } from '../chat/themeVars.js'
import { usePrefersDark } from '../usePrefersDark.js'
import { AppearancePanel } from './AppearancePanel'
import { CharacterPanel } from './CharacterPanel'
import { MemoryPanel } from './memory/MemoryPanel'
import { ModelConfigPanel } from './ModelConfigPanel'
import { PersonaModelPanel } from './PersonaModelPanel'
import { useCharacterPanel } from './useCharacterPanel'
import { WindowBehaviorPanel } from './WindowBehaviorPanel'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'

type Page = 'character' | 'appearance' | 'persona' | 'memory' | 'modelService' | 'window'

const PRIMARY_NAV: { page: Page; label: string }[] = [
  { page: 'character', label: '角色' },
  { page: 'appearance', label: '外观' },
  { page: 'persona', label: '人设与模型' },
  { page: 'memory', label: '记忆' },
]

const SECONDARY_NAV: { page: Page; label: string }[] = [
  { page: 'modelService', label: '全局模型服务' },
  { page: 'window', label: '窗口行为' },
]

interface SettingsBodyProps {
  appState: AppState | null
  onSwitched: (state: AppState) => void
}

function SettingsBody({ appState, onSwitched }: SettingsBodyProps) {
  const [activePage, setActivePage] = useState<Page>('character')
  const presetSnapshot = appState?.presetSnapshot ?? null
  const panel = useCharacterPanel({ presetSnapshot, onSwitched })
  const { presets, switchPreset, switchError, deleteTarget, isDeleting, isRenaming, isSavingRename } = panel

  const navigateTo = (page: Page) => {
    if (page !== 'character') {
      if (isRenaming && !isSavingRename) panel.handleRenameCancel()
      if (deleteTarget !== null && !isDeleting) panel.handleDeleteCancel()
    }
    setActivePage(page)
  }

  const renderNavItem = ({ page, label }: { page: Page; label: string }) => (
    <button
      key={page}
      className={`settings-nav-item${activePage === page ? ' settings-nav-item--active' : ''}`}
      onClick={() => navigateTo(page)}
    >
      {label}
    </button>
  )

  return (
    <div className="settings-window">
      <div className="settings-sidebar">
        {presets.length > 0 && (
          <select
            className="settings-sidebar__preset"
            value={presetSnapshot?.presetId ?? ''}
            onChange={e => switchPreset(e.target.value)}
            disabled={deleteTarget !== null || isDeleting || isRenaming || isSavingRename}
          >
            {presets.map(p => (
              <option key={p.presetId} value={p.presetId}>{p.name}</option>
            ))}
          </select>
        )}
        {switchError && <div className="character-panel__error">{switchError}</div>}
        <nav className="settings-nav">
          {PRIMARY_NAV.map(renderNavItem)}
          <div className="settings-nav-divider" />
          {SECONDARY_NAV.map(renderNavItem)}
        </nav>
      </div>

      <div className="settings-panel">
        <div hidden={activePage !== 'character'}>
          <CharacterPanel panel={panel} />
        </div>
        <div hidden={activePage !== 'appearance'}>
          <AppearancePanel panel={panel} />
        </div>
        <div hidden={activePage !== 'persona'}>
          <PersonaModelPanel panel={panel} />
        </div>
        {activePage === 'memory' && <MemoryPanel sessionId={appState?.sessionId ?? null} />}
        {activePage === 'modelService' && <ModelConfigPanel />}
        {activePage === 'window' && <WindowBehaviorPanel />}
      </div>
    </div>
  )
}

export function SettingsApp() {
  const hasFetched = useRef(false)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [error, setError] = useState(false)

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

  return <SettingsBody appState={appState} onSwitched={setAppState} />
}
