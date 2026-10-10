// services/core/routes/windowBehavior.ts — 窗口行为配置（置顶模式、桌宠避让、应用规则）的读取与修改路由，及其变更广播
// 用法：core/index.ts 里 fastify.register(windowBehaviorRoutes)；GET /config/window-behavior、PATCH /config/window-behavior（校验后写配置，revision 变化时广播 window-behavior-changed）；导出 buildWindowBehaviorSnapshot / broadcastWindowBehaviorSnapshot，配置文件监听变更时 core/index.ts 也调用后者
// 形状：响应与广播载荷均为 WindowBehaviorSnapshot { generation, revision, config }
// 对应文件：shared/windowBehavior.ts（快照契约）/ src/settings/WindowBehaviorPanel.tsx / electron/main/windowBehavior.ts / electron/main/index.ts / services/core/routes/windowBehavior.test.ts
import type { FastifyInstance } from 'fastify'
import {
  getWindowBehaviorConfig,
  getWindowBehaviorRevision,
  updateWindowBehaviorConfig,
  VALID_CHAT_PIN_MODES,
  VALID_APP_RULE_EFFECTS,
} from '../config/index.js'
import { broadcastEvent, SERVER_GENERATION } from '../events/broadcast.js'
import type { AppRule, WindowBehaviorConfig, WindowBehaviorSnapshot } from '../../../shared/windowBehavior.js'

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
  fastify.get('/config/window-behavior', async () => buildWindowBehaviorSnapshot())

  fastify.patch<{ Body: Partial<WindowBehaviorConfig> }>('/config/window-behavior', async (request, reply) => {
    const error = validateWindowBehaviorPartial(request.body)
    if (error) {
      return reply.status(400).send({ error })
    }

    const revisionBefore = getWindowBehaviorRevision()
    updateWindowBehaviorConfig(request.body)
    if (getWindowBehaviorRevision() !== revisionBefore) broadcastWindowBehaviorSnapshot()
    return buildWindowBehaviorSnapshot()
  })
}
