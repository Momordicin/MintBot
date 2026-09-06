import type { FastifyInstance } from 'fastify'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { getAllPresets, getPresetById, createPreset, updatePresetWallpaper, updatePresetName, updatePresetDisplayConfig, updatePresetSystemPrompt, updatePresetModelConfig } from '../session/queries.js'
import { switchPreset, refreshCurrentPresetIfActive } from '../session/index.js'
import { buildStatePayload } from '../state.js'
import {
  isValidChatBgRgb,
  isValidChatBgOpacity,
  isValidThemeMode,
  isValidAccentRgb,
  isValidTintStrength,
  clampTintStrength,
  DEFAULT_DISPLAY_CONFIG,
} from '../session/displayConfig.js'
import type { PresetDisplayConfig } from '../../../shared/types/index.js'

// 与 services/core/index.ts 里 @fastify/static 的 data/wallpapers 注册使用同一路径约定
const WALLPAPER_DIR = path.resolve(process.cwd(), 'data/wallpapers')
const ALLOWED_WALLPAPER_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const VALID_MODEL_TYPES: readonly string[] = ['anthropic', 'openai', 'ollama', 'deepseek']

export async function presetRoutes(fastify: FastifyInstance) {
  fastify.get('/presets', async () => {
    // 只返回渲染层切换 UI 需要的字段，不广播 systemPrompt 等完整 Preset 数据
    return getAllPresets().map(p => ({ presetId: p.presetId, name: p.name }))
  })

  fastify.post<{
    Body: { name: string; characterId: string; systemPrompt: string }
  }>('/presets', async (request, reply) => {
    const { name, characterId, systemPrompt } = request.body

    const trimmedName = name?.trim()
    if (!trimmedName) {
      return reply.status(400).send({ error: 'name is required' })
    }

    // 只校验非空，不校验 assets/characters/ 下是否真的有这个文件夹——角色包缺失时
    // loadCharacterManifest 已经能优雅降级（返回 null，空词表），不需要在这里提前拦截
    const trimmedCharacterId = characterId?.trim()
    if (!trimmedCharacterId) {
      return reply.status(400).send({ error: 'characterId is required' })
    }

    const trimmedSystemPrompt = systemPrompt?.trim()
    if (!trimmedSystemPrompt) {
      return reply.status(400).send({ error: 'systemPrompt is required' })
    }

    // presetId 服务端生成（同 services/core/session/index.ts 生成 sessionId 的方式）——
    // 内部标识符不该要求用户手打，也避免用户输入撞上已有 id
    const presetId = crypto.randomUUID()
    createPreset({
      presetId,
      name: trimmedName,
      characterId: trimmedCharacterId,
      // 新建 preset 默认跟随全局对话模型配置，不强制创建者一开始就选模型
      // （与 PATCH /presets/:presetId 里 modelType/modelName 都为 null 的"清除覆盖"语义一致）
      modelType: null,
      modelName: null,
      wallpaperPath: undefined,
      displayConfig: DEFAULT_DISPLAY_CONFIG,
      systemPrompt: trimmedSystemPrompt,
      addressForms: [],
    })

    // 与 GET /presets 同一套精简 DTO，不广播 systemPrompt 等完整 Preset 字段
    return { presetId, name: trimmedName }
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
    return buildStatePayload()
  })

  // 本服务目前唯一的原始二进制 body 接口（其余都是 JSON）。content type parser 按
  // content-type 字符串匹配，只影响 application/octet-stream 请求，不影响本插件内
  // /presets、/switch-preset 的 JSON 解析
  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body)
  })

  fastify.post<{
    Params: { presetId: string }
    Body: Buffer
  }>('/presets/:presetId/wallpaper', { bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    const { presetId } = request.params
    if (!getPresetById(presetId)) {
      return reply.status(404).send({ error: 'Preset not found' })
    }

    const rawFilename = request.headers['x-filename']
    let filename = ''
    if (typeof rawFilename === 'string') {
      try {
        filename = decodeURIComponent(rawFilename)
      } catch {
        // 畸形 percent-encoding（如裸 %）当作无效文件名处理，落到下面扩展名校验的 400 分支，
        // 不让 URIError 冒泡成 Fastify 的通用 500
        filename = ''
      }
    }
    const ext = path.extname(filename).slice(1).toLowerCase()
    if (!ALLOWED_WALLPAPER_EXTENSIONS.has(ext)) {
      return reply.status(400).send({ error: 'Unsupported file extension' })
    }

    // 按 presetId 生成确定性文件名，不用原始文件名（路径穿越风险）：同一 preset 用同一
    // 扩展名重新上传时自然覆盖旧文件；换了扩展名会留下一个孤儿旧文件，属已知的可接受缺口
    const savedFilename = `${presetId}-wallpaper.${ext}`
    const finalPath = path.join(WALLPAPER_DIR, savedFilename)
    // 覆盖场景下 finalPath 可能正被聊天窗口的壁纸 <img> 或其它已打开的 @fastify/static
    // 响应读取，直接 writeFileSync 到 finalPath 在 Windows 上可能因文件被占用而失败；
    // 先写临时文件，再用同目录 rename（同一文件系统内原子操作，不要求对目标独占访问）覆盖过去
    const tempPath = `${finalPath}.tmp-${crypto.randomUUID()}`

    try {
      fs.mkdirSync(WALLPAPER_DIR, { recursive: true })
      fs.writeFileSync(tempPath, request.body)
      fs.renameSync(tempPath, finalPath)
      updatePresetWallpaper(presetId, savedFilename)
    } catch (err) {
      try {
        fs.rmSync(tempPath, { force: true })
      } catch {
        // 清理失败不应掩盖上面的原始错误
      }
      request.log.error(err, 'Failed to save wallpaper')
      return reply.status(500).send({ error: 'Failed to save wallpaper' })
    }

    // buildStatePayload 内部会重新读取 Presets.wallpaperPath 覆盖冻结快照里的值，
    // 因此这里直接返回即可反映刚写入的新壁纸
    return await buildStatePayload()
  })

  fastify.patch<{
    Params: { presetId: string }
    Body: {
      name?: string
      displayConfig?: Partial<PresetDisplayConfig>
      systemPrompt?: string
      modelType?: 'anthropic' | 'openai' | 'ollama' | 'deepseek' | null
      modelName?: string | null
      applyNow?: boolean
    }
  }>('/presets/:presetId', async (request, reply) => {
    const { presetId } = request.params
    const preset = getPresetById(presetId)
    if (!preset) {
      return reply.status(404).send({ error: 'Preset not found' })
    }

    const { name, displayConfig, systemPrompt, modelType, modelName, applyNow } = request.body
    if (
      name === undefined &&
      displayConfig === undefined &&
      systemPrompt === undefined &&
      modelType === undefined &&
      modelName === undefined
    ) {
      return reply.status(400).send({ error: 'name, displayConfig, systemPrompt, modelType or modelName is required' })
    }

    if (name !== undefined) {
      const trimmedName = name.trim()
      if (!trimmedName) {
        return reply.status(400).send({ error: 'name is required' })
      }
      updatePresetName(presetId, trimmedName)
    }

    if (displayConfig !== undefined) {
      // 路由严格校验（与 parseDisplayConfig 的宽松合并分工不同：这里是唯一的 API 入参防线，
      // parseDisplayConfig 只服务于 schema 演进/历史脏数据兜底）
      if (displayConfig.chatBgRgb !== undefined && !isValidChatBgRgb(displayConfig.chatBgRgb)) {
        return reply.status(400).send({ error: 'chatBgRgb must be an array of three integers in [0, 255]' })
      }
      if (displayConfig.chatBgOpacity !== undefined && !isValidChatBgOpacity(displayConfig.chatBgOpacity)) {
        return reply.status(400).send({ error: 'chatBgOpacity must be a number in [0, 1]' })
      }
      if (displayConfig.themeMode !== undefined && !isValidThemeMode(displayConfig.themeMode)) {
        return reply.status(400).send({ error: 'themeMode must be one of day, night, auto' })
      }
      if (displayConfig.accentRgb !== undefined && !isValidAccentRgb(displayConfig.accentRgb)) {
        return reply.status(400).send({ error: 'accentRgb must be an array of three integers in [0, 255]' })
      }
      // tintStrength 只要求是有限数字：越界值不拒绝，夹回 [0, 1] 后写入（与 clampTintStrength
      // 的语义一致，见 session/displayConfig.ts 里的注释）
      if (displayConfig.tintStrength !== undefined && !isValidTintStrength(displayConfig.tintStrength)) {
        return reply.status(400).send({ error: 'tintStrength must be a finite number' })
      }

      // 服务端合并：只改一个字段的调用方不必回传自己不拥有的字段，两个面板改不同字段也不会互相覆盖。
      // 逐字段挑选而不是整体展开 displayConfig——请求体里混进的未知字段不应该被原样存进
      // 这个本该只有已知字段的 JSON blob
      updatePresetDisplayConfig(presetId, {
        chatBgRgb: displayConfig.chatBgRgb ?? preset.displayConfig.chatBgRgb,
        chatBgOpacity: displayConfig.chatBgOpacity ?? preset.displayConfig.chatBgOpacity,
        themeMode: displayConfig.themeMode ?? preset.displayConfig.themeMode,
        accentRgb: displayConfig.accentRgb ?? preset.displayConfig.accentRgb,
        tintStrength: displayConfig.tintStrength !== undefined
          ? clampTintStrength(displayConfig.tintStrength)
          : preset.displayConfig.tintStrength,
      })
    }

    if (systemPrompt !== undefined) {
      const trimmedSystemPrompt = systemPrompt.trim()
      if (!trimmedSystemPrompt) {
        return reply.status(400).send({ error: 'systemPrompt is required' })
      }
      updatePresetSystemPrompt(presetId, trimmedSystemPrompt)
    }

    // modelType/modelName 必须成对出现（都传或都不传），只传一个是半吊子状态，拒绝
    if ((modelType !== undefined) !== (modelName !== undefined)) {
      return reply.status(400).send({ error: 'modelType and modelName must be provided together' })
    }

    if (modelType !== undefined) {
      if (modelType === null) {
        // 都为 null：清除覆盖，跟随全局对话模型配置
        if (modelName !== null) {
          return reply.status(400).send({ error: 'modelName must be null when modelType is null' })
        }
        updatePresetModelConfig(presetId, null, null)
      } else {
        // 都非 null：自定义覆盖，modelType 必须是合法枚举值，modelName trim 后非空
        if (!VALID_MODEL_TYPES.includes(modelType)) {
          return reply.status(400).send({ error: 'modelType must be one of anthropic, openai, ollama, deepseek, or null' })
        }
        const trimmedModelName = (modelName ?? '').trim()
        if (!trimmedModelName) {
          return reply.status(400).send({ error: 'modelName is required when modelType is set' })
        }
        updatePresetModelConfig(presetId, modelType, trimmedModelName)
      }
    }

    // applyNow 刷新的是整个内存缓存的 preset 对象，不局限于某一个字段，因此放在上面
    // 几个字段更新之后统一判断一次，而不是绑在其中某个分支内部
    if (applyNow === true) {
      refreshCurrentPresetIfActive(presetId)
    }

    // 与壁纸上传路由同样的返回约定：buildStatePayload 内部现读 Presets 表覆盖冻结快照
    return await buildStatePayload()
  })
}
