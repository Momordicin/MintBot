// services/core/routes/roleConfig.ts — 一键生成角色配置的两个接口：查找备选称呼（SSE 推送进度与结果）、保存用户确认的称呼
// 用法：core/index.ts 注册 roleConfigRoutes；POST /presets/:presetId/role-config/lookup、POST /presets/:presetId/role-config/confirm { names }
// 对应文件：src/settings/useCharacterPanel.ts / src/chat/sse.ts / services/core/roleConfig/lookup.ts / services/core/roleConfig/confirm.ts / shared/errorCodes.ts
import type { OutgoingHttpHeaders } from 'http'
import type { FastifyInstance } from 'fastify'
import { getPresetById } from '../session/queries.js'
import { lookupRoleConfig } from '../roleConfig/lookup.js'
import { normalizeNames, saveNamesDraft } from '../roleConfig/confirm.js'
import { ERROR_CODES, errorBody, invalidRequest } from '../../../shared/errorCodes.js'

export async function roleConfigRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { presetId: string } }>('/presets/:presetId/role-config/lookup', async (request, reply) => {
    const { presetId } = request.params
    const preset = getPresetById(presetId)
    if (!preset) return reply.status(404).send(errorBody(ERROR_CODES.PRESET_NOT_FOUND))

    const abortController = new AbortController()
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) abortController.abort()
    })

    const send = (event: string, data: unknown) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    reply.raw.flushHeaders()

    try {
      const result = await lookupRoleConfig(preset, abortController.signal, (step, state) => send('step', { step, state }))
      send('result', result)
    } catch (err) {
      if (!abortController.signal.aborted) throw err
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end()
    }
  })

  fastify.post<{ Params: { presetId: string }; Body: { names?: unknown } }>('/presets/:presetId/role-config/confirm', async (request, reply) => {
    const { presetId } = request.params
    if (!getPresetById(presetId)) return reply.status(404).send(errorBody(ERROR_CODES.PRESET_NOT_FOUND))

    const names = normalizeNames(request.body?.names)
    if (!names) return reply.status(400).send(invalidRequest('names must be a non-empty array of names'))

    await saveNamesDraft(presetId, names)
    return { names }
  })
}
