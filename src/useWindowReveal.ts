// src/useWindowReveal.ts — 子窗口每次显示后画好再淡入的 React hook
// 用法：useWindowReveal(ready)：ready 首次为 true 时调一次 electronAPI.notifyWindowReady；每次收到 onWindowShown 后等两帧调一次 notifyWindowPainted；SettingsApp 使用
// 对应文件：src/settings/SettingsApp.tsx / electron/preload/index.ts / electron/main/windowReveal.ts / electron/main/index.ts（window:ready / window:painted）
import { useEffect, useRef, useState } from 'react'

export function useWindowReveal(ready: boolean): void {
  const readyNotifiedRef = useRef(false)
  const paintedTokenRef = useRef(0)
  const [shownToken, setShownToken] = useState(0)

  useEffect(() => window.electronAPI.onWindowShown(() => {
    setShownToken(token => token + 1)
  }), [])

  useEffect(() => {
    if (!ready || readyNotifiedRef.current) return
    readyNotifiedRef.current = true
    const markShown = () => setShownToken(token => Math.max(token, 1))
    window.electronAPI.notifyWindowReady().then(markShown, markShown)
  }, [ready])

  useEffect(() => {
    if (shownToken === 0 || paintedTokenRef.current === shownToken) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (paintedTokenRef.current === shownToken) return
      paintedTokenRef.current = shownToken
      window.electronAPI.notifyWindowPainted()
    }))
  }, [shownToken])
}
