// src/chat/MessageBubble.tsx — 单条消息气泡：用户/助手气泡带头像与时间，system 消息渲染为居中提示
// 用法：MessageList 逐条渲染 <MessageBubble />；同时导出 MessageData 类型，供 ChatWindow / MessageList 使用
// 形状：props { message: MessageData, prevRole?, avatarUrl?, userAvatarUrl?, displayName? }；与上一条 role 相同时头像留空
// 对应文件：src/chat/MessageList.tsx / src/chat/ChatWindow.tsx / src/chat/chat.css
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

      {isUser && userAvatarUrl && (
        <div className="msg-avatar">
          {showAvatar && <img src={userAvatarUrl} alt="我" />}
        </div>
      )}
    </div>
  )
}
