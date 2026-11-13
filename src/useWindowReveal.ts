// src/useWindowReveal.ts — 子窗口页面就绪与每次显示后画好的通知 React hook
// 用法：useWindowReveal(ready, contentReady)；调 electronAPI.notifyWindowReady / onWindowShown / notifyWindowPainted；SettingsApp 使用
// 对应文件：src/settings/SettingsApp.tsx / electron/preload/index.ts / electron/main/windowReveal.ts / electron/main/index.ts（window:ready / window:painted）
import { useEffect, useRef, useState } from 'react'

export function useWindowReveal(ready: boolean, contentReady: boolean): void {
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
    if (shownToken === 0 || !contentReady || paintedTokenRef.current === shownToken) return
    let innerFrame = 0
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        innerFrame = 0
        if (paintedTokenRef.current === shownToken) return
        paintedTokenRef.current = shownToken
        window.electronAPI.notifyWindowPainted()
      })
    })
    return () => {
      cancelAnimationFrame(outerFrame)
      if (innerFrame) cancelAnimationFrame(innerFrame)
    }
  }, [shownToken, contentReady])
}
