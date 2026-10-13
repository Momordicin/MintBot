// services/core/config/configFileError.ts — config.json 无法读取时拒绝写入的错误类型与提示文字
// 用法：config/index.ts 抛出 ConfigFileUnreadableError；配置路由捕获后回复 CONFIG_FILE_UNREADABLE_MESSAGE
// 对应文件：services/core/config/index.ts / services/core/routes/config.ts / services/core/routes/windowBehavior.ts
export const CONFIG_FILE_UNREADABLE_MESSAGE = 'config.json 无法读取或格式不正确，本次没有保存，请修正该文件后重试'

export class ConfigFileUnreadableError extends Error {
  constructor(detail: string) {
    super(`[Config] config.json 无法读取或格式不正确，本次没有写入: ${detail}`)
    this.name = 'ConfigFileUnreadableError'
  }
}
