// services/core/routes/windowBehavior.ts — 窗口行为配置的读取、修改与变更广播路由
// 用法：core/index.ts 注册 windowBehaviorRoutes；GET、PATCH /config/window-behavior；配置文件变更时 core/index.ts 调 broadcastWindowBehaviorSnapshot
// 对应文件：shared/windowBehavior.ts / src/settings/WindowBehaviorPanel.tsx / services/core/routes/windowBehavior.test.ts / shared/errorCodes.ts
import type { FastifyInstance } from 'fastify'
import { ConfigFileUnreadableError } from '../config/configFileError.js'
import {
  getWindowBehaviorConfig,
  getWindowBehaviorRevision,
  updateWindowBehaviorConfig,
  VALID_CHAT_PIN_MODES,
  VALID_APP_RULE_EFFECTS,
} from '../config/index.js'
import { broadcastEvent, SERVER_GENERATION } from '../events/broadcast.js'
import type { AppRule, WindowBehaviorConfig, WindowBehaviorSnapshot } from '../../../shared/windowBehavior.js'
import { ERROR_CODES, errorBody, invalidRequest, type ErrorBody } from '../../../shared/errorCodes.js'

export function buildWindowBehaviorSnapshot(): WindowBehaviorSnapshot {
  return {
    generation: SERVER_GENERATION,
    revision: getWindowBehaviorRevision(),
    config: getWindowBehaviorConfig(),
  }
}

export function broadcastWindowBehaviorSnapshot(): void {
  broadcastEvent('window-behavior-changed', buildWindowBehaviorSnapshot())
}

function validateWindowBehaviorPartial(partial: Partial<WindowBehaviorConfig>): ErrorBody | null {
  if (partial.chatPinMode !== undefined && !VALID_CHAT_PIN_MODES.includes(partial.chatPinMode)) {
    return invalidRequest(`chatPinMode must be one of ${VALID_CHAT_PIN_MODES.join(', ')}`)
  }
  if (partial.petAvoidanceEnabled !== undefined && typeof partial.petAvoidanceEnabled !== 'boolean') {
    return invalidRequest('petAvoidanceEnabled must be a boolean')
  }
  if (partial.petClickThrough !== undefined && typeof partial.petClickThrough !== 'boolean') {
    return invalidRequest('petClickThrough must be a boolean')
  }
  if (partial.petCollapsed !== undefined && typeof partial.petCollapsed !== 'boolean') {
    return invalidRequest('petCollapsed must be a boolean')
  }
  if (partial.appRules !== undefined) {
    if (!Array.isArray(partial.appRules)) {
      return invalidRequest('appRules must be an array')
    }
    for (const rule of partial.appRules as AppRule[]) {
      if (typeof rule?.exeName !== 'string' || rule.exeName === '') {
        return invalidRequest('each appRules entry must have a non-empty string exeName')
      }
      if (!VALID_APP_RULE_EFFECTS.includes(rule.effect)) {
        return invalidRequest(`each appRules entry must have an effect of ${VALID_APP_RULE_EFFECTS.join(', ')}`)
      }
    }
  }
  return null
}

export async function windowBehaviorRoutes(fastify: FastifyInstance) {
  fastify.get('/config/window-behavior', async () => buildWindowBehaviorSnapshot())

  fastify.patch<{ Body: Partial<WindowBehaviorConfig> }>('/config/window-behavior', async (request, reply) => {
    const error = validateWindowBehaviorPartial(request.body)
    if (error) {
      return reply.status(400).send(error)
    }

    const revisionBefore = getWindowBehaviorRevision()
    try {
      updateWindowBehaviorConfig(request.body)
    } catch (err) {
      if (!(err instanceof ConfigFileUnreadableError)) throw err
      console.error(err.message)
      return reply.status(500).send(errorBody(ERROR_CODES.CONFIG_FILE_UNREADABLE))
    }
    if (getWindowBehaviorRevision() !== revisionBefore) broadcastWindowBehaviorSnapshot()
    return buildWindowBehaviorSnapshot()
  })
}
