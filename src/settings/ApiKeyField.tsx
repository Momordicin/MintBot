// src/settings/ApiKeyField.tsx — 设置窗口共用的 API Key 行：Key 框、失焦自动保存、测试按钮与结果图标、自动配置勾选
// 用法：ModelConfigPanel 与 WebSearchPanel 渲染 <ApiKeyField label ... onCommit onTest />，PersonaModelPanel 渲染 <ApiKeyField compact ... onTest />；导出 KeyProvider / ENV_VAR / ApiKeyLoadStatus / ApiKeySummary / TestState / TestResultIcon（ModelConfigPanel 的 Ollama 地址行共用）
// 对应文件：src/settings/ModelConfigPanel.tsx / src/settings/PersonaModelPanel.tsx / src/settings/WebSearchPanel.tsx / src/settings/useCharacterPanel.ts / src/settings/settings.css
import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export type KeyProvider = 'anthropic' | 'openai' | 'deepseek'

export const ENV_VAR: Record<KeyProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

export type ApiKeyLoadStatus = 'loading' | 'ready' | 'error'

export interface ApiKeySummary {
  hasKey: boolean
  last4: string | null
}

export type ApiKeyTestResult = { ok: true } | { ok: false; reason: string }

interface ApiKeyEnv {
  envVar: string
  detected: boolean
  fromEnv: boolean
  status: ApiKeyLoadStatus
  onChange: (checked: boolean) => void
}

export type TestState = 'idle' | 'testing' | 'ok' | 'fail'

interface TestSlot {
  state: TestState
  reason: string | null
  seq: number
}

const MIN_KEY_LENGTH = 20

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg className="api-key-field__spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

export function TestResultIcon({ state, reason }: { state: TestState; reason: string | null }) {
  const { t } = useTranslation()
  return (
    <span
      className={`api-key-field__result${state === 'ok' ? ' api-key-field__result--ok' : ''}${state === 'fail' ? ' api-key-field__result--fail' : ''}`}
      role={state === 'idle' ? undefined : 'img'}
      aria-label={state === 'ok' ? t('测试通过') : state === 'fail' ? t('测试失败') : state === 'testing' ? t('测试中…') : undefined}
      title={state === 'fail' ? (reason ?? undefined) : undefined}
    >
      {state === 'testing' && <SpinnerIcon />}
      {state === 'ok' && <CheckIcon />}
      {state === 'fail' && <CrossIcon />}
    </span>
  )
}

interface ApiKeyFieldProps {
  label?: string
  summary: ApiKeySummary
  keyStatus?: ApiKeyLoadStatus
  keyInput: string
  onKeyInputChange: (value: string) => void
  editing: boolean
  onEditingChange: (editing: boolean) => void
  env?: ApiKeyEnv
  emptyPlaceholder?: string
  onCommit?: (key: string) => Promise<string | null>
  onTest: () => Promise<ApiKeyTestResult>
  canTestWithoutKey?: boolean
  secondRow?: ReactNode
  editAction?: ReactNode
  notice?: string
  compact?: boolean
}

