// electron/main/logBootstrap.ts — 主进程启动时加载 .env 并安装日志文件 app.log（LOG_DIR 优先，否则打包后写 app.getPath('logs')，开发时写 <cwd>/logs）
// 用法：作为 electron/main/index.ts 的第一条 import，副作用导入即生效
// 对应文件：shared/logFile.ts（installLogFile）/ services/core/logBootstrap.ts（core 服务端对应项）/ electron/main/index.ts
import { app } from 'electron'
import { resolve } from 'path'
import * as dotenv from 'dotenv'
import { installLogFile } from '../../shared/logFile.js'

dotenv.config({ quiet: true })

installLogFile({
  dir: process.env.LOG_DIR || (app.isPackaged ? app.getPath('logs') : resolve(process.cwd(), 'logs')),
  fileName: 'app.log',
  source: 'main',
})
