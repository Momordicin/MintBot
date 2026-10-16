// shared/errorCodes.ts — core 返回给渲染进程的错误代码与响应体
// 用法：services/core/routes/*.ts 与 characters/cardImport.ts 用 errorBody / invalidRequest 生成响应体；src/errorText.ts 与各面板用 isErrorBody 判断并按代码翻译
// 对应文件：services/core/routes/chat.ts / services/core/routes/presets.ts / services/core/routes/models.ts / src/errorText.ts
export const ERROR_CODES = {
  API_KEY_INVALID: 'API_KEY_INVALID',
  SUMMARY_API_KEY_INVALID: 'SUMMARY_API_KEY_INVALID',
  ENV_VAR_MISSING: 'ENV_VAR_MISSING',
  MODEL_LIST_FAILED: 'MODEL_LIST_FAILED',
  OLLAMA_START_FAILED: 'OLLAMA_START_FAILED',
  CARD_DATA_NOT_FOUND: 'CARD_DATA_NOT_FOUND',
  CARD_BASE64_INVALID: 'CARD_BASE64_INVALID',
  CARD_JSON_INVALID: 'CARD_JSON_INVALID',
  CONFIG_FILE_UNREADABLE: 'CONFIG_FILE_UNREADABLE',
  AGENT_LOGIN_LAUNCH_FAILED: 'AGENT_LOGIN_LAUNCH_FAILED',
  PRESET_NOT_FOUND: 'PRESET_NOT_FOUND',
  LAST_PRESET_UNDELETABLE: 'LAST_PRESET_UNDELETABLE',
  WALLPAPER_SAVE_FAILED: 'WALLPAPER_SAVE_FAILED',
  WALLPAPER_UNSUPPORTED_EXTENSION: 'WALLPAPER_UNSUPPORTED_EXTENSION',
  NO_ACTIVE_SESSION: 'NO_ACTIVE_SESSION',
  CONTEXT_BUILD_FAILED: 'CONTEXT_BUILD_FAILED',
  SYSTEM_PROMPT_GENERATION_FAILED: 'SYSTEM_PROMPT_GENERATION_FAILED',
  AVATAR_SAVE_FAILED: 'AVATAR_SAVE_FAILED',
  CHARACTER_METADATA_SAVE_FAILED: 'CHARACTER_METADATA_SAVE_FAILED',
  MODEL_CALL_FAILED: 'MODEL_CALL_FAILED',
  SESSION_DELETED: 'SESSION_DELETED',
  INVALID_REQUEST: 'INVALID_REQUEST',
} as const

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES]

export type ErrorBody = { code: ErrorCode; params?: Record<string, string> }

export function errorBody(code: ErrorCode, params?: Record<string, string>): ErrorBody {
  return params ? { code, params } : { code }
}

export function invalidRequest(detail: string): ErrorBody {
  return { code: ERROR_CODES.INVALID_REQUEST, params: { detail } }
}

export function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string'
}
