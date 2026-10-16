// src/settings/GeneralPanel.tsx — 设置窗口的"通用"面板：界面语言选择（跟随系统 / 中文 / English）
// 用法：SettingsApp 里渲染 <GeneralPanel />；GET、PATCH /config/ui
// 对应文件：shared/uiLocale.ts / src/i18n.ts / src/errorText.ts / services/core/routes/ui.ts / src/settings/SettingsApp.tsx
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'
import type { UiLanguage } from '../../shared/uiLocale.js'
import { isErrorBody } from '../../shared/errorCodes.js'
import { errorText } from '../errorText.js'

export function GeneralPanel() {
  const { t } = useTranslation()
  const [language, setLanguage] = useState<UiLanguage | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${CORE_URL}/config/ui`)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((payload: { language: UiLanguage }) => setLanguage(payload.language))
      .catch(() => setLoadFailed(true))
  }, [])

  const handleChange = async (next: UiLanguage) => {
    setSaving(true)
    setErrorMessage(null)
    try {
      const response = await fetch(`${CORE_URL}/config/ui`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: next }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(isErrorBody(payload) ? errorText(payload, t) : `HTTP ${response.status}`)
      }
      setLanguage(next)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t('保存界面语言失败，请稍后重试'))
    } finally {
      setSaving(false)
    }
  }

  if (loadFailed) return <div className="character-panel__error">{t('加载界面语言失败，请稍后重试')}</div>
  if (language === null) return <div className="memory-loading">{t('加载中…')}</div>

  return (
    <div className="window-behavior-panel">
      <div className="window-behavior-panel__section">
        <div className="window-behavior-panel__section-label">{t('界面语言')}</div>
        <select
          className="window-behavior-panel__select"
          value={language}
          disabled={saving}
          onChange={e => handleChange(e.target.value as UiLanguage)}
        >
          <option value="system">{t('跟随系统')}</option>
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </select>
      </div>
      {errorMessage && <div className="character-panel__error">{errorMessage}</div>}
    </div>
  )
}
