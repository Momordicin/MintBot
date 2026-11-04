// src/settings/UserProfilePanel.tsx — "用户资料"页：只读显示角色在对话中记下的用户所在地、坐标、时区、精确地址、原话与记下时间
// 用法：SettingsApp 在 activePage === 'userProfile' 时渲染 <UserProfilePanel />；GET /user-profile
// 对应文件：src/settings/SettingsApp.tsx / services/core/routes/userProfile.ts
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CORE_URL } from '../coreUrl.js'

interface UserProfileLocation {
  value: string
  userInput: string
  recordedAt: string
  nameZh: string | null
  latitude: number | null
  longitude: number | null
  timezone: string | null
  exactAddress: string | null
}

interface UserProfileResponse {
  location: UserProfileLocation | null
}

export function UserProfilePanel() {
  const { t, i18n } = useTranslation()
  const [location, setLocation] = useState<UserProfileLocation | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setIsLoading(true)
    setHasError(false)

    fetch(`${CORE_URL}/user-profile`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((profile: UserProfileResponse) => setLocation(profile.location))
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setHasError(true)
      })
      .finally(() => {
        if (controller.signal.aborted) return
        setIsLoading(false)
      })
  }, [])

  useEffect(() => {
    load()
    return () => controllerRef.current?.abort()
  }, [load])

  return (
    <div className="memory-list">
      {hasError && (
        <div className="character-panel__error">
          {t('加载用户资料失败')}{' '}
          <button className="memory-btn" onClick={load}>{t('重试')}</button>
        </div>
      )}
      {isLoading && <div className="memory-loading">{t('加载中…')}</div>}
      {!isLoading && !hasError && location === null && (
        <div className="memory-empty">{t('还没有记下所在地')}</div>
      )}
      {!isLoading && !hasError && location !== null && (
        <div className="memory-list-row">
          <div className="memory-list-row__content">{t('所在地：{{value}}', { value: i18n.language.startsWith('zh') ? (location.nameZh ?? location.value) : location.value })}</div>
          {location.latitude !== null && location.longitude !== null && (
            <div className="memory-list-row__content">{t('坐标：{{value}}', { value: `${location.latitude}, ${location.longitude}` })}</div>
          )}
          {location.timezone !== null && (
            <div className="memory-list-row__content">{t('时区：{{value}}', { value: location.timezone })}</div>
          )}
          {location.exactAddress !== null && (
            <div className="memory-list-row__content">{t('精确地址：{{value}}', { value: location.exactAddress })}</div>
          )}
          <div className="memory-list-row__content">{t('你的原话：{{value}}', { value: location.userInput })}</div>
          <div className="memory-list-row__content">{t('记下时间：{{value}}', { value: new Date(location.recordedAt).toLocaleString(i18n.language) })}</div>
        </div>
      )}
    </div>
  )
}
