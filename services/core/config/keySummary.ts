// services/core/config/keySummary.ts — 已保存 API Key 的摘要
// 用法：routes/config.ts 的 GET/PATCH /config/model 与 routes/presets.ts 的 GET /presets/:presetId/model-keys 调 summarizeSavedKey
// 对应文件：services/core/routes/config.ts / services/core/routes/presets.ts
const MIN_LAST4_KEY_LENGTH = 8

export function summarizeSavedKey(saved: string | undefined): { hasKey: boolean; last4: string | null } {
  const hasKey = typeof saved === 'string' && saved.length > 0
  return {
    hasKey,
    last4: hasKey && saved.length >= MIN_LAST4_KEY_LENGTH ? saved.slice(-4) : null,
  }
}
