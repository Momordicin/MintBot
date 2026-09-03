import React from 'react'
import ReactDOM from 'react-dom/client'
// 多入口构建下每个入口是独立模块图，不会自动继承 src/main.tsx 的全局样式引入
import '../styles/global.css'
import { OverlayApp } from './OverlayApp'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>
)
