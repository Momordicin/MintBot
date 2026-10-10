// src/App.tsx — 聊天窗口的根组件，仅渲染 <ChatWindow />
// 用法：src/main.tsx 渲染 <App />
// 对应文件：src/main.tsx / src/chat/ChatWindow.tsx
import React from 'react'
import { ChatWindow } from './chat/ChatWindow'

export function App() {
  return <ChatWindow />
}
