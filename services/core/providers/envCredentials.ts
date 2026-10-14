// services/core/providers/envCredentials.ts — 启动时清除进程环境变量中的模型提供方凭据
// 用法：index.ts 的 start() 第一步调用 wipeCredentialEnv()
// 对应文件：services/core/index.ts / services/core/providers/envCredentials.test.ts
export const CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_ADMIN_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'OPENAI_CUSTOM_HEADERS',
] as const

export function wipeCredentialEnv(): void {
  for (const name of CREDENTIAL_ENV_VARS) {
    delete process.env[name]
  }
}
