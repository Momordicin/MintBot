// electron/main/i18n.ts — 主进程界面语言：持有唯一的 i18next 实例与当前界面语言，读取 core 的 ui 设置
// 用法：index.ts 引用 i18n / readUiLanguage / setMainLanguage / getMainLocale；GET /config/ui；通道 ui:get-locale / ui:locale-changed
// 对应文件：shared/i18n/uiI18n.ts / shared/uiLocale.ts / electron/main/index.ts / electron/main/coreEventsConsumer.ts / services/core/routes/ui.ts
import { app } from 'electron'
import type { i18n as I18nInstance } from 'i18next'
import { createUiI18n } from '../../shared/i18n/uiI18n.js'
import { resolveUiLocale } from '../../shared/uiLocale.js'
import type { UiLanguage, UiLocale } from '../../shared/uiLocale.js'
import { CORE_URL } from './coreUrl'

const UI_LANGUAGE_FETCH_TIMEOUT_MS = 3000

export const i18n: I18nInstance = createUiI18n('zh-CN')

export function getMainLocale(): UiLocale {
  return i18n.language as UiLocale
}

export function setMainLanguage(language: UiLanguage): boolean {
  const locale = resolveUiLocale(language, app.getLocale())
  if (locale === getMainLocale()) return false
  void i18n.changeLanguage(locale)
  return true
}

export async function readUiLanguage(): Promise<UiLanguage> {
  try {
    const response = await fetch(`${CORE_URL}/config/ui`, { signal: AbortSignal.timeout(UI_LANGUAGE_FETCH_TIMEOUT_MS) })
    if (response.ok) {
      return ((await response.json()) as { language: UiLanguage }).language
    }
    console.error('[I18n] Core rejected ui language fetch:', response.status)
  } catch (err) {
    console.error('[I18n] Failed to fetch ui language:', err)
  }
  return 'system'
}
