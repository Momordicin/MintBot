// shared/customUrl.ts — 自定义服务按消息格式换算出服务根地址：customUrlRoot(url, format)
// 用法：services/core/routes/config.ts、services/core/routes/models.ts、services/core/providers/ModelProvider.ts 与 src/settings/ModelConfigPanel.tsx 都从这里 import；CUSTOM_URL_SUFFIX 为两种格式要求的地址结尾
// 对应文件：shared/types/index.ts / services/core/routes/config.ts / services/core/routes/models.ts / services/core/providers/ModelProvider.ts / src/settings/ModelConfigPanel.tsx
export type CustomFormat = 'openai' | 'anthropic'

export const CUSTOM_URL_SUFFIX: Record<CustomFormat, string> = {
  openai: '/v1/chat/completions',
  anthropic: '/v1/messages',
}

export function customUrlRoot(url: string, format: CustomFormat): string | null {
  if (!/^https?:\/\//i.test(url)) return null
  try {
    new URL(url)
  } catch {
    return null
  }
  const suffix = CUSTOM_URL_SUFFIX[format]
  if (!url.endsWith(suffix)) return null
  const root = url.slice(0, -suffix.length)
  return /^https?:\/\/[^/]/i.test(root) ? root : null
}
