// services/core/routes/transitions.ts — 转场链接口：每次请求现读角色 manifest，返回某个触发器可用的转场步骤（素材候选 + 时长）
//
// 用法：fastify.register(transitionRoutes)；GET /transitions/:characterId/:trigger?form=pixel（刻意放在 /characters/ 静态前缀之外，不遮蔽角色包内真实的 transitions/ 素材） → { steps: [{ files, durationMs }] }；角色/manifest 不可用时返回 200 { steps: [] }，参数非法返回 400
// 配套文件：services/core/characters/manifestAssets.ts / services/core/index.ts / src/overlay/OverlayApp.tsx / services/core/routes/transitions.test.ts

import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import { CHARACTERS_ROOT } from '../characters/manifest.js'
import {
  PORTRAIT_FORMS,
  logAssetProblems,
  resolveTransitionChain,
  type PortraitFormName,
} from '../characters/manifestAssets.js'

const TRIGGER_PATTERN = /^[A-Za-z0-9_-]+$/

function isSafeCharacterId(characterId: string): boolean {
  return characterId !== '' && characterId !== '.' && characterId !== '..' && !/[\\/\0]/.test(characterId)
}

function isPortraitForm(value: unknown): value is PortraitFormName {
  return PORTRAIT_FORMS.some(form => form === value)
}

export async function transitionRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Params: { characterId: string; trigger: string }
    Querystring: { form?: unknown }
  }>('/transitions/:characterId/:trigger', async (request, reply) => {
    const { characterId, trigger } = request.params
    const form = request.query.form ?? 'pixel'

    if (!isSafeCharacterId(characterId)) return reply.code(400).send({ error: 'invalid characterId' })
    if (!TRIGGER_PATTERN.test(trigger)) return reply.code(400).send({ error: 'invalid trigger' })
    if (!isPortraitForm(form)) return reply.code(400).send({ error: 'invalid form' })

    const characterDir = path.join(CHARACTERS_ROOT, characterId)
    let rawManifest: unknown
    try {
      rawManifest = JSON.parse(fs.readFileSync(path.join(characterDir, 'manifest.json'), 'utf-8'))
    } catch (err) {
      console.warn(`[Transition] character=${characterId} trigger=${trigger} manifest.json 不可读取或解析失败，返回空转场链`, err)
      return { steps: [] }
    }

    const { steps, problems } = resolveTransitionChain({ characterId, characterDir, rawManifest, trigger, form })
    logAssetProblems(problems)
    return { steps }
  })
}
