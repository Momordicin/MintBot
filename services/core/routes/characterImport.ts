import type { FastifyInstance } from 'fastify'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { parseCharacterCard } from '../characters/cardImport.js'
import { CHARACTERS_ROOT } from '../characters/manifest.js'
import type { BuiltContext, CompletionOptions } from '../../../shared/types/index.js'

// 角色卡导入（docs/MintBot_TDD.md §3.7 附「角色卡导入」）的四个路由：
// 1. POST /characters/import/parse    — 纯解析/合成，不写盘，供"预览再手工编辑"的导入流程使用
// 2. POST /characters/import/generate — 模型辅助改写路径，走 backgroundModelProvider（整理模式模型），
//                                        不占用对话链路
// 3. POST /characters/:characterId/avatar   — 可选的后续步骤，仅当卡片是 PNG 且用户希望保留头像时才调用
// 4. POST /characters/:characterId/metadata — 每次导入创建后都会调用，把 tags/creator/creatorNotes/
//                                              character_version 写入 manifest.json（字段映射见 TDD 表格）

// 与 services/core/routes/presets.ts 的壁纸上传同一扩展名白名单约定（就近各自维护一份，
// 避免两个本就独立演进的上传场景共用同一个常量产生耦合）
const ALLOWED_AVATAR_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

// ─── 模型辅助生成：窄 DI 接口 + 上下文构造函数，参照 services/core/memory/summarizer.ts 的模式 ───

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
  // 不显式传 maxTokens：deps.model（fastify.backgroundModelProvider）在 index.ts 组装时
  // 已经用 backgroundModelProvider 配置构造好了（ModelProvider.resolveMaxTokens 的三级
  // fallback），这里不传等价于沿用那份配置里的 maxTokens——理由同 summarizer.ts generateSummary
  return deps.model.completeSync(context)
}

// config/index.ts 的 writeConfigSection 同款"读整份原始 JSON，只替换自己拥有的 key，
// 其余字段原样写回"合并策略，落在角色包 manifest.json 上——manifest.json 里其它字段
// （emotionVocabulary、portraits 等）本轮导入完全不碰，必须原样保留。avatar 上传
// （mergeManifestAvatar）与下方 POST /characters/:characterId/metadata 路由共用这份
// 原子写入逻辑，各自只决定往 raw 上合并哪些 key
function mergeManifestFields(characterId: string, fields: Record<string, unknown>): void {
  const characterDir = path.join(CHARACTERS_ROOT, characterId)
  const manifestPath = path.join(characterDir, 'manifest.json')

  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch {
    // 文件不存在或解析失败：视为"还没有 manifest"，写一份只含所给字段的最小 manifest
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
      // 清理失败不应掩盖上面的原始错误
    }
    throw err
  }
}

function mergeManifestAvatar(characterId: string, avatarFilename: string): void {
  mergeManifestFields(characterId, { avatar: avatarFilename })
}

export async function characterImportRoutes(fastify: FastifyInstance) {
  // 角色文件夹下拉框（CharacterPanel.tsx §1）：列出 CHARACTERS_ROOT 下已有的角色包子目录名。
  // 只按目录筛选，不校验目录内是否真的有 manifest.json——manifest 缺失时
  // loadCharacterManifest 已经能优雅降级（返回 null，角色只是没有立绘），这里不重复那层校验
  fastify.get('/characters', async () => {
    // readdirSync 失败（目录不存在/不可读）不该让整个请求抛 500——渲染层没有错误边界，
    // 一份非 2xx 响应体如果被当成成功解析会导致 characterIds 变成 undefined，
    // 渲染时 .map/.includes 直接崩掉整棵设置页组件树，降级返回空列表更安全
    try {
      const entries = fs.readdirSync(CHARACTERS_ROOT, { withFileTypes: true })
      const characterIds = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
      return { characterIds }
    } catch (err) {
      console.error('[Characters] Failed to list character folders:', err)
      return { characterIds: [] }
    }
  })

  // 本插件自己的原始二进制 body 请求（parse/avatar 两条路由都用）。这是一个独立的
  // encapsulated 插件上下文，presets.ts 里注册的同名 content type parser 不会跨插件边界
  // 生效（sibling 插件互不继承，只有父子链才继承）——因此这里必须自己重新注册一次，
  // 即便解析逻辑与 presets.ts 完全一样
  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body)
  })

  // bodyLimit 必须与 electron/main/index.ts 的 CHARACTER_CARD_MAX_BYTES 保持一致：
  // 文件选择框已经按 5MB 拦过一次，Fastify 这边若继续使用全局默认的 1MB，会让选择框
  // 放行的、体积在 1-5MB 之间的文件（如带内嵌头像的 PNG 卡）在到达解析逻辑之前就被 413 拒绝
  fastify.post<{ Body: Buffer }>('/characters/import/parse', { bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
    const result = parseCharacterCard(request.body)
    if ('error' in result) {
      return reply.status(400).send({ error: result.error })
    }

    // creatorNotes 与 systemPrompt 是分开的两个字段（规范明令 creator_notes 不得进入 prompt），
    // 这里逐字段挑选返回值，避免以后往 ParsedCharacterCard 加字段时不小心把内部字段
    // （如 avatarCandidate 这个 Buffer）意外序列化进响应
    return {
      suggestedCharacterId: result.suggestedCharacterId,
      name: result.name,
      systemPrompt: result.systemPrompt,
      tags: result.tags,
      creator: result.creator,
      creatorNotes: result.creatorNotes,
      characterVersion: result.characterVersion,
      hasEmbeddedAvatar: result.avatarCandidate !== null,
      // 结构化字段：本轮不落库，只为了让前端能在"模型辅助改写"时原样带回来
      // （见 POST /characters/import/generate），不需要前端重新上传整份原始卡片
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
      // 这是一个可选的"重新生成"动作，失败时前端应该保留文本框里已有的内容而不是阻塞整个
      // 导入流程——502 让前端能区分"这次改写失败，可重试/放弃"与其它 4xx 校验错误
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
        // 畸形 percent-encoding，落到下面扩展名校验的 400 分支，不让 URIError 冒泡成 500
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
    // 同 presets.ts 壁纸上传：先写临时文件，再同目录 rename，避免直接覆写可能被其它
    // 已打开的 @fastify/static 响应占用的目标文件
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
        // 清理失败不应掩盖上面的原始错误
      }
      request.log.error(err, 'Failed to save character avatar')
      return reply.status(500).send({ error: 'Failed to save avatar' })
    }

    return { avatar: avatarFilename }
  })

  // 角色卡的 tags/creator/creatorNotes/character_version 落盘路径（TDD 字段映射表）。
  // 与 /avatar 不同，这一步对每次导入创建都会调用（JSON 卡片没有头像，但同样有这四个字段
  // 要写入 manifest），因此单独成路由，不依赖 mergeManifestAvatar 是否被调用过。
  // characterVersion 映射到 manifest 的 version 字段（TDD 命名不同，语义相同）。请求体
  // 每个字段都是可选的——只合并调用方实际提供的字段，未提供的字段不应被当作"清空"处理
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
