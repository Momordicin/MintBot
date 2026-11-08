// src/settings/PluginsPanel.tsx — 设置窗口的"插件"面板：每个可安装插件的版本、安装 / 更新、重启提示、未启用原因与"仍然启用"及其加载失败后的"取消加载"、配置项
// 用法：SettingsApp 里渲染 <PluginsPanel />；GET /plugins、GET /plugins/:name/latest、POST /plugins/:name/install、POST /plugins/:name/force-enable、POST /plugins/:name/cancel-force-enable、PUT /plugins/:name/config、GET /events 的 plugins-changed；electronAPI.getRelaunchInfo / relaunchApp
// 对应文件：src/settings/SettingsApp.tsx / src/errorText.ts / services/core/plugins/routes.ts / services/core/plugins/manager.ts / electron/main/index.ts
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'
import { createWatchdogEventSource } from '../eventsWatchdog.js'
import { isErrorBody, type ErrorBody } from '../../shared/errorCodes.js'
import { errorText } from '../errorText.js'

interface ConfigSchemaItem {
  description?: string
  type?: string
  hint?: string
}

interface PluginInfo {
  name: string
  displayName: string
  installed: boolean
  version: string | null
  status: { state: 'idle' | 'installing' | 'failed'; errorCode?: string }
  enabled: boolean
  disabled:
    | { reason: 'version_incompatible'; range: string; mintbotVersion: string }
    | { reason: 'version_invalid'; range: string }
    | { reason: 'load_failed' }
    | { reason: 'load_failed'; forced: true; message: string }
    | null
  forced: boolean
  needsRestart: boolean
  tools: string[]
  configSchema: Record<string, ConfigSchemaItem> | null
  config: Record<string, unknown> | null
}

type LatestVersion = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; version: string }

