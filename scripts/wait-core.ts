// scripts/wait-core.ts — 等待 core 服务 /health 可用后退出，地址取自 services/core/config/ports.ts 的 CORE_URL
//
// 用法：pnpm exec tsx scripts/wait-core.ts && <后续命令>（见 package.json 的 dev:all）
// 配套文件：services/core/config/ports.ts

import waitOn from 'wait-on'
import { CORE_URL } from '../services/core/config/ports'

await waitOn({
  resources: [`${CORE_URL.replace(/^http:/, 'http-get:')}/health`],
  timeout: 120000,
  log: true,
})
