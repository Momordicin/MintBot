// src/settings/WebSearchPanel.tsx — 设置窗口的"联网搜索"面板：调用顺序、DeepSeek 搜索 / Tavily / AnySearch 的 Key、AnySearch 地区、两个订阅的登录状态
// 用法：SettingsApp 里渲染 <WebSearchPanel />（无 props）；GET/PATCH /config/web-search、POST /config/web-search/test
// 对应文件：src/settings/SettingsApp.tsx / src/settings/ApiKeyField.tsx / src/errorText.ts / services/core/routes/config.ts / shared/types/index.ts
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WebSearchProvider } from '../../shared/types/index.js'
import { isErrorBody } from '../../shared/errorCodes.js'
import { errorText, providerName } from '../errorText.js'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'
import { ApiKeyField, type ApiKeyTestResult } from './ApiKeyField.js'

type KeyedProvider = 'deepseek' | 'tavily' | 'anysearch'
type Zone = 'cn' | 'intl' | null
type SavingKind = 'button' | 'auto' | null

interface KeyInfo {
  hasKey: boolean
  last4: string | null
}

interface WebSearchSummary {
  order: WebSearchProvider[]
  anysearchZone: Zone
  deepseek: KeyInfo
  tavily: KeyInfo
  anysearch: KeyInfo
  modelDeepseek: KeyInfo
  claude: { loggedIn: boolean }
  codex: { loggedIn: boolean }
}

const ALL_PROVIDERS: readonly WebSearchProvider[] = ['deepseek', 'tavily', 'anysearch', 'claude', 'codex']
const KEYED_PROVIDERS: readonly KeyedProvider[] = ['deepseek', 'tavily', 'anysearch']

const KEY_FIELD = {
  deepseek: 'deepseekApiKey',
  tavily: 'tavilyApiKey',
  anysearch: 'anysearchApiKey',
} as const

