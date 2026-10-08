import React from 'react'

interface TitleBarProps {
  avatarUrl?: string
  displayName: string
}

export function TitleBar({ avatarUrl, displayName }: TitleBarProps) {
  return (
    <div className="chat-titlebar">
      <div className="chat-titlebar__avatar">
        {avatarUrl
          ? <img src={avatarUrl} alt={displayName} />
          : <div className="chat-titlebar__avatar-placeholder" />}
      </div>
      <span className="chat-titlebar__name">{displayName}</span>
    </div>
  )
}
