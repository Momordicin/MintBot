// services/core/routes/characterImport.ts — 角色卡导入与角色文件夹写入的 HTTP 路由：列角色、解析角色卡、生成人设正文、写头像和 manifest 元数据
// 用法：core/index.ts 里 fastify.register(characterImportRoutes)；GET /characters、POST /characters/import/parse、POST /characters/import/generate、POST /characters/:characterId/avatar、POST /characters/:characterId/metadata
// 形状：角色文件夹 CHARACTERS_ROOT/<characterId>/ 下的头像与 manifest.json
// 对应文件：src/settings/CharacterPanel.tsx（调用方）/ services/core/characters/cardImport.ts / services/core/characters/manifest.ts / services/core/routes/characterImport.test.ts
import type { FastifyInstance } from 'fastify'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { parseCharacterCard } from '../characters/cardImport.js'
import { CHARACTERS_ROOT } from '../characters/manifest.js'
import type { BuiltContext, CompletionOptions } from '../../../shared/types/index.js'

const ALLOWED_AVATAR_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

interface CardGenerationModelProvider {
  completeSync(context: BuiltContext, options?: CompletionOptions): Promise<string>
}

interface CardGenerationFields {
  description: string
  personality: string
  scenario: string
  mesExample: string
  systemPromptRaw: string
}

function buildCardGenerationContext(fields: CardGenerationFields): BuiltContext {
  const system = [
    '你是一个角色人设改写助手，请把用户提供的角色卡结构化字段改写成一段连贯、自然的中文人设正文，',
    '语言风格类似人物小传。直接输出人设正文本身，不要包含任何其它说明文字、标题或 markdown 代码块标记。',
  ].join('\n')

  const lines: string[] = []
  if (fields.description.trim()) lines.push(`外貌与背景：${fields.description.trim()}`)
  if (fields.personality.trim()) lines.push(`性格：${fields.personality.trim()}`)
  if (fields.scenario.trim()) lines.push(`场景设定：${fields.scenario.trim()}`)
  if (fields.mesExample.trim()) lines.push(`对话示例：${fields.mesExample.trim()}`)
  if (fields.systemPromptRaw.trim()) lines.push(`补充人设说明：${fields.systemPromptRaw.trim()}`)

  return {
    system,
    messages: [{ role: 'user', content: lines.join('\n\n') || '（无结构化字段，请生成一段通用的人设占位正文）' }],
  }
}

async function generateCardSystemPrompt(
  fields: CardGenerationFields,
  deps: { model: CardGenerationModelProvider }
): Promise<string> {
  const context = buildCardGenerationContext(fields)
  return deps.model.completeSync(context)
}

function mergeManifestFields(characterId: string, fields: Record<string, unknown>): void {
  const characterDir = path.join(CHARACTERS_ROOT, characterId)
  const manifestPath = path.join(characterDir, 'manifest.json')

  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch {
    raw = {}
  }
  Object.assign(raw, fields)

  fs.mkdirSync(characterDir, { recursive: true })
  const tempPath = `${manifestPath}.tmp-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(tempPath, JSON.stringify(raw, null, 2))
    fs.renameSync(tempPath, manifestPath)
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
    }
    throw err
  }
}

function mergeManifestAvatar(characterId: string, avatarFilename: string): void {
  mergeManifestFields(characterId, { avatar: avatarFilename })
}

export async function characterImportRoutes(fastify: FastifyInstance) {
  fastify.get('/characters', async () => {
    try {
      const entries = fs.readdirSync(CHARACTERS_ROOT, { withFileTypes: true })
      const characterIds = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
      return { characterIds }
    } catch (err) {
      console.error('[Characters] Failed to list character folders:', err)
      return { characterIds: [] }
    }
  })

  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body)
  })

  fastify.post<{ Body: Buffer }>('/characters/import/parse', { bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
    const result = parseCharacterCard(request.body)
    if ('error' in result) {
      return reply.status(400).send({ error: result.error })
    }

    return {
      suggestedCharacterId: result.suggestedCharacterId,
      name: result.name,
      systemPrompt: result.systemPrompt,
      tags: result.tags,
      creator: result.creator,
      creatorNotes: result.creatorNotes,
      characterVersion: result.characterVersion,
      hasEmbeddedAvatar: result.avatarCandidate !== null,
      description: result.description,
      personality: result.personality,
      scenario: result.scenario,
      mesExample: result.mesExample,
      systemPromptRaw: result.systemPromptRaw,
    }
  })

  fastify.post<{
    Body: Partial<CardGenerationFields>
  }>('/characters/import/generate', async (request, reply) => {
    const {
      description = '',
      personality = '',
      scenario = '',
      mesExample = '',
      systemPromptRaw = '',
    } = request.body ?? {}

    try {
      const systemPrompt = await generateCardSystemPrompt(
        { description, personality, scenario, mesExample, systemPromptRaw },
        { model: fastify.backgroundModelProvider }
      )
      return { systemPrompt }
    } catch (err) {
      request.log.error(err, 'Failed to generate character card system prompt')
      return reply.status(502).send({ error: 'Failed to generate system prompt' })
    }
  })

  fastify.post<{
    Params: { characterId: string }
    Body: Buffer
  }>('/characters/:characterId/avatar', { bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    const { characterId } = request.params

    const rawFilename = request.headers['x-filename']
    let filename = ''
    if (typeof rawFilename === 'string') {
      try {
        filename = decodeURIComponent(rawFilename)
      } catch {
        filename = ''
      }
    }
    const ext = path.extname(filename).slice(1).toLowerCase()
    if (!ALLOWED_AVATAR_EXTENSIONS.has(ext)) {
      return reply.status(400).send({ error: 'Unsupported file extension' })
    }

    const characterDir = path.join(CHARACTERS_ROOT, characterId)
    const avatarFilename = `avatar.${ext}`
    const finalPath = path.join(characterDir, avatarFilename)
    const tempPath = `${finalPath}.tmp-${crypto.randomUUID()}`

    try {
      fs.mkdirSync(characterDir, { recursive: true })
      fs.writeFileSync(tempPath, request.body)
      fs.renameSync(tempPath, finalPath)
      mergeManifestAvatar(characterId, avatarFilename)
    } catch (err) {
      try {
        fs.rmSync(tempPath, { force: true })
      } catch {
      }
      request.log.error(err, 'Failed to save character avatar')
      return reply.status(500).send({ error: 'Failed to save avatar' })
    }

    return { avatar: avatarFilename }
  })

  fastify.post<{
    Params: { characterId: string }
    Body: { tags?: string[]; creator?: string; creatorNotes?: string; characterVersion?: string }
  }>('/characters/:characterId/metadata', async (request, reply) => {
    const { characterId } = request.params
    const { tags, creator, creatorNotes, characterVersion } = request.body ?? {}

    const fields: Record<string, unknown> = {}
    if (tags !== undefined) fields.tags = tags
    if (creator !== undefined) fields.creator = creator
    if (creatorNotes !== undefined) fields.creatorNotes = creatorNotes
    if (characterVersion !== undefined) fields.version = characterVersion

    try {
      mergeManifestFields(characterId, fields)
    } catch (err) {
      request.log.error(err, 'Failed to save character metadata')
      return reply.status(500).send({ error: 'Failed to save character metadata' })
    }

    return { ok: true }
  })
}
