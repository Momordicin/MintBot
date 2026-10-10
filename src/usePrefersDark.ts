// src/usePrefersDark.ts — 读取并监听系统是否为深色模式的 React hook
// 用法：usePrefersDark() 返回 boolean（matchMedia "(prefers-color-scheme: dark)"，随系统切换更新）；ChatWindow、SettingsApp、CharacterPanel 用它解析 themeMode 为 auto 时的日夜模式
// 对应文件：src/chat/themeVars.ts（resolveThemeMode）/ src/chat/ChatWindow.tsx / src/settings/SettingsApp.tsx / src/settings/CharacterPanel.tsx
import { useEffect, useState } from 'react'

const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)'

export function usePrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia(PREFERS_DARK_QUERY).matches)

  useEffect(() => {
    const mql = window.matchMedia(PREFERS_DARK_QUERY)
    const handler = (e: MediaQueryListEvent) => setPrefersDark(e.matches)
    setPrefersDark(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return prefersDark
}
