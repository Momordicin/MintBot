// shared/uiLocale.ts — 界面语言设置值与实际界面语言的换算：resolveUiLocale(setting, systemLocale)
// 用法：services/core 的 /config/ui 校验与 electron/main/index.ts、src/i18n.ts 都从这里 import；VALID_UI_LANGUAGES 为 PATCH 的合法取值
// 对应文件：services/core/config/index.ts / services/core/routes/ui.ts / shared/i18n/uiI18n.ts / electron/main/i18n.ts / src/i18n.ts / src/settings/GeneralPanel.tsx
export type UiLanguage = 'system' | 'zh-CN' | 'en'
export type UiLocale = 'zh-CN' | 'en'

export const VALID_UI_LANGUAGES: readonly UiLanguage[] = ['system', 'zh-CN', 'en']

export function resolveUiLocale(setting: UiLanguage, systemLocale: string): UiLocale {
  if (setting !== 'system') return setting
  return systemLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}
