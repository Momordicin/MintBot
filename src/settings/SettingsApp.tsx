// src/settings/SettingsApp.tsx — 设置窗口根组件：加载当前预设并按其显示配置应用主题色，顶部自绘标题栏，左栏角色下拉框与导航切换"角色 / 外观 / 人设与模型 / 记忆 / 模型服务 / 联网搜索 / 窗口行为 / 语音 / 插件 / 通用"九个页面
// 用法：settings/main.tsx 渲染 <SettingsApp />；GET /state；调 electronAPI.onWindowHidden / onWindowShown / setTitlebarOverlay；useWindowReveal(ready, contentReady)；useCharacterPanel 通过 onSwitched 回传新的 AppState，记忆页把 sessionId 传给 MemoryPanel
// 对应文件：src/settings/main.tsx / src/settings/useCharacterPanel.ts / src/settings/CharacterPanel.tsx / src/settings/AppearancePanel.tsx / src/settings/PersonaModelPanel.tsx / src/settings/ModelConfigPanel.tsx / src/settings/WebSearchPanel.tsx / src/settings/WindowBehaviorPanel.tsx / src/settings/GeneralPanel.tsx / src/settings/VoicePanel.tsx / src/settings/PluginsPanel.tsx / src/settings/memory/MemoryPanel.tsx / src/settings/settings.css / src/chat/theme.ts / src/chat/themeVars.ts / services/core/index.ts / src/useWindowReveal.ts / electron/main/index.ts（open-settings-window / titlebar:set-overlay）
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppState } from '../../shared/types/index.js'
import { deriveTheme } from '../chat/theme.js'
import { DEFAULT_CHAT_BG_OPACITY, DEFAULT_THEME_INPUT, resolveThemeMode, themeCssVars, titlebarOverlayFromTheme } from '../chat/themeVars.js'
import { usePrefersDark } from '../usePrefersDark.js'
import { useWindowReveal } from '../useWindowReveal.js'
import { AppearancePanel } from './AppearancePanel'
import { CharacterPanel } from './CharacterPanel'
import { MemoryPanel } from './memory/MemoryPanel'
import { ModelConfigPanel } from './ModelConfigPanel'
import { WebSearchPanel } from './WebSearchPanel'
import { PersonaModelPanel } from './PersonaModelPanel'
import { useCharacterPanel } from './useCharacterPanel'
import { WindowBehaviorPanel } from './WindowBehaviorPanel'
import { GeneralPanel } from './GeneralPanel'
import { VoicePanel } from './VoicePanel'
import { PluginsPanel } from './PluginsPanel'
import { useTranslation } from 'react-i18next'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'

type Page = 'character' | 'appearance' | 'persona' | 'memory' | 'modelService' | 'webSearch' | 'window' | 'voice' | 'plugins' | 'general'

const PRIMARY_NAV: Page[] = ['character', 'appearance', 'persona', 'memory']

const SECONDARY_NAV: Page[] = ['modelService', 'webSearch', 'window', 'voice', 'plugins']

function SettingsTitleBar() {
  const { t } = useTranslation()
  return <div className="settings-titlebar">{t('MintBot 设置')}</div>
}

interface SettingsBodyProps {
  appState: AppState | null
  onSwitched: (state: AppState) => void
}

function SettingsBody({ appState, onSwitched }: SettingsBodyProps) {
  const { t } = useTranslation()
  const [activePage, setActivePage] = useState<Page>('character')
  const presetSnapshot = appState?.presetSnapshot ?? null
  const panel = useCharacterPanel({ presetSnapshot, onSwitched })
  const { presets, switchPreset, switchError, deleteTarget, isDeleting, isRenaming, isSavingRename } = panel

  const navLocked = panel.roleConfigStatus !== 'idle'

  const navigateTo = (page: Page) => {
    if (page !== 'character' && navLocked) return
    if (page !== 'character') {
      if (isRenaming && !isSavingRename) panel.handleRenameCancel()
      if (deleteTarget !== null && !isDeleting) panel.handleDeleteCancel()
    }
    setActivePage(page)
  }

  const navLabel = (page: Page): string => {
    switch (page) {
      case 'character': return t('角色')
      case 'appearance': return t('外观')
      case 'persona': return t('人设与模型')
      case 'memory': return t('记忆')
      case 'modelService': return t('全局模型服务')
      case 'webSearch': return t('联网搜索')
      case 'window': return t('窗口行为')
      case 'voice': return t('语音')
      case 'plugins': return t('插件')
      case 'general': return t('通用')
    }
  }

  const renderNavItem = (page: Page) => (
    <button
      key={page}
      className={`settings-nav-item${activePage === page ? ' settings-nav-item--active' : ''}`}
      disabled={page !== 'character' && navLocked}
      onClick={() => navigateTo(page)}
    >
      {navLabel(page)}
    </button>
  )

  return (
    <div className="settings-window">
      <SettingsTitleBar />
      <div className="settings-main">
        <div className="settings-sidebar">
          {presets.length > 0 && (
            <select
              className="settings-sidebar__preset"
              value={presetSnapshot?.presetId ?? ''}
              onChange={e => switchPreset(e.target.value)}
              disabled={deleteTarget !== null || isDeleting || isRenaming || isSavingRename || navLocked}
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
            {renderNavItem('general')}
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
          {activePage === 'memory' && <MemoryPanel sessionId={appState?.sessionId ?? null} assistantName={appState?.presetSnapshot?.name ?? ''} />}
          {activePage === 'modelService' && <ModelConfigPanel />}
          {activePage === 'webSearch' && <WebSearchPanel />}
          {activePage === 'window' && <WindowBehaviorPanel />}
          {activePage === 'voice' && <VoicePanel />}
          {activePage === 'plugins' && <PluginsPanel />}
          {activePage === 'general' && <GeneralPanel />}
        </div>
      </div>
    </div>
  )
}

export function SettingsApp() {
  const { t } = useTranslation()
  const hasFetched = useRef(false)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [error, setError] = useState(false)
  const [hidden, setHidden] = useState(false)
  const hiddenRef = useRef(false)
  const hideSeqRef = useRef(0)

  const loadState = useCallback(() => {
    setError(false)
    return fetch(`${CORE_URL}/state`)
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

  useEffect(() => window.electronAPI.onWindowHidden(() => {
    hiddenRef.current = true
    hideSeqRef.current += 1
    setHidden(true)
  }), [])

  useEffect(() => window.electronAPI.onWindowShown(() => {
    if (!hiddenRef.current) return
    hiddenRef.current = false
    const seq = hideSeqRef.current
    loadState().finally(() => {
      if (hideSeqRef.current === seq) setHidden(false)
    })
  }), [loadState])

  useEffect(() => {
    document.title = t('MintBot 设置')
  }, [t])

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

  useEffect(() => {
    window.electronAPI.setTitlebarOverlay(titlebarOverlayFromTheme(theme))
  }, [theme])

  useWindowReveal(appState !== null || error, !hidden)

  if (hidden) {
    return (
      <div className="settings-window">
        <SettingsTitleBar />
      </div>
    )
  }

  if (error) {
    return (
      <div className="settings-window">
        <SettingsTitleBar />
        <div className="settings-error">
          <p className="settings-error-text">{t('无法连接核心服务')}</p>
          <button className="settings-retry-btn" onClick={loadState}>{t('重试')}</button>
        </div>
      </div>
    )
  }

  return <SettingsBody appState={appState} onSwitched={setAppState} />
}
