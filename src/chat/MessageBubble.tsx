import React from 'react'

export interface MessageData {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  isError?: boolean
}

interface MessageBubbleProps {
  message: MessageData
  prevRole?: 'user' | 'assistant' | 'system'
  avatarUrl?: string
  userAvatarUrl?: string
  displayName?: string
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()

  if (isToday) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function MessageBubble({
  message,
  prevRole,
  avatarUrl,
  userAvatarUrl,
  displayName,
}: MessageBubbleProps) {
  const { role, content, createdAt, isError } = message
  const showAvatar = role !== prevRole

  if (role === 'system') {
    return (
      <div className="msg-system">
        <span>{content}</span>
      </div>
    )
  }

  const isUser = role === 'user'

  return (
    <div className={`msg-row ${isUser ? 'msg-row--user' : 'msg-row--bot'} ${!showAvatar ? 'msg-row--collapsed' : ''}`}>
      {!isUser && (
        <div className="msg-avatar">
          {showAvatar && (
            avatarUrl
              ? <img src={avatarUrl} alt={displayName ?? '角色'} />
              : <div className="msg-avatar__placeholder" />
          )}
        </div>
      )}

      <div className="msg-col">
        <div className="msg-bubble-wrap">
          <div className={`msg-bubble ${isUser ? 'msg-bubble--user' : 'msg-bubble--bot'} ${isError ? 'msg-bubble--error' : ''}`}>
            {content}
          </div>
          <span className="msg-time">{formatTime(createdAt)}</span>
        </div>
      </div>

      {isUser && (
        <div className="msg-avatar">
          {showAvatar && (
            userAvatarUrl
              ? <img src={userAvatarUrl} alt="我" />
              : <div className="msg-avatar__placeholder msg-avatar__placeholder--user" />
          )}
        </div>
      )}
    </div>
  )
}
