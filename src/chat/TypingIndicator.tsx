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
