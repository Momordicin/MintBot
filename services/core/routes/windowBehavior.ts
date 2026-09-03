import type { FastifyInstance } from 'fastify'
import { getWindowBehaviorConfig, updateWindowBehaviorConfig, type WindowBehaviorConfig } from '../config/index.js'
import { broadcastEvent } from '../events/broadcast.js'

const VALID_PIN_MODES: readonly string[] = ['off', 'dodge-fullscreen', 'always-on-top']

// 校验通过返回 null，失败返回错误信息（供 400 响应使用）——同 routes/config.ts 的
// validateModelConfigPartial 风格：用户主动发起的请求，无效输入直接 400 拒绝整个请求，
// 不做被动文件热重载那套"单字段告警回退"
function validateWindowBehaviorPartial(partial: Partial<WindowBehaviorConfig>): string | null {
  if (partial.pinMode !== undefined && !VALID_PIN_MODES.includes(partial.pinMode)) {
    return 'pinMode must be one of off, dodge-fullscreen, always-on-top'
  }
  if (partial.fullscreenWhitelist !== undefined) {
    if (!Array.isArray(partial.fullscreenWhitelist) || partial.fullscreenWhitelist.some(item => typeof item !== 'string')) {
      return 'fullscreenWhitelist must be an array of strings'
    }
  }
  if (partial.blacklist !== undefined) {
    if (!Array.isArray(partial.blacklist) || partial.blacklist.some(item => typeof item !== 'string')) {
      return 'blacklist must be an array of strings'
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
