// services/core/routes/transitionChain.ts — 悬浮窗转场链查询路由：现读角色 manifest.json，返回某触发点整条转场链里可用的素材步骤
// 用法：core/index.ts 里 fastify.register(transitionChainRoutes)；GET /overlay/transition-chain?characterId&trigger&form（pixel | illustration）；角色不存在、manifest 读不到或没有该触发点时返回 { steps: [] }
// 形状：响应 TransitionChainResponse { steps }
// 对应文件：src/overlay/OverlayApp.tsx（调用方）/ shared/transitionChain.ts（契约）/ services/core/characters/transitionChain.ts（解析与检查）/ services/core/routes/transitionChain.test.ts

import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import { CHARACTERS_ROOT } from '../characters/manifest.js'
import { resolveTransitionChain } from '../characters/transitionChain.js'
import {
  TRANSITION_FORMS,
  type TransitionChainResponse,
  type TransitionForm,
} from '../../../shared/transitionChain.js'

function isSafeCharacterId(characterId: string): boolean {
  return characterId !== '' && characterId !== '.' && characterId !== '..' && !/[/\\]/.test(characterId)
}

function readRawManifest(characterId: string, characterDir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(characterDir, 'manifest.json'), 'utf-8'))
  } catch (err) {
    console.warn(`[Transition] 角色 ${characterId} manifest.json 读取或解析失败，按空链处理`, err)
    return null
  }
}

export async function transitionChainRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Querystring: { characterId?: string; trigger?: string; form?: string }
  }>('/overlay/transition-chain', async (request, reply) => {
    const { characterId, trigger, form } = request.query
    if (typeof characterId !== 'string' || !isSafeCharacterId(characterId)) {
      return reply.status(400).send({ error: 'Invalid characterId' })
    }
    if (typeof trigger !== 'string' || trigger === '') {
      return reply.status(400).send({ error: 'Invalid trigger' })
    }
    if (typeof form !== 'string' || !(TRANSITION_FORMS as readonly string[]).includes(form)) {
      return reply.status(400).send({ error: `form must be one of ${TRANSITION_FORMS.join(', ')}` })
    }

    const characterDir = path.join(CHARACTERS_ROOT, characterId)
    const response: TransitionChainResponse = {
      steps: resolveTransitionChain({
        characterId,
        characterDir,
        raw: readRawManifest(characterId, characterDir),
        trigger,
        form: form as TransitionForm,
      }),
    }
    return response
  })
}
