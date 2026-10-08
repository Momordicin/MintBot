// scripts/dev-ai.ts — 以热重载模式手动启动 services/ai，端口取自 services/core/config/ports.ts 的 AI_PORT
//
// 用法：pnpm dev:ai
// 配套文件：services/core/config/ports.ts / services/core/providers/aiService.ts（core 自动托管的同一服务）

import { spawn } from 'child_process'
import path from 'path'
import { AI_PORT, LOOPBACK_HOST } from '../services/core/config/ports'

const VENV_PYTHON = path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe')

const child = spawn(VENV_PYTHON, ['-m', 'uvicorn', 'main:app', '--reload', '--host', LOOPBACK_HOST, '--port', String(AI_PORT)], {
  cwd: path.resolve(process.cwd(), 'services/ai'),
  stdio: 'inherit',
})

process.on('SIGINT', () => {})

child.on('error', (err) => {
  console.error(`[dev:ai] 无法启动 ${VENV_PYTHON}：${err.message}（先运行 pnpm setup:ai）`)
  process.exit(1)
})

child.on('exit', (code) => process.exit(code ?? 1))
