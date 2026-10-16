// src/main.tsx — 聊天窗口（主窗口）的渲染进程入口：加载全局样式，把 <App /> 挂到 #root
// 用法：src/index.html 以 script 引入；electron/main/index.ts 创建主窗口时加载该页面；调 initI18n()
// 对应文件：src/index.html / src/App.tsx / src/i18n.ts / electron/main/index.ts
import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/global.css'
import { App } from './App'
import { I18nextProvider } from 'react-i18next'
import { initI18n } from './i18n.js'

initI18n().then(i18n => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </React.StrictMode>
  )
})
