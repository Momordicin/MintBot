// src/settings/RoleConfigStepRow.tsx — 一键生成角色配置的一行进度：进行中转圈、完成时行尾打勾动画后换成静止 ✓、失败红色 ✗
// 用法：CharacterPanel 渲染 <RoleConfigStepRow />
// 对应文件：src/settings/CharacterPanel.tsx / src/settings/ApiKeyField.tsx / src/settings/settings.css
import React, { useEffect, useState } from 'react'
import { SpinnerIcon } from './ApiKeyField.js'

export type RoleConfigRowState = 'start' | 'done' | 'failed'

interface RoleConfigStepRowProps {
  state: RoleConfigRowState
  texts: Record<RoleConfigRowState, string>
  child?: boolean
}

export function RoleConfigStepRow({ state, texts, child }: RoleConfigStepRowProps) {
  const [shown, setShown] = useState<RoleConfigRowState>(state)

  useEffect(() => {
    if (state !== 'done') setShown(state)
  }, [state])

  const settled = state === 'done' && shown === 'done'
  const playing = state === 'done' && shown !== 'done'
  const display = settled ? 'done' : playing ? 'start' : state

  return (
    <div className={`character-panel__role-config-step role-config-row${child ? ' role-config-row--child' : ''}`}>
      <span className="role-config-row__icon">
        {display === 'start' && <SpinnerIcon />}
        {display === 'done' && <span className="role-config-row__ok">✓</span>}
        {display === 'failed' && <span className="character-panel__error">✗</span>}
      </span>
      <span className={display === 'failed' ? 'character-panel__error' : 'character-panel__name'}>{texts[display]}</span>
      {playing && (
        <svg className="role-config-row__ok" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path className="role-config-row__draw" d="m5 12 5 5L20 7" onAnimationEnd={() => setShown('done')} />
        </svg>
      )}
    </div>
  )
}
