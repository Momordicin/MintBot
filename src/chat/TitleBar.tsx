// src/chat/TitleBar.tsx — 聊天窗口顶部标题栏：当前角色头像（无头像时占位）与名称
// 用法：ChatWindow 渲染 <TitleBar />
// 形状：props { avatarUrl?, displayName }
// 对应文件：src/chat/ChatWindow.tsx / src/chat/chat.css
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
