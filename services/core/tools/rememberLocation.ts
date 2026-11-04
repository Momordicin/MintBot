// services/core/tools/rememberLocation.ts — 工具 remember_location：把用户说出的地点经联网查询补全为完整名称后写入用户资料
// 用法：tools/index.ts 注册 REMEMBER_LOCATION_SCHEMA 并调 runRememberLocation(args, chatSignal)；写入走 profile/userProfile.ts 的 setLocation
// 对应文件：services/core/tools/index.ts / services/core/tools/subscriptionSearch.ts / services/core/profile/userProfile.ts / services/core/tools/rememberLocation.test.ts
import type { ToolSchema } from '../../../shared/types/index.js'
import { setLocation } from '../profile/userProfile.js'
import { runSubscriptionSearch, NotLoggedInError } from './subscriptionSearch.js'

export const REMEMBER_LOCATION_SCHEMA: ToolSchema = {
  name: 'remember_location',
  description: '用户告诉你所在城市或地区，或者说搬家了时调用，传入用户的原话。',
  parameters: {
    type: 'object',
    properties: {
      place: { type: 'string', description: '用户的原话' },
    },
    required: ['place'],
  },
}

export async function runRememberLocation(args: Record<string, unknown>, chatSignal: AbortSignal): Promise<string> {
  const place = typeof args.place === 'string' ? args.place.trim() : ''
  if (!place) return '参数无效：需要 place'
  let fullName: string
  try {
    fullName = await runSubscriptionSearch(`把地点"${place}"补全为完整的标准名称，格式为"国家 + 省/州 + 市（+ 区县）"，只输出名称本身。`, chatSignal)
  } catch (err) {
    if (err instanceof NotLoggedInError) return err.message
    if (!chatSignal.aborted) {
      console.error('[RememberLocation] lookup failed:', err, `(place=${JSON.stringify(place)})`)
    }
    return '未能记下所在地：查询未能完成'
  }
  if (chatSignal.aborted) return '未能记下所在地：对话已取消'
  try {
    setLocation({ value: fullName, userInput: place })
  } catch (err) {
    console.error('[RememberLocation] write failed:', err, `(place=${JSON.stringify(place)})`)
    return '未能记下所在地：写入用户资料失败'
  }
  return `已记下所在地：${fullName}`
}
