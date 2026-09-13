import type { FastifyInstance } from 'fastify'
import {
  getWindowBehaviorConfig,
  updateWindowBehaviorConfig,
  VALID_CHAT_PIN_MODES,
  VALID_APP_RULE_EFFECTS,
  type AppRule,
  type WindowBehaviorConfig,
} from '../config/index.js'
import { broadcastEvent } from '../events/broadcast.js'

// 校验通过返回 null，失败返回错误信息（供 400 响应使用）——同 routes/config.ts 的
// validateModelConfigPartial 风格：用户主动发起的请求，无效输入直接 400 拒绝整个请求，
// 不做被动文件热重载那套"单字段告警回退"
function validateWindowBehaviorPartial(partial: Partial<WindowBehaviorConfig>): string | null {
  if (partial.chatPinMode !== undefined && !VALID_CHAT_PIN_MODES.includes(partial.chatPinMode)) {
    return `chatPinMode must be one of ${VALID_CHAT_PIN_MODES.join(', ')}`
  }
  if (partial.petAvoidanceEnabled !== undefined && typeof partial.petAvoidanceEnabled !== 'boolean') {
    return 'petAvoidanceEnabled must be a boolean'
  }
  if (partial.appRules !== undefined) {
    if (!Array.isArray(partial.appRules)) {
      return 'appRules must be an array'
    }
    for (const rule of partial.appRules as AppRule[]) {
      if (typeof rule?.exeName !== 'string' || rule.exeName === '') {
        return 'each appRules entry must have a non-empty string exeName'
      }
      if (!VALID_APP_RULE_EFFECTS.includes(rule.effect)) {
        return `each appRules entry must have an effect of ${VALID_APP_RULE_EFFECTS.join(', ')}`
      }
    }
  }
  return null
}

export async function windowBehaviorRoutes(fastify: FastifyInstance) {
  fastify.get('/config/window-behavior', async () => getWindowBehaviorConfig())

  fastify.patch<{ Body: Partial<WindowBehaviorConfig> }>('/config/window-behavior', async (request, reply) => {
    const error = validateWindowBehaviorPartial(request.body)
    if (error) {
      return reply.status(400).send({ error })
    }

    const result = updateWindowBehaviorConfig(request.body)
    // 广播让主进程（托盘菜单勾选态）和设置页任一端改动后，另一端也能感知最新配置——
    // 跟 session/index.ts 的 preset-switched 同一套广播机制（见 events/broadcast.ts）
    broadcastEvent('window-behavior-changed', getWindowBehaviorConfig())
    return result
  })
}
