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

  // 把设置窗口也接到主题上：用的是"当前激活角色"（appState.presetSnapshot.displayConfig，
  // 与 GET /state 返给聊天窗口的是同一份快照），不是 CharacterPanel 里用户正在浏览/编辑的
  // 那个 preset——两者可能是不同的 preset（浏览别的角色的设置，不该重绘整个窗口），
  // CharacterPanel 自己另开一份 previewTheme 只作用于 .character-panel__theme-preview
  // 这个子树，见该文件与 settings.css 里的说明。
  // 下面这段与 ChatWindow.tsx 的同名 effect 逐行同构（同一套 deriveTheme/themeCssVars/
  // resolveThemeMode/DEFAULT_THEME_INPUT 兜底值），不是另起的变体：两个窗口要看起来一样，
  // 就不能各自独立实现一遍"要不要染色/兜底成什么"这些判断
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

  // 挂在 document.documentElement 上而不是 .settings-window 根 div 的内联 style——原因与
  // ChatWindow.tsx 完全一致：global.css 的 `html, body, #root { color: ... }` 是这个根 div
  // 的祖先，内联样式到不了祖先。用 useLayoutEffect 避免每次主题变化都闪一下 global.css 的
  // 占位色。error 分支（无法连接核心服务、appState 仍是 null）也要吃到这份兜底主题——
  // displayConfig 缺失时 deriveTheme(DEFAULT_THEME_INPUT) 与 ChatWindow.tsx 同一条兜底路径
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
