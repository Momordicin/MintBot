// electron/main/appOrigin.ts — 主进程加载打包后渲染页面所用的 app:// 来源常量，值为构建期注入的 __APP_ORIGIN__
// 用法：import { APP_ORIGIN } from './appOrigin'
// 对应文件：electron.vite.config.ts（define 注入 __APP_ORIGIN__）/ electron/main/index.ts / services/core/config/ports.ts

declare const __APP_ORIGIN__: string

export const APP_ORIGIN = __APP_ORIGIN__
