// src/main.tsx — 聊天窗口（主窗口）的渲染进程入口：加载全局样式，把 <App /> 挂到 #root
// 用法：src/index.html 以 script 引入；electron/main/index.ts 创建主窗口时加载该页面
// 对应文件：src/index.html / src/App.tsx / electron/main/index.ts
import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/global.css'
import { App } from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
