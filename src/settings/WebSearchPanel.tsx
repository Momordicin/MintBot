// src/settings/WebSearchPanel.tsx — 设置窗口的"联网搜索"面板：调用顺序、DeepSeek 搜索 / Tavily / AnySearch 的 Key、AnySearch 地区、两个订阅的登录状态
// 用法：SettingsApp 里渲染 <WebSearchPanel />（无 props）；GET/PATCH /config/web-search
// 对应文件：src/settings/SettingsApp.tsx / src/settings/ApiKeyField.tsx / src/errorText.ts / services/core/routes/config.ts / shared/types/index.ts
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WebSearchProvider } from '../../shared/types/index.js'
import { isErrorBody } from '../../shared/errorCodes.js'
import { errorText, providerName } from '../errorText.js'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'
import { ApiKeyField } from './ApiKeyField.js'

type KeyedProvider = 'deepseek' | 'tavily' | 'anysearch'
type Zone = 'cn' | 'intl' | null

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

interface FormState {
  order: WebSearchProvider[]
  keyInputs: Record<KeyedProvider, string>
  keyEditing: Record<KeyedProvider, boolean>
  zone: Zone
}

const ALL_PROVIDERS: readonly WebSearchProvider[] = ['deepseek', 'tavily', 'anysearch', 'claude', 'codex']

function toFormState(data: WebSearchSummary): FormState {
  return {
    order: data.order,
    keyInputs: { deepseek: '', tavily: '', anysearch: '' },
    keyEditing: { deepseek: false, tavily: false, anysearch: false },
    zone: data.anysearchZone,
  }
}

function buildPatch(form: FormState) {
  const patch: Record<string, unknown> = {
    order: form.order,
    anysearchZone: form.zone,
  }
  if (form.keyInputs.deepseek.trim()) patch.deepseekApiKey = form.keyInputs.deepseek.trim()
  if (form.keyInputs.tavily.trim()) patch.tavilyApiKey = form.keyInputs.tavily.trim()
  if (form.keyInputs.anysearch.trim()) patch.anysearchApiKey = form.keyInputs.anysearch.trim()
  return patch
}