function isNewerVersion(latest: string, installed: string): boolean {
  const dotted = /^\d+(\.\d+)*$/
  if (!dotted.test(latest) || !dotted.test(installed)) return false
  const a = latest.split('.').map(Number)
  const b = installed.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

function PluginCard({
  plugin,
  latest,
  relaunchAvailable,
}: {
  plugin: PluginInfo
  latest: LatestVersion
  relaunchAvailable: boolean | null
}) {
  const { t } = useTranslation()
  const [requesting, setRequesting] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [restartDismissed, setRestartDismissed] = useState(false)
  const [relaunching, setRelaunching] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setRequestError(null)
  }, [plugin.status.state])

  const configKey = JSON.stringify(plugin.config)
  useEffect(() => {
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(plugin.config ?? {})) {
      if (typeof value === 'string') next[key] = value
    }
    setDrafts(next)
  }, [configKey])

  const failureText = async (response: Response): Promise<string> => {
    const payload: unknown = await response.json().catch(() => null)
    return isErrorBody(payload) ? errorText(payload as ErrorBody, t) : `HTTP ${response.status}`
  }

  const install = async () => {
    setRequesting(true)
    setRequestError(null)
    try {
      const response = await fetch(`${CORE_URL}/plugins/${plugin.name}/install`, { method: 'POST' })
      if (!response.ok) setRequestError(await failureText(response))
    } catch {
      setRequestError(t('操作失败，请稍后重试'))
    } finally {
      setRequesting(false)
    }
  }

  const forceEnable = async () => {
    setRequesting(true)
    setRequestError(null)
    try {
      const response = await fetch(`${CORE_URL}/plugins/${plugin.name}/force-enable`, { method: 'POST' })
      if (!response.ok) setRequestError(await failureText(response))
    } catch {
      setRequestError(t('操作失败，请稍后重试'))
    } finally {
      setRequesting(false)
    }
  }

  const cancelForceEnable = async () => {
    setRequesting(true)
    setRequestError(null)
    try {
      const response = await fetch(`${CORE_URL}/plugins/${plugin.name}/cancel-force-enable`, { method: 'POST' })
      if (!response.ok) setRequestError(await failureText(response))
    } catch {
      setRequestError(t('操作失败，请稍后重试'))
    } finally {
      setRequesting(false)
    }
  }

  const relaunch = async () => {
    setRelaunching(true)
    setRequestError(null)
    try {
      await window.electronAPI.relaunchApp()
    } catch {
      setRequestError(t('操作失败，请稍后重试'))
      setRelaunching(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const response = await fetch(`${CORE_URL}/plugins/${plugin.name}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: drafts }),
      })
      if (!response.ok) setSaveError(await failureText(response))
    } catch {
      setSaveError(t('操作失败，请稍后重试'))
    } finally {
      setSaving(false)
    }
  }

  const installing = plugin.status.state === 'installing'
  const failed = plugin.status.state === 'failed'
  const forcedLoadFailure =
    plugin.installed && !plugin.enabled && !installing && plugin.disabled?.reason === 'load_failed' && 'forced' in plugin.disabled
      ? plugin.disabled
      : null
  const loadFailedInstalled =
    plugin.installed && !plugin.enabled && !installing && plugin.disabled?.reason === 'load_failed' && forcedLoadFailure === null
  const installedVersion = plugin.version ?? ''
  let versionLine: string
  let actionLabel: string | null
  if (!plugin.installed) {
    actionLabel = t('安装')
    if (latest.state === 'ready') versionLine = t('未安装 · 可安装版本 {{latest}}', { latest: latest.version })
    else if (latest.state === 'loading') versionLine = t('未安装 · 正在检查可安装版本…')
    else versionLine = t('未安装 · 无法获取可安装版本')
  } else if (loadFailedInstalled) {
    actionLabel = t('重新安装')
    versionLine = t('已安装 {{version}} · 插件加载失败，详见日志', { version: installedVersion })
  } else if (latest.state === 'ready') {
    if (isNewerVersion(latest.version, installedVersion)) {
      actionLabel = t('更新到 {{latest}}', { latest: latest.version })
      versionLine = t('已安装 {{version}} · 有新版本 {{latest}}', { version: installedVersion, latest: latest.version })
    } else {
      actionLabel = null
      versionLine = t('已安装 {{version}} · 已是最新版本', { version: installedVersion })
    }
  } else {
    actionLabel = t('更新')
    versionLine =
      latest.state === 'loading'
        ? t('已安装 {{version}} · 正在检查新版本…', { version: installedVersion })
        : t('已安装 {{version}} · 无法检查新版本', { version: installedVersion })
  }
  const configItems = Object.entries(plugin.configSchema ?? {}).filter(([, item]) => item.type === 'string')

  return (
    <div className="window-behavior-panel__section">
      <div className="window-behavior-panel__section-label">{plugin.displayName}</div>
      <div>{versionLine}</div>
      <div>
        {installing ? (
          <button className="memory-btn" disabled>{t('正在安装…')}</button>
        ) : failed ? (
          <>
            <span className="character-panel__error">
              {errorText({ code: plugin.status.errorCode } as ErrorBody, t)}
            </span>
            <button className="memory-btn" disabled={requesting} onClick={install}>{t('重试')}</button>
          </>
        ) : (
          actionLabel !== null && (
            <button className="memory-btn" disabled={requesting} onClick={install}>{actionLabel}</button>
          )
        )}
      </div>
      {plugin.installed && !plugin.enabled && !installing && plugin.disabled?.reason === 'version_incompatible' && (
        <div>
          <span className="character-panel__error">
            {t('需要 MintBot {{range}}，当前 {{version}}', {
              range: plugin.disabled.range,
              version: plugin.disabled.mintbotVersion,
            })}
          </span>
          <button className="memory-btn" disabled={requesting} onClick={forceEnable}>{t('仍然启用')}</button>
        </div>
      )}
      {plugin.installed && !plugin.enabled && !installing && plugin.disabled?.reason === 'version_invalid' && (
        <div>
          <span className="character-panel__error">
            {t('插件的版本要求写法有误（{{range}}），正确示例：>=1.0,<2', { range: plugin.disabled.range })}
          </span>
          <button className="memory-btn" disabled={requesting} onClick={forceEnable}>{t('仍然启用')}</button>
        </div>
      )}
      {forcedLoadFailure !== null && (
        <div>
          <span className="character-panel__error">
            {t('仍然启用后插件加载失败：{{message}}', { message: forcedLoadFailure.message })}
          </span>
          <button className="memory-btn" disabled={requesting} onClick={cancelForceEnable}>{t('取消加载')}</button>
        </div>
      )}
      {plugin.needsRestart && !restartDismissed && relaunchAvailable !== null && (
        <div>
          <div>{t('已更新，重启后生效')}</div>
          {relaunchAvailable ? (
            <>
              <button className="memory-btn" disabled={relaunching} onClick={relaunch}>{t('立即重启')}</button>
              <button className="memory-btn" disabled={relaunching} onClick={() => setRestartDismissed(true)}>
                {t('下次启动时生效')}
              </button>
            </>
          ) : (
            <div className="character-panel__hint">{t('开发模式下请手动重新运行 pnpm dev:all')}</div>
          )}
        </div>
      )}
      {requestError && <div className="character-panel__error">{requestError}</div>}
      {plugin.enabled && plugin.config !== null && configItems.length > 0 && (
        <>
          {configItems.map(([key, item]) => (
            <div key={key} className="model-config-panel__field">
              <label htmlFor={`plugin-${plugin.name}-${key}`}>{item.description ?? key}</label>
              <input
                id={`plugin-${plugin.name}-${key}`}
                value={drafts[key] ?? ''}
                disabled={saving}
                onChange={e => setDrafts(current => ({ ...current, [key]: e.target.value }))}
              />
              {item.hint && <div className="character-panel__hint">{item.hint}</div>}
            </div>
          ))}
          <div>
            <button className="memory-btn" disabled={saving} onClick={save}>{t('保存')}</button>
          </div>
          {saveError && <div className="character-panel__error">{saveError}</div>}
        </>
      )}
      {plugin.enabled && plugin.forced && (
        <div className="character-panel__hint plugin-card__forced-note">{t('版本不兼容，已手动启用')}</div>
      )}
    </div>
  )
}

export function PluginsPanel() {
  const { t } = useTranslation()
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [latest, setLatest] = useState<Record<string, LatestVersion>>({})
  const [relaunchAvailable, setRelaunchAvailable] = useState<boolean | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${CORE_URL}/plugins`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload: { plugins: PluginInfo[] } = await response.json()
      setPlugins(payload.plugins)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    load()
    const watchdog = createWatchdogEventSource({
      url: `${CORE_URL}/events`,
      listeners: {
        'plugins-changed': () => {
          load()
        },
      },
      onOpen: () => {
        load()
      },
    })
    return () => {
      watchdog.close()
    }
  }, [load])

  useEffect(() => {
    window.electronAPI.getRelaunchInfo()
      .then(info => setRelaunchAvailable(info.available))
      .catch(() => setRelaunchAvailable(false))
  }, [])

  const names = (plugins ?? []).map(plugin => plugin.name).join(',')
  useEffect(() => {
    if (names === '') return
    for (const name of names.split(',')) {
      setLatest(current => ({ ...current, [name]: { state: 'loading' } }))
      fetch(`${CORE_URL}/plugins/${name}/latest`)
        .then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        })
        .then((payload: { version: string }) =>
          setLatest(current => ({ ...current, [name]: { state: 'ready', version: payload.version } }))
        )
        .catch(() => setLatest(current => ({ ...current, [name]: { state: 'failed' } })))
    }
  }, [names])

  if (loadFailed && plugins === null) return <div className="character-panel__error">{t('加载插件列表失败，请稍后重试')}</div>
  if (plugins === null) return <div className="memory-loading">{t('加载中…')}</div>

  return (
    <div className="window-behavior-panel">
      {plugins.map(plugin => (
        <PluginCard
          key={plugin.name}
          plugin={plugin}
          latest={latest[plugin.name] ?? { state: 'loading' }}
          relaunchAvailable={relaunchAvailable}
        />
      ))}
    </div>
  )
}
