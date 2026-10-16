// src/i18n.ts — 渲染进程界面语言初始化：向主进程取当前界面语言，创建 i18next 实例并随主进程通知切换
// 用法：各窗口入口（main.tsx、settings/main.tsx、overlay/main.tsx、handle/main.ts）在挂载前 await initI18n()，把返回的实例交给 I18nextProvider；调 electronAPI.getUiLocale / onUiLocaleChanged
// 对应文件：shared/i18n/uiI18n.ts / shared/uiLocale.ts / src/electron-api.d.ts / electron/preload/index.ts / electron/main/index.ts
import type { i18n as I18nInstance } from 'i18next'
import { createUiI18n } from '../shared/i18n/uiI18n.js'
import type { UiLocale } from '../shared/uiLocale.js'

export async function initI18n(): Promise<I18nInstance> {
  let latest: UiLocale | null = null
  let instance: I18nInstance | null = null
  window.electronAPI.onUiLocaleChanged(locale => {
    latest = locale
    if (!instance) return
    void instance.changeLanguage(locale)
    document.documentElement.lang = locale
  })

  let locale: UiLocale = 'zh-CN'
  try {
    locale = await window.electronAPI.getUiLocale()
  } catch (err) {
    console.error('[I18n] Failed to get ui locale:', err)
  }
  const initial = latest ?? locale
  instance = createUiI18n(initial)
  document.documentElement.lang = initial
  return instance
}
