// services/core/providers/envCredentials.ts — 启动时暂存三家提供方的 API Key 环境变量并清除进程环境中的模型提供方凭据
// 用法：index.ts 的 start() 第一步调用 wipeCredentialEnv()，随后调用 cancelUndetectedEnvSelections()；ModelProvider.ts 调 getEnvCredential，routes/config.ts 调 isEnvCredentialDetected / ENV_VAR_BY_PROVIDER / isEnvCleared / clearEnvCleared
// 对应文件：services/core/index.ts / services/core/providers/ModelProvider.ts / services/core/routes/config.ts / services/core/config/index.ts / services/core/providers/envCredentials.test.ts
import { getModelProviderConfig, updateModelProviderConfig } from '../config/index.js'
import type { ModelConfig } from '../../../shared/types/index.js'

export const CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_ADMIN_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'OPENAI_CUSTOM_HEADERS',
] as const

export type KeyProvider = 'anthropic' | 'openai' | 'deepseek'

export const ENV_VAR_BY_PROVIDER: Record<KeyProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

const envKeys: Record<KeyProvider, string> = { anthropic: '', openai: '', deepseek: '' }

export function wipeCredentialEnv(): void {
  for (const provider of Object.keys(ENV_VAR_BY_PROVIDER) as KeyProvider[]) {
    envKeys[provider] = process.env[ENV_VAR_BY_PROVIDER[provider]]?.trim() ?? ''
  }
  for (const name of CREDENTIAL_ENV_VARS) {
    delete process.env[name]
  }
}

export function getEnvCredential(provider: KeyProvider): string {
  return envKeys[provider]
}

export function isEnvCredentialDetected(provider: KeyProvider): boolean {
  return envKeys[provider] !== ''
}

const FROM_ENV_FIELD = {
  anthropic: 'anthropicApiKeyFromEnv',
  openai: 'openaiApiKeyFromEnv',
  deepseek: 'deepseekApiKeyFromEnv',
} as const

const clearedAtStartup = new Set<KeyProvider>()

export function cancelUndetectedEnvSelections(): void {
  let config: ModelConfig
  try {
    config = getModelProviderConfig()
  } catch {
    return
  }
  const patch: Partial<ModelConfig> = {}
  const cancelled: KeyProvider[] = []
  for (const provider of Object.keys(FROM_ENV_FIELD) as KeyProvider[]) {
    const field = FROM_ENV_FIELD[provider]
    if (config[field] === true && !isEnvCredentialDetected(provider)) {
      patch[field] = false
      cancelled.push(provider)
    }
  }
  if (cancelled.length === 0) return
  try {
    updateModelProviderConfig(patch)
  } catch (err) {
    console.error('[Startup] failed to cancel undetected env credential selections:', err)
    return
  }
  for (const provider of cancelled) clearedAtStartup.add(provider)
}

export function isEnvCleared(provider: KeyProvider): boolean {
  return clearedAtStartup.has(provider)
}

export function clearEnvCleared(provider: KeyProvider): void {
  clearedAtStartup.delete(provider)
}
