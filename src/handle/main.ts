// src/handle/main.ts — 穿透时桌宠手柄小窗口的渲染进程入口：加载样式，右键唤出桌宠菜单
// 用法：src/handle/index.html 以 script 引入；electron/main/petHandleWindow.ts 创建的手柄窗口加载 handle/index.html；调 electronAPI.openPetHandleContextMenu；调 initI18n()
// 对应文件：src/handle/index.html / src/handle/handle.css / src/i18n.ts / electron/main/petHandleWindow.ts / electron/main/index.ts（pet-handle:context-menu）
import './handle.css'
import { initI18n } from '../i18n.js'

void initI18n()

document.addEventListener('contextmenu', event => {
  event.preventDefault()
  window.electronAPI.openPetHandleContextMenu()
})
