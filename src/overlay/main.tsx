// src/overlay/main.tsx — 桌宠悬浮窗的渲染进程入口：加载全局样式，把 <OverlayApp /> 挂到 #root
// 用法：src/overlay/index.html 以 script 引入；electron/main/index.ts 创建悬浮窗时加载 overlay/index.html；调 initI18n()
// 对应文件：src/overlay/index.html / src/overlay/OverlayApp.tsx / src/i18n.ts / electron/main/index.ts
import React from 'react'
import ReactDOM from 'react-dom/client'
import '../styles/global.css'
import { OverlayApp } from './OverlayApp'
import { I18nextProvider } from 'react-i18next'
import { initI18n } from '../i18n.js'

initI18n().then(i18n => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <OverlayApp />
      </I18nextProvider>
    </React.StrictMode>
  )
})
