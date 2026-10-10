// src/chat/TypingIndicator.tsx — "角色正在回复"的三点动画气泡
// 用法：MessageList 在 isReplying 为真时渲染 <TypingIndicator />；无 props
// 对应文件：src/chat/MessageList.tsx / src/chat/chat.css
import React from 'react'

export function TypingIndicator() {
  return (
    <div className="typing-indicator">
      <div className="typing-avatar" />
      <div className="typing-bubble">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
    </div>
  )
}