export function ApiKeyField({
  label, summary, keyStatus = 'ready', keyInput, onKeyInputChange, editing, onEditingChange, env, emptyPlaceholder,
  onCommit, onTest, canTestWithoutKey = false, secondRow, editAction, notice, compact = false,
}: ApiKeyFieldProps) {
  const { t } = useTranslation()
  const inputId = useId()
  const envHintId = useId()
  const [lengthError, setLengthError] = useState(false)
  const [commitState, setCommitState] = useState<'idle' | 'saving'>('idle')
  const [commitError, setCommitError] = useState<string | null>(null)
  const [test, setTest] = useState<TestSlot>({ state: 'idle', reason: null, seq: 0 })
  const [commitOkTick, setCommitOkTick] = useState(0)
  const savingRef = useRef(false)
  const failedKeyRef = useRef<string | null>(null)
  const focusOnMountRef = useRef(false)
  const cancelledRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fromEnv = env?.fromEnv ?? false
  useEffect(() => {
    setTest(prev => ({ state: 'idle', reason: null, seq: prev.seq + 1 }))
  }, [summary.hasKey, summary.last4, fromEnv, keyInput])

  useEffect(() => {
    if (commitOkTick > 0) setTest(prev => ({ state: 'ok', reason: null, seq: prev.seq + 1 }))
  }, [commitOkTick])

  useEffect(() => {
    if (!editing || fromEnv) {
      setLengthError(false)
      setCommitError(null)
    }
  }, [editing, fromEnv])

  const keyReady = keyStatus === 'ready'
  const saving = commitState === 'saving'
  const inputLabel = label === undefined ? t('API Key') : undefined
  const maskedValue = summary.hasKey ? `••••••••${summary.last4 ?? ''}` : t('未填写')
  const inlineText = !compact && keyReady && (fromEnv || (summary.hasKey && !editing))
  const closeMode = editing || (!compact && !summary.hasKey)

  const startEditing = () => {
    cancelledRef.current = false
    focusOnMountRef.current = true
    onKeyInputChange('')
    setLengthError(false)
    setCommitError(null)
    onEditingChange(true)
  }

  const cancelEditing = () => {
    cancelledRef.current = true
    onKeyInputChange('')
    setLengthError(false)
    setCommitError(null)
    onEditingChange(false)
  }

  const commit = async (fromBlur = false) => {
    if (!onCommit || savingRef.current || cancelledRef.current) return
    const trimmed = keyInput.trim()
    if (trimmed === '') {
      onEditingChange(false)
      return
    }
    if (fromBlur && trimmed === failedKeyRef.current) return
    if (trimmed.length < MIN_KEY_LENGTH) {
      setLengthError(true)
      return
    }
    setLengthError(false)
    setCommitError(null)
    savingRef.current = true
    setCommitState('saving')
    const reason = await onCommit(trimmed)
    savingRef.current = false
    if (!mountedRef.current) return
    if (reason !== null) focusOnMountRef.current = true
    setCommitState('idle')
    if (reason === null) {
      failedKeyRef.current = null
      onKeyInputChange('')
      onEditingChange(false)
      setCommitOkTick(prev => prev + 1)
    } else {
      failedKeyRef.current = trimmed
      setCommitError(reason)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditing()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void commit()
    }
  }

  const hasTestableKey = summary.hasKey
    || (fromEnv && env?.detected === true)
    || canTestWithoutKey
    || (!onCommit && keyInput.trim() !== '')
  const testDisabled = !keyReady || saving || test.state === 'testing' || ((editing || keyInput.trim() !== '') && onCommit !== undefined) || !hasTestableKey

  const runTest = async () => {
    const { seq } = test
    setTest({ state: 'testing', reason: null, seq })
    const result = await onTest().catch((err: unknown): ApiKeyTestResult => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }))
    if (!mountedRef.current) return
    setTest(prev => {
      if (prev.seq !== seq) return prev
      return result.ok ? { state: 'ok', reason: null, seq } : { state: 'fail', reason: result.reason, seq }
    })
  }

  const envVar = env?.envVar ?? ''
  const envPending = !keyReady || (env !== undefined && env.status !== 'ready')
  const envDetected = env?.detected === true
  const envUndetectedHint = t('未检测到环境变量 {{envVar}}；修改环境变量后需重启 MintBot', { envVar })
  const envLabel = env?.status === 'loading'
    ? t('自动配置（检测中…）')
    : envDetected ? t('自动配置（{{envVar}}）', { envVar }) : t('自动配置（未检测到）')
  const envHint = envDetected ? t('使用环境变量 {{envVar}}', { envVar }) : envUndetectedHint

  const keyBox = (
    <div className={compact ? 'model-config-panel__field model-config-panel__field--compact' : 'model-config-panel__field api-key-field__box'}>
      <div className="model-config-panel__secret">
        {!keyReady ? (
          <input id={inputId} aria-label={inputLabel} key="view" type="text" readOnly value={keyStatus === 'loading' ? t('加载中…') : t('读取失败')} />
        ) : inlineText ? (
          <div className="api-key-field__text" role={fromEnv ? undefined : 'img'} aria-label={fromEnv ? undefined : maskedValue}>
            {fromEnv ? (
              <span>{t('使用环境变量 {{envVar}}', { envVar })}</span>
            ) : (
              <>
                <span className="api-key-field__dots" aria-hidden="true">{'•'.repeat(64)}</span>
                <span className="api-key-field__last4" aria-hidden="true">{summary.last4 ?? ''}</span>
              </>
            )}
          </div>
        ) : fromEnv ? (
          <input id={inputId} aria-label={inputLabel} key="view" type="text" readOnly value={compact ? t('环境变量') : t('使用环境变量 {{envVar}}', { envVar })} title={compact ? t('使用环境变量 {{envVar}}', { envVar }) : undefined} />
        ) : saving ? (
          <input id={inputId} aria-label={inputLabel} key="saving" type="text" readOnly value={t('保存中…')} />
        ) : editing || (!compact && !summary.hasKey) ? (
          <input
            id={inputId}
            aria-label={inputLabel}
            key="edit"
            type="password"
            ref={el => {
              if (el && focusOnMountRef.current) {
                focusOnMountRef.current = false
                el.focus()
              }
            }}
            autoComplete="new-password"
            spellCheck={false}
            value={keyInput}
            placeholder={!compact && !summary.hasKey ? (emptyPlaceholder ?? t('输入 API Key')) : t('输入新的 API Key')}
            onChange={e => {
              cancelledRef.current = false
              failedKeyRef.current = null
              setLengthError(false)
              onKeyInputChange(e.target.value)
            }}
            onBlur={() => void commit(true)}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <input id={inputId} aria-label={inputLabel} key="view" type="text" readOnly value={maskedValue} />
        )}
        {compact && keyReady && !fromEnv && !saving && (
          <button
            type="button"
            className="model-config-panel__icon-btn"
            aria-label={closeMode ? t('取消编辑') : t('编辑 API Key')}
            onMouseDown={e => e.preventDefault()}
            onClick={closeMode ? cancelEditing : startEditing}
          >
            {closeMode ? <CloseIcon /> : <PencilIcon />}
          </button>
        )}
      </div>
    </div>
  )

  const showEdit = keyReady && inlineText && !fromEnv
  const showClose = keyReady && !inlineText && !fromEnv && !saving && (editing || keyInput !== '')
  const editButton = showEdit || showClose ? (
    <button
      type="button"
      className="model-config-panel__icon-btn api-key-field__edit"
      aria-label={showClose ? t('取消编辑') : t('编辑 API Key')}
      onMouseDown={e => e.preventDefault()}
      onClick={showClose ? cancelEditing : startEditing}
    >
      {showClose ? <CloseIcon /> : <PencilIcon />}
    </button>
  ) : <span />

  const testButton = (
    <button type="button" className="rename-btn" disabled={testDisabled} onClick={() => void runTest()}>{t('测试')}</button>
  )

  const failTitle = test.reason ?? undefined
  const resultIcon = <TestResultIcon state={test.state} reason={test.reason} />

  const envDisabled = envPending || (!envDetected && !fromEnv)
  const envCheckbox = env && (
    <label
      className={`model-config-panel__checkbox${compact ? ' model-config-panel__checkbox--compact' : ''}${envDisabled ? ' model-config-panel__checkbox--disabled' : ''}`}
      title={compact || (!envDetected && env.status === 'ready') ? envHint : undefined}
    >
      <input
        type="checkbox"
        checked={fromEnv}
        aria-describedby={compact ? envHintId : undefined}
        disabled={envDisabled}
        onChange={e => env.onChange(e.target.checked)}
      />
      {compact ? t('环境变量') : envLabel}
      {compact && <span id={envHintId} hidden>{envHint}</span>}
    </label>
  )

  if (compact) {
    return (
      <>
        {keyBox}
        {envCheckbox}
        {fromEnv && env?.status === 'ready' && !envDetected && (
          <span className="api-key-field__warn" title={envUndetectedHint} aria-label={envUndetectedHint}>!</span>
        )}
        {testButton}
        {resultIcon}
      </>
    )
  }

  const hasSecondRow = env !== undefined || secondRow !== undefined
  return (
    <div className="api-key-field">
      <label className="api-key-field__label" htmlFor={inputId}>{label}</label>
      {keyBox}
      {editButton}
      {editAction !== undefined && keyReady && !fromEnv && !saving && (editing || !summary.hasKey) ? editAction : testButton}
      {resultIcon}
      {hasSecondRow && (
        <div className="api-key-field__second">
          {envCheckbox}
          {secondRow}
        </div>
      )}
      {notice !== undefined && <div className="api-key-field__note character-panel__error">{notice}</div>}
      {lengthError && <div className="api-key-field__note character-panel__error">{t('长度不对，未保存')}</div>}
      {commitError !== null && <div className="api-key-field__note character-panel__error">{commitError}</div>}
      {test.state === 'fail' && <div className="api-key-field__note api-key-field__note--fail" title={failTitle}>{test.reason}</div>}
    </div>
  )
}
