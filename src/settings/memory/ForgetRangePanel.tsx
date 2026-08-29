import React, { useEffect, useState } from 'react'

const CORE_URL = 'http://127.0.0.1:3000'

// 只取本面板展示需要的字段，本地重复定义（同其它 memory 子面板的约定）
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

// datetime-local 的 value 格式固定为 "YYYY-MM-DDTHH:mm"，new Date() 按本机时区解析，
// 输入框的原始字符串本身已经是可回显的格式，不需要额外的 epoch -> 字符串转换
function datetimeLocalToEpoch(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function ForgetRangePanel({ sessionId }: ForgetRangePanelProps) {
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

  // session 切换：整段检查/确认流程失效，回到初始输入态；日期输入框保留原值即可，
  // 不是这次切换要处理的东西
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
  // 用户在检查完之后又编辑了日期输入框：checkedRange 记录的是"检查那一刻"的时间段，
  // 与当前输入不再一致就说明检查结果已经过期，删除按钮必须重新禁用，直到重新点一次检查
  const isStale = checkedRange === null || fromTime !== checkedRange.fromTime || toTime !== checkedRange.toTime

  async function handleCheck() {
    setError(null)
    setConflictMessage(null)
    setDeleteResult(null)

    if (fromTime === null || toTime === null) {
      setValidationError('请输入起止时间')
      return
    }
    if (fromTime > toTime) {
      setValidationError('起始时间不能晚于结束时间')
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
      setError('检查影响范围失败，请稍后重试')
    } finally {
      setIsChecking(false)
    }
  }

  async function handleConfirmDelete() {
    // 故意用 checkedRange（检查那一刻的时间段），不用 fromTime/toTime（输入框当前值）——
    // 确认弹窗展示的影响范围是基于 checkedRange 算出来的，真正发起删除也必须用同一个范围，
    // 否则如果用户在弹窗打开后又偷偷改了输入框，会删掉一个和弹窗文案不一致的范围
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
        // 409 响应体本身就是一份新鲜的 ForgetImpact，等同于重新检查了一次——直接复用，
        // 不用再额外调一次 /forget/check
        const impact: ForgetImpact = await response.json()
        setCheckResult(impact)
        setCheckedRange({ fromTime: rangeFrom, toTime: rangeTo })
        setConfirmStep(false)
        setConflictMessage('删除被拒绝：存在与所选时间段重叠的摘要，请勾选"同时删除这些摘要"后重试')
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const result: ForgetResult = await response.json()
      setDeleteResult(result)
      // 删除已完成，这段时间范围不再存在，检查结果清空，面板回到初始输入态
      setCheckResult(null)
      setCheckedRange(null)
      setConfirmStep(false)
    } catch {
      setError('删除失败，请稍后重试')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div className="forget-panel">
      <div className="forget-panel__field">
        <label>起始时间</label>
        <input
          type="datetime-local"
          value={fromValue}
          onChange={e => setFromValue(e.target.value)}
          disabled={confirmStep}
        />
      </div>
      <div className="forget-panel__field">
        <label>结束时间</label>
        <input
          type="datetime-local"
          value={toValue}
          onChange={e => setToValue(e.target.value)}
          disabled={confirmStep}
        />
      </div>

      {validationError && <div className="character-panel__error">{validationError}</div>}

      <button className="memory-btn" onClick={handleCheck} disabled={isChecking}>
        {isChecking ? '检查中…' : '检查影响范围'}
      </button>

      {error && <div className="character-panel__error">{error}</div>}
      {conflictMessage && <div className="character-panel__error">{conflictMessage}</div>}

      {checkResult && (
        <div className="forget-panel__result">
          <div>共 {checkResult.messageIds.length} 条消息将被删除</div>
          {checkResult.affectedSummaries.length > 0 && (
            <>
              <div>有 {checkResult.affectedSummaries.length} 条摘要与所选时间段重叠</div>
              <label className="forget-panel__checkbox">
                <input
                  type="checkbox"
                  checked={alsoDeleteAffectedSummaries}
                  onChange={e => setAlsoDeleteAffectedSummaries(e.target.checked)}
                />
                同时删除这些摘要（否则删除会被拒绝）
              </label>
            </>
          )}
        </div>
      )}

      {!confirmStep && (
        <button className="memory-btn memory-btn--danger" onClick={() => setConfirmStep(true)} disabled={isStale}>
          删除
        </button>
      )}

      {confirmStep && checkResult && (
        <div className="forget-panel__confirm">
          <div>
            此操作不可撤销，将删除 {checkResult.messageIds.length} 条消息
            {checkResult.affectedSummaries.length > 0 && `，以及 ${checkResult.affectedSummaries.length} 条摘要`}
          </div>
          <button className="memory-btn" onClick={() => setConfirmStep(false)}>取消</button>
          <button className="memory-btn memory-btn--danger" onClick={handleConfirmDelete} disabled={isDeleting}>
            {isDeleting ? '删除中…' : '确认删除'}
          </button>
        </div>
      )}

      {deleteResult && (
        <div className="forget-panel__result">
          已删除 {deleteResult.deletedMessages} 条消息、{deleteResult.deletedEntities} 条实体、{deleteResult.deletedSummaries} 条摘要
        </div>
      )}
    </div>
  )
}
