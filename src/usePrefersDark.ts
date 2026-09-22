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
