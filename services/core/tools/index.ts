// services/core/tools/index.ts — 对话可用工具的注册表：工具定义列表与按名称执行
// 用法：routes/chat.ts 每次模型调用传 TOOL_SCHEMAS，模型返回工具调用后逐个调 executeToolCall(call, 请求的取消信号)
// 对应文件：services/core/routes/chat.ts / services/core/tools/webLookup.ts / services/core/tools/rememberLocation.ts
import type { ToolCall, ToolSchema } from '../../../shared/types/index.js'
import { WEB_LOOKUP_SCHEMA, runWebLookup } from './webLookup.js'
import { REMEMBER_LOCATION_SCHEMA, runRememberLocation } from './rememberLocation.js'

export const TOOL_SCHEMAS: ToolSchema[] = [WEB_LOOKUP_SCHEMA, REMEMBER_LOCATION_SCHEMA]

export async function executeToolCall(call: ToolCall, chatSignal: AbortSignal): Promise<string> {
  switch (call.name) {
    case WEB_LOOKUP_SCHEMA.name:
      return runWebLookup(call.arguments, chatSignal)
    case REMEMBER_LOCATION_SCHEMA.name:
      return runRememberLocation(call.arguments, chatSignal)
    default:
      return `未知工具：${call.name}`
  }
}
