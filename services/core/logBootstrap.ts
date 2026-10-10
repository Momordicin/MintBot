// services/core/logBootstrap.ts
// 用途：核心服务启动时安装日志文件（LOG_DIR 缺省为 <cwd>/logs，文件名 core.log）
// 用法：必须是 services/core/index.ts 的第一条 import——pino 在构造 Fastify logger 时检测 process.stdout
//   是否被改写，只有先装好才会改走 process.stdout，pino 行才能进入日志文件
// 对应方：shared/logFile.ts；Electron 主进程对应 electron/main/logBootstrap.ts
import path from 'path'
import * as dotenv from 'dotenv'
import { installLogFile } from '../../shared/logFile.js'

dotenv.config({ quiet: true })

installLogFile({
  dir: process.env.LOG_DIR || path.resolve(process.cwd(), 'logs'),
  fileName: 'core.log',
  source: 'core',
})
