// electron/main/coreUrl.ts — 主进程访问 core 服务的 URL 常量，值为构建期注入的 __CORE_URL__
// 用法：import { CORE_URL } from './coreUrl'
// 对应文件：electron.vite.config.ts（define 注入 __CORE_URL__）/ electron/main/index.ts / electron/main/windowBehavior.ts

declare const __CORE_URL__: string

export const CORE_URL = __CORE_URL__