export function WebSearchPanel() {
  const { t, i18n } = useTranslation()
  const zoneId = useId()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [data, setData] = useState<WebSearchSummary | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
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
        setForm(toFormState(summary))
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

  const send = useCallback(async (body: Record<string, unknown>, onDone: (summary: WebSearchSummary) => void) => {
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller
    setIsSaving(true)
    setErrorMessage(null)
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
        throw new Error(isErrorBody(payload) ? errorText(payload, i18n.t) : `HTTP ${response.status}`)
      }
      const summary: WebSearchSummary = await response.json()
      if (controller.signal.aborted) return
      onDone(summary)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setErrorMessage(err instanceof Error ? err.message : i18n.t('保存联网搜索设置失败，请稍后重试'))
    } finally {
      setIsSaving(false)
    }
  }, [])

  if (loading) {
    return <div className="memory-loading">{t('加载中…')}</div>
  }

  if (loadError || !data || !form) {
    return <div className="character-panel__error">{loadError}</div>
  }

  const handleSave = () => send(buildPatch(form), summary => {
    setData(summary)
    setForm(toFormState(summary))
    setSaveNotice(i18n.t('已保存'))
  })

  const handleCopy = () => send({ copyDeepseekKeyFromModel: true }, summary => {
    setData(summary)
    setForm(prev => prev && { ...prev, keyInputs: { ...prev.keyInputs, deepseek: '' }, keyEditing: { ...prev.keyEditing, deepseek: false } })
  })

  const setOrder = (order: WebSearchProvider[]) => setForm(prev => prev && { ...prev, order })

  const move = (index: number, delta: number) => {
    const next = [...form.order]
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item)
    setOrder(next)
  }

  const hasKey = (provider: KeyedProvider): boolean => data[provider].hasKey || form.keyInputs[provider].trim() !== ''

  const canAdd = (provider: WebSearchProvider): boolean => {
    switch (provider) {
      case 'deepseek':
      case 'tavily':
        return hasKey(provider)
      case 'anysearch':
        return true
      case 'claude':
        return data.claude.loggedIn
      case 'codex':
        return data.codex.loggedIn
    }
  }

  const keyField = (provider: KeyedProvider) => (
    <ApiKeyField
      summary={data[provider]}
      envDetected={false}
      envVar=""
      fromEnv={false}
      keyInput={form.keyInputs[provider]}
      editing={form.keyEditing[provider]}
      onKeyInputChange={value => setForm(prev => prev && { ...prev, keyInputs: { ...prev.keyInputs, [provider]: value } })}
      onEditingChange={editing => setForm(prev => prev && { ...prev, keyEditing: { ...prev.keyEditing, [provider]: editing } })}
      onFromEnvChange={() => {}}
      showEnv={false}
    />
  )

  const unlisted = ALL_PROVIDERS.filter(provider => !form.order.includes(provider))
  const copyDisabled = !data.modelDeepseek.hasKey

  return (
    <fieldset className="model-config-panel" disabled={isSaving}>
      {isSaving && <div className="model-config-panel__saving"><div className="model-config-panel__saving-label">{t('保存中…')}</div></div>}

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{t('调用顺序')}</div>
        <div className="character-panel__hint">{t('排在前面的一家失败时，自动改用下一家')}</div>
        {form.order.length === 0 && <div className="character-panel__hint">{t('还没有启用任何搜索服务')}</div>}
        <div className="web-search-panel__list">
          {form.order.map((provider, index) => (
            <div key={provider} className="web-search-panel__list-row">
              <span>{index + 1}. {providerName(provider, t)}</span>
              <span className="web-search-panel__list-actions">
                <button type="button" className="rename-btn" disabled={index === 0} onClick={() => move(index, -1)}>{t('上移')}</button>
                <button type="button" className="rename-btn" disabled={index === form.order.length - 1} onClick={() => move(index, 1)}>{t('下移')}</button>
                <button type="button" className="rename-btn" onClick={() => setOrder(form.order.filter(item => item !== provider))}>{t('移除')}</button>
              </span>
            </div>
          ))}
          {unlisted.map(provider => {
            const addable = canAdd(provider)
            return (
              <div key={provider} className={addable ? 'web-search-panel__list-row' : 'web-search-panel__list-row web-search-panel__list-row--disabled'}>
                <span className="web-search-panel__list-name">{providerName(provider, t)}</span>
                <button type="button" className="rename-btn" disabled={!addable} onClick={() => setOrder([...form.order, provider])}>{t('添加')}</button>
              </div>
            )
          })}
        </div>
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{providerName('deepseek', t)}</div>
        {keyField('deepseek')}
        <button type="button" className="rename-btn" disabled={copyDisabled} onClick={handleCopy}>{t('从模型设置复制')}</button>
        {copyDisabled && <div className="character-panel__hint">{t('模型设置里没有已保存的 DeepSeek Key')}</div>}
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{providerName('tavily', t)}</div>
        {keyField('tavily')}
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{providerName('anysearch', t)}</div>
        {keyField('anysearch')}
        <div className="character-panel__hint">{t('不填使用匿名免费额度')}</div>
        <div className="model-config-panel__field">
          <label htmlFor={zoneId}>{t('搜索地区')}</label>
          <select
            id={zoneId}
            value={form.zone ?? ''}
            onChange={e => setForm(prev => prev && { ...prev, zone: e.target.value === '' ? null : (e.target.value as 'cn' | 'intl') })}
          >
            <option value="">{t('不限制')}</option>
            <option value="cn">{t('只搜国内')}</option>
            <option value="intl">{t('只搜国外')}</option>
          </select>
        </div>
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{providerName('claude', t)}</div>
        <div className="character-panel__hint">{t('使用已配置的订阅')}</div>
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{providerName('codex', t)}</div>
        <div className="character-panel__hint">{t('使用已配置的订阅')}</div>
      </div>

      <button className="rename-btn" onClick={handleSave} disabled={isSaving}>
        {isSaving ? t('保存中…') : t('保存')}
      </button>

      {errorMessage && <div className="character-panel__error">{errorMessage}</div>}
      {saveNotice && <div className="character-panel__notice">{saveNotice}</div>}
    </fieldset>
  )
}
