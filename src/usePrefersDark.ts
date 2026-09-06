import { useEffect, useState } from 'react'

// 系统深色模式偏好检测：聊天窗口（chat/ChatWindow.tsx）与设置窗口的主题实时预览
// （settings/CharacterPanel.tsx）都需要把 'auto' 解析成具体的 'day'/'night'，这个 hook
// 因此不属于任何一个具体窗口的领域，放在 src 顶层、两边平级 import。themeVars.ts 的
// resolveThemeMode 只负责解析、不碰 DOM（该文件头部注释：deliberately React-/DOM-free），
// 真正读 matchMedia 的这一半必须留在这里
const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)'

// Electron 的 nativeTheme 驱动这个 matchMedia 查询，订阅 'change' 事件即可让 'auto'
// 跟随系统实时切换；卸载时必须移除监听器，否则每次挂载都会叠加一个不会被回收的
// MediaQueryList 监听
export function usePrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia(PREFERS_DARK_QUERY).matches)

  useEffect(() => {
    const mql = window.matchMedia(PREFERS_DARK_QUERY)
    const handler = (e: MediaQueryListEvent) => setPrefersDark(e.matches)
    // 订阅前先对一次当前值：useState 的惰性初始化在首次渲染时读了一次 matches，而这个
    // effect 要到提交之后才跑。两者之间系统若恰好翻转，那次 change 事件已经错过了，而
    // addEventListener 只负责之后的变化——状态会一直停在错的值上，直到下一次真正切换。
    // 窗口只有一个 tick，但代价只是一次同值 setState（React 会自行 bail out，不触发重渲染）
    setPrefersDark(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return prefersDark
}
