// src/settings/main.tsx — 设置窗口的渲染进程入口：加载全局样式，把 <SettingsApp /> 挂到 #root
// 用法：src/settings/index.html 以 script 引入；electron/main/index.ts 响应 open-settings-window 时创建窗口并加载 settings/index.html
// 对应文件：src/settings/index.html / src/settings/SettingsApp.tsx / electron/main/index.ts
import React from 'react'
import ReactDOM from 'react-dom/client'
import '../styles/global.css'
import { SettingsApp } from './SettingsApp'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
)
