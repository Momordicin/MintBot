// electron/main/logBootstrap.ts
// 用途：桌面端主进程启动时安装日志文件（文件名 app.log）；LOG_DIR（含 .env 里的）优先，否则打包后写
//   app.getPath('logs')，开发时写 <cwd>/logs
// 用法：必须是 electron/main/index.ts 的第一条 import；app.isPackaged 与 app.getPath('logs') 在 app ready 之前即可调用
// 对应方：shared/logFile.ts；核心服务对应 services/core/logBootstrap.ts
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
