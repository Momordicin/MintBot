import type { FastifyInstance } from 'fastify'
import path from 'path'
import fs from 'fs'
import { getAllPresets, getPresetById, updatePresetWallpaper } from '../session/queries.js'
import { switchPreset } from '../session/index.js'
import { buildStatePayload } from '../state.js'

// 与 services/core/index.ts 里 @fastify/static 的 data/wallpapers 注册使用同一路径约定
const WALLPAPER_DIR = path.resolve(process.cwd(), 'data/wallpapers')
const ALLOWED_WALLPAPER_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

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
    fs.mkdirSync(WALLPAPER_DIR, { recursive: true })
    fs.writeFileSync(path.join(WALLPAPER_DIR, savedFilename), request.body)

    updatePresetWallpaper(presetId, savedFilename)

    // buildStatePayload 内部会重新读取 Presets.wallpaperPath 覆盖冻结快照里的值，
    // 因此这里直接返回即可反映刚写入的新壁纸
    return await buildStatePayload(fastify)
  })
}
