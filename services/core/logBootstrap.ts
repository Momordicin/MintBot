// services/core/logBootstrap.ts — core 进程日志文件的安装入口：加载 .env 后调 installLogFile，写入 LOG_DIR（缺省 <cwd>/logs）下的 core.log
// 用法：services/core/index.ts 的第一条 import，仅靠 import 时的副作用生效；进程内之后的 console 与 pino 输出均写入该文件
// 对应文件：shared/logFile.ts / electron/main/logBootstrap.ts（主进程对应物）/ services/core/index.ts / services/core/logBootstrap.test.ts
import path from 'path'
import * as dotenv from 'dotenv'
import { installLogFile } from '../../shared/logFile.js'

dotenv.config({ quiet: true })

installLogFile({
  dir: process.env.LOG_DIR || path.resolve(process.cwd(), 'logs'),
  fileName: 'core.log',
  source: 'core',
})
