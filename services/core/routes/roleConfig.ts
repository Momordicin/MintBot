// services/core/routes/roleConfig.ts — 一键生成角色配置的接口：查找备选称呼、保存用户确认的称呼、合成并识别朗读、找错写并写入错写表、查询是否已配置完整
// 用法：core/index.ts 注册 roleConfigRoutes；POST /presets/:presetId/role-config/{lookup,synthesize,finish { samples }}（SSE 推送进度与结果）、POST .../confirm { names }、GET .../status
// 对应文件：src/settings/useCharacterPanel.ts / src/chat/sse.ts / services/core/roleConfig/lookup.ts / services/core/roleConfig/collect.ts / services/core/roleConfig/confirm.ts / services/core/roleConfig/hotwords.ts / shared/errorCodes.ts
import type { OutgoingHttpHeaders } from 'http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { getPresetById } from '../session/queries.js'
import { lookupRoleConfig } from '../roleConfig/lookup.js'
import { normalizeNames, readNamesDraft, saveNamesDraft } from '../roleConfig/confirm.js'
import { RoleConfigStepFailed, finishRoleConfig, synthesizeRoleConfig, type CollectStep, type CollectStepState, type RoleConfigSample } from '../roleConfig/collect.js'
import { isComplete, readHotwords } from '../roleConfig/hotwords.js'
import { ERROR_CODES, errorBody, invalidRequest } from '../../../shared/errorCodes.js'

function normalizeSamples(value: unknown): RoleConfigSample[] | null {
  if (!Array.isArray(value)) return null
  const samples: RoleConfigSample[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const { name, script, transcript } = item as Record<string, unknown>
    if (typeof name !== 'string' || typeof script !== 'string' || typeof transcript !== 'string') return null
    samples.push({ name, script, transcript })
  }
  return samples
}

async function streamSteps<T>(
  reply: FastifyReply,
  run: (signal: AbortSignal, onStep: (step: CollectStep, state: CollectStepState, update?: boolean) => void) => Promise<T>
): Promise<void> {
  const abortController = new AbortController()
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) abortController.abort()
  })

  const send = (event: string, data: unknown) => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return
    reply.raw.write(`event: ${event}
data: ${JSON.stringify(data)}

`)
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
    send('result', await run(abortController.signal, (step, state, update) => send('step', update === undefined ? { step, state } : { step, state, update })))
  } catch (err) {
    if (!abortController.signal.aborted && !(err instanceof RoleConfigStepFailed)) throw err
  } finally {
    if (!reply.raw.writableEnded) reply.raw.end()
  }
}

export async function roleConfigRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { presetId: string } }>('/presets/:presetId/role-config/status', async (request, reply) => {
    const { presetId } = request.params
    if (!getPresetById(presetId)) return reply.status(404).send(errorBody(ERROR_CODES.PRESET_NOT_FOUND))
    const names = await readNamesDraft(presetId)
    return { complete: names !== null && isComplete(await readHotwords(), presetId, names) }
  })

  fastify.post<{ Params: { presetId: string } }>('/presets/:presetId/role-config/synthesize', async (request, reply) => {
    const { presetId } = request.params
    if (!getPresetById(presetId)) return reply.status(404).send(errorBody(ERROR_CODES.PRESET_NOT_FOUND))
    if (!(await readNamesDraft(presetId))) return reply.status(409).send(invalidRequest('names draft not found'))
    await streamSteps(reply, (signal, onStep) => synthesizeRoleConfig(presetId, signal, onStep))
  })

  fastify.post<{ Params: { presetId: string }; Body: { samples?: unknown } }>('/presets/:presetId/role-config/finish', async (request, reply) => {
    const { presetId } = request.params
    const preset = getPresetById(presetId)
    if (!preset) return reply.status(404).send(errorBody(ERROR_CODES.PRESET_NOT_FOUND))
    const samples = normalizeSamples(request.body?.samples)
    if (!samples) return reply.status(400).send(invalidRequest('samples must be an array of { name, script, transcript } strings'))
    if (!(await readNamesDraft(presetId))) return reply.status(409).send(invalidRequest('names draft not found'))
    await streamSteps(reply, (signal, onStep) => finishRoleConfig(preset, samples, signal, onStep))
  })

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
