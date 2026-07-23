import type { FastifyInstance } from 'fastify'
import { getAllPresets } from '../session/queries.js'
import { switchPreset } from '../session/index.js'
import { buildStatePayload } from '../state.js'

export async function presetRoutes(fastify: FastifyInstance) {
  fastify.get('/presets', async () => {
    // 只返回渲染层切换 UI 需要的字段，不广播 systemPrompt 等完整 Preset 数据
    return getAllPresets().map(p => ({ presetId: p.presetId, name: p.name }))
  })

  fastify.post<{
    Body: { presetId: string }
  }>('/switch-preset', async (request, reply) => {
    const { presetId } = request.body
    if (!presetId?.trim()) {
      return reply.status(400).send({ error: 'presetId is required' })
    }

    try {
      switchPreset(presetId)
    } catch {
      // switchPreset/loadSession 目前唯一已知的抛错场景就是 preset 不存在
      return reply.status(404).send({ error: 'Preset not found' })
    }

    // 与 GET /state 返回同一套结构，方便前端直接用返回值刷新页面
    return buildStatePayload(fastify)
  })
}
