// shared/i18n/uiI18n.ts — 界面文案的 i18next 实例工厂：内置中英目录，中文原文作 key
// 用法：electron/main/i18n.ts 与 src/i18n.ts 各调一次 createUiI18n(locale) 得到自己的实例
// 对应文件：shared/i18n/zh-CN.json / shared/i18n/en.json / shared/uiLocale.ts / electron/main/i18n.ts / src/i18n.ts / i18next.config.ts
import i18next from 'i18next'
import type { i18n } from 'i18next'
import zhCN from './zh-CN.json' with { type: 'json' }
import en from './en.json' with { type: 'json' }
import type { UiLocale } from '../uiLocale.js'

export function createUiI18n(locale: UiLocale): i18n {
  const instance = i18next.createInstance()
  void instance.init({
    resources: {
      'zh-CN': { translation: zhCN },
      en: { translation: en },
    },
    lng: locale,
    fallbackLng: 'zh-CN',
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
  })
  instance.services.formatter?.add('lowercase', value => String(value).toLowerCase())
  return instance
}