export function WebSearchPanel() {
  const { t, i18n } = useTranslation()
  const zoneId = useId()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [data, setData] = useState<WebSearchSummary | null>(null)
  const [order, setOrder] = useState<WebSearchProvider[]>([])
  const [keyInputs, setKeyInputs] = useState<Record<KeyedProvider, string>>({ deepseek: '', tavily: '', anysearch: '' })
  const [keyEditing, setKeyEditing] = useState<Record<KeyedProvider, boolean>>({ deepseek: false, tavily: false, anysearch: false })
  const [savingKind, setSavingKind] = useState<SavingKind>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const requestControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      requestControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${CORE_URL}/config/web-search`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((summary: WebSearchSummary) => {
        setData(summary)
        setOrder(summary.order)
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setLoadError(i18n.t('加载联网搜索设置失败，请稍后重试'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  const send = useCallback(async (body: Record<string, unknown>, kind: Exclude<SavingKind, null>, onDone: (summary: WebSearchSummary) => void): Promise<string | null> => {
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller
    setSavingKind(kind)
    setErrorMessage(null)
    setCopyError(null)
    setSaveNotice(null)
    try {
      const response = await fetch(`${CORE_URL}/config/web-search`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        return isErrorBody(payload) ? errorText(payload, i18n.t) : `HTTP ${response.status}`
      }
      const summary: WebSearchSummary = await response.json()
      if (controller.signal.aborted) return null
      onDone(summary)
      return null
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      return err instanceof Error ? err.message : i18n.t('保存联网搜索设置失败，请稍后重试')
    } finally {
      setSavingKind(null)
    }
  }, [])

  const testKey = async (provider: KeyedProvider): Promise<ApiKeyTestResult> => {
    try {
      const response = await fetch(`${CORE_URL}/config/web-search/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      const body: unknown = await response.json().catch(() => null)
      if (response.ok && typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true) return { ok: true }
      return { ok: false, reason: isErrorBody(body) ? errorText(body, i18n.t) : `HTTP ${response.status}` }
    } catch {
      return { ok: false, reason: i18n.t('连不上服务，请检查网络') }
    }
  }

  if (loading) {
    return <div className="memory-loading">{t('加载中…')}</div>
  }

  if (loadError || !data) {
    return <div className="character-panel__error">{loadError}</div>
  }

  const isSaving = savingKind !== null
  const isButtonSaving = savingKind === 'button'

  const handleSave = async () => {
    const reason = await send({ order }, 'button', summary => {
      setData(summary)
      setOrder(summary.order)
      setSaveNotice(i18n.t('已保存'))
    })
    if (reason !== null) setErrorMessage(reason)
  }

  const handleCopy = async () => {
    const reason = await send({ copyDeepseekKeyFromModel: true }, 'button', summary => {
      setData(summary)
      setKeyInputs(prev => ({ ...prev, deepseek: '' }))
      setKeyEditing(prev => ({ ...prev, deepseek: false }))
    })
    if (reason !== null) setCopyError(reason)
  }

  const handleZoneChange = async (zone: Zone) => {
    const reason = await send({ anysearchZone: zone }, 'auto', summary => setData(summary))
    if (reason !== null) setErrorMessage(reason)
  }

  const move = (index: number, delta: number) => {
    const next = [...order]
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item)
    setOrder(next)
  }

  const canAdd = (provider: WebSearchProvider): boolean => {
    switch (provider) {
      case 'deepseek':
      case 'tavily':
        return data[provider].hasKey
      case 'anysearch':
        return true
      case 'claude':
        return data.claude.loggedIn
      case 'codex':
        return data.codex.loggedIn
    }
  }

  const copyButton = data.modelDeepseek.hasKey ? (
    <button type="button" className="rename-btn" onMouseDown={e => e.preventDefault()} onClick={() => void handleCopy()}>{t('从模型设置复制')}</button>
  ) : undefined

  const secondRowFor = (provider: KeyedProvider) => {
    if (provider === 'anysearch') {
      return (
        <div className="model-config-panel__field api-key-field__zone">
          <label htmlFor={zoneId}>{t('搜索地区')}</label>
          <select
            id={zoneId}
            value={data.anysearchZone ?? ''}
            onChange={e => void handleZoneChange(e.target.value === '' ? null : (e.target.value as 'cn' | 'intl'))}
          >
            <option value="">{t('不限制')}</option>
            <option value="cn">{t('只搜国内')}</option>
            <option value="intl">{t('只搜国外')}</option>
          </select>
        </div>
      )
    }
    return undefined
  }

  const keyField = (provider: KeyedProvider) => (
    <ApiKeyField
      key={provider}
      label={providerName(provider, t)}
      summary={data[provider]}
      keyInput={keyInputs[provider]}
      onKeyInputChange={value => {
        if (provider === 'deepseek') setCopyError(null)
        setKeyInputs(prev => ({ ...prev, [provider]: value }))
      }}
      editing={keyEditing[provider]}
      onEditingChange={editing => {
        if (provider === 'deepseek' && !editing) setCopyError(null)
        setKeyEditing(prev => ({ ...prev, [provider]: editing }))
      }}
      emptyPlaceholder={provider === 'anysearch' ? t('不填使用匿名免费额度') : undefined}
      canTestWithoutKey={provider === 'anysearch'}
      onCommit={key => send({ [KEY_FIELD[provider]]: key }, 'auto', summary => setData(summary))}
      onTest={() => testKey(provider)}
      secondRow={secondRowFor(provider)}
      editAction={provider === 'deepseek' ? copyButton : undefined}
      notice={provider === 'deepseek' && copyError !== null ? copyError : undefined}
    />
  )

  const unlisted = ALL_PROVIDERS.filter(provider => !order.includes(provider))

  return (
    <fieldset className="model-config-panel" disabled={isSaving}>
      {isButtonSaving && <div className="model-config-panel__saving"><div className="model-config-panel__saving-label">{t('保存中…')}</div></div>}

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{t('调用顺序')}</div>
        <div className="character-panel__hint">{t('排在前面的一家失败时，自动改用下一家')}</div>
        {order.length === 0 && <div className="character-panel__hint">{t('还没有启用任何搜索服务')}</div>}
        <div className="web-search-panel__list">
          {order.map((provider, index) => (
            <div key={provider} className="web-search-panel__list-row">
              <span>{index + 1}. {providerName(provider, t)}</span>
              <span className="web-search-panel__list-actions">
                <button type="button" className="rename-btn" disabled={index === 0} onClick={() => move(index, -1)}>{t('上移')}</button>
                <button type="button" className="rename-btn" disabled={index === order.length - 1} onClick={() => move(index, 1)}>{t('下移')}</button>
                <button type="button" className="rename-btn" onClick={() => setOrder(order.filter(item => item !== provider))}>{t('移除')}</button>
              </span>
            </div>
          ))}
          {unlisted.map(provider => {
            const addable = canAdd(provider)
            return (
              <div key={provider} className={addable ? 'web-search-panel__list-row' : 'web-search-panel__list-row web-search-panel__list-row--disabled'}>
                <span className="web-search-panel__list-name">{providerName(provider, t)}</span>
                <button type="button" className="rename-btn" disabled={!addable} onClick={() => setOrder([...order, provider])}>{t('添加')}</button>
              </div>
            )
          })}
        </div>
      </div>

      <div className="web-search-panel__save-row">
        <button className="rename-btn" onClick={() => void handleSave()} disabled={isSaving}>
          {isButtonSaving ? t('保存中…') : t('保存')}
        </button>
        {errorMessage && <span className="character-panel__error">{errorMessage}</span>}
        {saveNotice && <span className="character-panel__notice">{saveNotice}</span>}
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{t('API Key')}</div>
        {KEYED_PROVIDERS.map(keyField)}
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{providerName('claude', t)}</div>
        <div className="character-panel__hint">{t('使用已配置的订阅')}</div>
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{providerName('codex', t)}</div>
        <div className="character-panel__hint">{t('使用已配置的订阅')}</div>
      </div>
    </fieldset>
  )
}
