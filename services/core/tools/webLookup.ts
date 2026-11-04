// services/core/tools/webLookup.ts — 工具 web_lookup：联网查询实时信息，把分点要点连同"用角色口吻转述"的要求交回模型
// 用法：tools/index.ts 注册 WEB_LOOKUP_SCHEMA 并调 runWebLookup(args, chatSignal)
// 对应文件：services/core/tools/index.ts / services/core/tools/subscriptionSearch.ts / services/core/tools/webLookup.test.ts
import type { ToolSchema } from '../../../shared/types/index.js'
import { runSubscriptionSearch, withLocalTime, NotLoggedInError } from './subscriptionSearch.js'

export const WEB_LOOKUP_SCHEMA: ToolSchema = {
  name: 'web_lookup',
  description: '联网查询实时信息（天气、新闻、价格、营业时间等）。查询内容要完整、独立；涉及地点时写明用户资料中的所在地；需要地点但用户资料中没有所在地、对话中也没有提到时，不要调用本工具，先用你自己的口吻问用户在哪个城市。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '完整、独立的查询内容' },
    },
    required: ['query'],
  },
}

export async function runWebLookup(args: Record<string, unknown>, chatSignal: AbortSignal): Promise<string> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return '参数无效：需要 query'
  try {
    const points = await runSubscriptionSearch(withLocalTime(query), chatSignal)
    return `以下是查询到的资料，只作参考：\n${points}\n请用你自己的口吻和说话方式，把用户关心的部分告诉用户，不要照抄原文。`
  } catch (err) {
    if (err instanceof NotLoggedInError) return err.message
    if (!chatSignal.aborted) {
      console.error('[WebLookup] failed:', err, `(query=${JSON.stringify(query)})`)
    }
    return '查询未能完成'
  }
}
