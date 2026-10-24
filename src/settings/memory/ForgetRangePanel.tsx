// src/settings/memory/ForgetRangePanel.tsx — "按时间段删除"子面板：选起止时间，先检查影响范围（消息数、重叠摘要），再二次确认后删除当前会话该时间段的记忆
// 用法：MemoryPanel 渲染 <ForgetRangePanel sessionId />；POST /forget/check，POST /forget
// 形状：props { sessionId: string }；删除结果含各类记录的删除条数
// 对应文件：src/settings/memory/MemoryPanel.tsx / services/core/routes/forget.ts
import React, { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CORE_URL } from '../../coreUrl.js'

interface SummaryRow {
  id: number
  fromMessageId: number
  toMessageId: number
}

interface ForgetImpact {
  messageIds: number[]
  affectedSummaries: SummaryRow[]
}

interface ForgetResult {
  deletedMessages: number
  deletedEntities: number
  deletedSummaries: number
  deletedEmbeddings: number
  deletedFts: number
}

interface CheckedRange {
  fromTime: number
  toTime: number
}

interface ForgetRangePanelProps {
  sessionId: string
}

function datetimeLocalToEpoch(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function ForgetRangePanel({ sessionId }: ForgetRangePanelProps) {
  const { t } = useTranslation()
  const fromId = useId()
  const toId = useId()
  const [fromValue, setFromValue] = useState('')
  const [toValue, setToValue] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<ForgetImpact | null>(null)
  const [checkedRange, setCheckedRange] = useState<CheckedRange | null>(null)
  const [alsoDeleteAffectedSummaries, setAlsoDeleteAffectedSummaries] = useState(false)
  const [confirmStep, setConfirmStep] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [conflictMessage, setConflictMessage] = useState<string | null>(null)
  const [deleteResult, setDeleteResult] = useState<ForgetResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setValidationError(null)
    setCheckResult(null)
    setCheckedRange(null)
    setAlsoDeleteAffectedSummaries(false)
    setConfirmStep(false)
    setConflictMessage(null)
    setDeleteResult(null)
    setError(null)
  }, [sessionId])

  const fromTime = datetimeLocalToEpoch(fromValue)
  const toTime = datetimeLocalToEpoch(toValue)
  const isStale = checkedRange === null || fromTime !== checkedRange.fromTime || toTime !== checkedRange.toTime

  async function handleCheck() {
    setError(null)
    setConflictMessage(null)
    setDeleteResult(null)

    if (fromTime === null || toTime === null) {
      setValidationError(t('请输入起止时间'))
      return
    }
    if (fromTime > toTime) {
      setValidationError(t('起始时间不能晚于结束时间'))
      return
    }
    setValidationError(null)
    setIsChecking(true)
    try {
      const response = await fetch(`${CORE_URL}/forget/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, fromTime, toTime }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const impact: ForgetImpact = await response.json()
      setCheckResult(impact)
      setCheckedRange({ fromTime, toTime })
      setAlsoDeleteAffectedSummaries(false)
      setConfirmStep(false)
    } catch {
      setError(t('检查影响范围失败，请稍后重试'))
    } finally {
      setIsChecking(false)
    }
  }

  async function handleConfirmDelete() {
    if (checkedRange === null) return
    const { fromTime: rangeFrom, toTime: rangeTo } = checkedRange
    setIsDeleting(true)
    setError(null)
    try {
      const response = await fetch(`${CORE_URL}/forget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, fromTime: rangeFrom, toTime: rangeTo, alsoDeleteAffectedSummaries }),
      })

      if (response.status === 409) {
        const impact: ForgetImpact = await response.json()
        setCheckResult(impact)
        setCheckedRange({ fromTime: rangeFrom, toTime: rangeTo })
        setConfirmStep(false)
        setConflictMessage(t('删除被拒绝：存在与所选时间段重叠的摘要，请勾选"同时删除这些摘要"后重试'))
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const result: ForgetResult = await response.json()
      setDeleteResult(result)
      setCheckResult(null)
      setCheckedRange(null)
      setConfirmStep(false)
    } catch {
      setError(t('删除失败，请稍后重试'))
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div className="forget-panel">
      <div className="forget-panel__field">
        <label htmlFor={fromId}>{t('起始时间')}</label>
        <input
          id={fromId}
          type="datetime-local"
          value={fromValue}
          onChange={e => setFromValue(e.target.value)}
          disabled={confirmStep}
        />
      </div>
      <div className="forget-panel__field">
        <label htmlFor={toId}>{t('结束时间')}</label>
        <input
          id={toId}
          type="datetime-local"
          value={toValue}
          onChange={e => setToValue(e.target.value)}
          disabled={confirmStep}
        />
      </div>

      {validationError && <div className="character-panel__error">{validationError}</div>}

      <button className="memory-btn" onClick={handleCheck} disabled={isChecking}>
        {isChecking ? t('检查中…') : t('检查影响范围')}
      </button>

      {error && <div className="character-panel__error">{error}</div>}
      {conflictMessage && <div className="character-panel__error">{conflictMessage}</div>}

      {checkResult && (
        <div className="forget-panel__result">
          <div>{t('共 {{count}} 条消息将被删除', { count: checkResult.messageIds.length })}</div>
          {checkResult.affectedSummaries.length > 0 && (
            <>
              <div>{t('有 {{count}} 条摘要与所选时间段重叠', { count: checkResult.affectedSummaries.length })}</div>
              <label className="forget-panel__checkbox">
                <input
                  type="checkbox"
                  checked={alsoDeleteAffectedSummaries}
                  onChange={e => setAlsoDeleteAffectedSummaries(e.target.checked)}
                />
                {t('同时删除这些摘要（否则删除会被拒绝）')}
              </label>
            </>
          )}
        </div>
      )}

      {!confirmStep && (
        <button className="memory-btn memory-btn--danger" onClick={() => setConfirmStep(true)} disabled={isStale}>
          {t('删除')}
        </button>
      )}

      {confirmStep && checkResult && (
        <div className="forget-panel__confirm">
          <div>
            {checkResult.affectedSummaries.length > 0
              ? t('此操作不可撤销，将删除 {{count}} 条消息，以及 {{summaries}} 条摘要', { count: checkResult.messageIds.length, summaries: checkResult.affectedSummaries.length })
              : t('此操作不可撤销，将删除 {{count}} 条消息', { count: checkResult.messageIds.length })}
          </div>
          <button className="memory-btn" onClick={() => setConfirmStep(false)}>{t('取消')}</button>
          <button className="memory-btn memory-btn--danger" onClick={handleConfirmDelete} disabled={isDeleting}>
            {isDeleting ? t('删除中…') : t('确认删除')}
          </button>
        </div>
      )}

      {deleteResult && (
        <div className="forget-panel__result">
          {t('已删除 {{messages}} 条消息、{{entities}} 条实体、{{summaries}} 条摘要', { messages: deleteResult.deletedMessages, entities: deleteResult.deletedEntities, summaries: deleteResult.deletedSummaries })}
        </div>
      )}
    </div>
  )
}
