// services/core/config/ports.ts — 唯一读取端口环境变量的模块，派生出 core/AI 的 URL 与渲染进程 CORS 来源
//
// 用法：import { LOOPBACK_HOST, RENDERER_HOST, CORE_PORT, AI_PORT, RENDERER_PORT, CORE_URL, AI_URL, RENDERER_ORIGIN, RENDERER_ORIGINS } from './ports.js'
// 配套文件：services/core/config/ports.test.ts / services/core/index.ts / services/core/providers/aiService.ts / scripts/dev-ai.ts / electron.vite.config.ts

import * as dotenv from 'dotenv'

dotenv.config({ quiet: true })

function resolvePort(envValue: string | undefined, defaultValue: number, envName: string): number {
  if (envValue === undefined) return defaultValue
  const parsed = parseInt(envValue, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[Config] Invalid ${envName}="${envValue}", falling back to ${defaultValue}`)
    return defaultValue
  }
  return parsed
}

export const LOOPBACK_HOST = '127.0.0.1'
export const RENDERER_HOST = 'localhost'

export const CORE_PORT = resolvePort(process.env.CORE_PORT, 18300, 'CORE_PORT')
export const AI_PORT = resolvePort(process.env.AI_PORT, 18765, 'AI_PORT')
export const RENDERER_PORT = resolvePort(process.env.VITE_PORT, 18173, 'VITE_PORT')

export const CORE_URL = `http://${LOOPBACK_HOST}:${CORE_PORT}`
export const AI_URL = `http://${LOOPBACK_HOST}:${AI_PORT}`

export const RENDERER_ORIGIN = `http://${RENDERER_HOST}:${RENDERER_PORT}`
export const RENDERER_ORIGINS: readonly string[] = [RENDERER_ORIGIN, `http://${LOOPBACK_HOST}:${RENDERER_PORT}`]
