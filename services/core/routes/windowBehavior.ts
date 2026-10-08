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
    broadcastEvent('window-behavior-changed', getWindowBehaviorConfig())
    return result
  })
}
