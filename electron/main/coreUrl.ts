// electron/main/coreUrl.ts — Electron 主进程 core 服务 URL 的唯一入口，值来自构建期注入的 __CORE_URL__
//
// 用法：import { CORE_URL } from './coreUrl.js'
// 配套文件：electron.vite.config.ts（注入 __CORE_URL__ 常量）

declare const __CORE_URL__: string

export const CORE_URL = __CORE_URL__
