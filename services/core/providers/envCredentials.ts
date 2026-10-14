// services/core/providers/envCredentials.ts — 启动时暂存三家提供方的 API Key 环境变量并清除进程环境中的模型提供方凭据
// 用法：index.ts 的 start() 第一步调用 wipeCredentialEnv()；ModelProvider.ts 调 getEnvCredential，routes/config.ts 调 isEnvCredentialDetected / ENV_VAR_BY_PROVIDER
// 对应文件：services/core/index.ts / services/core/providers/ModelProvider.ts / services/core/routes/config.ts / services/core/providers/envCredentials.test.ts
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
