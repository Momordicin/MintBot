// services/core/routes/presets.ts — 预设（角色人设档案）的增删改、切换与壁纸上传路由
// 用法：core/index.ts 里 fastify.register(presetRoutes)，并取其导出的 WALLPAPER_DIR 作 /wallpapers/ 静态目录；GET /presets、POST /presets、POST /switch-preset、POST /presets/:presetId/wallpaper、PATCH /presets/:presetId；广播 preset-pet-display-changed
// 形状：切换、壁纸、PATCH 的响应为 buildStatePayload() 的状态载荷
// 对应文件：src/settings/CharacterPanel.tsx（调用方）/ src/overlay/OverlayApp.tsx（消费 preset-pet-display-changed）/ services/core/session/queries.ts / services/core/session/index.ts / services/core/session/displayConfig.ts / services/core/state.ts / services/core/routes/presets.test.ts / services/core/routes/wallpaperGuard.test.ts
import type { FastifyInstance } from 'fastify'
import path from 'path'
import os from 'os'
import fs from 'fs'
import crypto from 'crypto'
import * as dotenv from 'dotenv'
import { getAllPresets, getPresetById, createPreset, updatePresetWallpaper, updatePresetName, updatePresetDisplayConfig, updatePresetSystemPrompt, updatePresetModelConfig } from '../session/queries.js'
import { switchPreset, refreshCurrentPresetIfActive } from '../session/index.js'
import { buildStatePayload } from '../state.js'
import { broadcastEvent } from '../events/broadcast.js'
import {
  isValidChatBgRgb,
  isValidChatBgOpacity,
  isValidThemeMode,
  isValidAccentRgb,
  isValidTintStrength,
  isValidCurrentPortrait,
  isValidPetScale,
  clampTintStrength,
  DEFAULT_DISPLAY_CONFIG,
} from '../session/displayConfig.js'
import type { PresetDisplayConfig } from '../../../shared/types/index.js'

dotenv.config({ quiet: true })

export const WALLPAPER_DIR = path.resolve(process.cwd(), process.env.WALLPAPER_PATH ?? './data/wallpapers')

if (process.env.VITEST && !WALLPAPER_DIR.startsWith(os.tmpdir() + path.sep)) {
  throw new Error(`[Wallpaper] refusing WALLPAPER_PATH "${WALLPAPER_DIR}" under vitest; it must resolve inside ${os.tmpdir()}`)
}

const ALLOWED_WALLPAPER_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const VALID_MODEL_TYPES: readonly string[] = ['anthropic', 'openai', 'ollama', 'deepseek']

export async function presetRoutes(fastify: FastifyInstance) {
  fastify.get('/presets', async () => {
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

    const trimmedCharacterId = characterId?.trim()
    if (!trimmedCharacterId) {
      return reply.status(400).send({ error: 'characterId is required' })
    }

    const trimmedSystemPrompt = systemPrompt?.trim()
    if (!trimmedSystemPrompt) {
      return reply.status(400).send({ error: 'systemPrompt is required' })
    }

    const presetId = crypto.randomUUID()
    createPreset({
      presetId,
      name: trimmedName,
      characterId: trimmedCharacterId,
      modelType: null,
      modelName: null,
      wallpaperPath: undefined,
      displayConfig: DEFAULT_DISPLAY_CONFIG,
      systemPrompt: trimmedSystemPrompt,
      addressForms: [],
    })

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
      return reply.status(404).send({ error: 'Preset not found' })
    }

    return buildStatePayload()
  })

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
        filename = ''
      }
    }
    const ext = path.extname(filename).slice(1).toLowerCase()
    if (!ALLOWED_WALLPAPER_EXTENSIONS.has(ext)) {
      return reply.status(400).send({ error: 'Unsupported file extension' })
    }

    const savedFilename = `${presetId}-wallpaper.${ext}`
    const finalPath = path.join(WALLPAPER_DIR, savedFilename)
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
      }
      request.log.error(err, 'Failed to save wallpaper')
      return reply.status(500).send({ error: 'Failed to save wallpaper' })
    }

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
      if (displayConfig.tintStrength !== undefined && !isValidTintStrength(displayConfig.tintStrength)) {
        return reply.status(400).send({ error: 'tintStrength must be a finite number' })
      }
      if (displayConfig.currentPortrait !== undefined && !isValidCurrentPortrait(displayConfig.currentPortrait)) {
        return reply.status(400).send({ error: 'currentPortrait must be one of pixel, illustration' })
      }

      if (displayConfig.petScale !== undefined && !isValidPetScale(displayConfig.petScale)) {
        return reply.status(400).send({ error: 'petScale must be an object with pixel and illustration each one of 0.5, 0.75, 1, 1.25, 1.5' })
      }

      const portraitChanged = displayConfig.currentPortrait !== undefined
        && displayConfig.currentPortrait !== preset.displayConfig.currentPortrait
      const petScaleChanged = displayConfig.petScale !== undefined
        && (displayConfig.petScale.pixel !== preset.displayConfig.petScale.pixel
          || displayConfig.petScale.illustration !== preset.displayConfig.petScale.illustration)

      updatePresetDisplayConfig(presetId, {
        chatBgRgb: displayConfig.chatBgRgb ?? preset.displayConfig.chatBgRgb,
        chatBgOpacity: displayConfig.chatBgOpacity ?? preset.displayConfig.chatBgOpacity,
        themeMode: displayConfig.themeMode ?? preset.displayConfig.themeMode,
        accentRgb: displayConfig.accentRgb ?? preset.displayConfig.accentRgb,
        tintStrength: displayConfig.tintStrength !== undefined
          ? clampTintStrength(displayConfig.tintStrength)
          : preset.displayConfig.tintStrength,
        currentPortrait: displayConfig.currentPortrait ?? preset.displayConfig.currentPortrait,
        petScale: displayConfig.petScale
          ? { pixel: displayConfig.petScale.pixel, illustration: displayConfig.petScale.illustration }
          : preset.displayConfig.petScale,
      })
      if (portraitChanged || petScaleChanged) broadcastEvent('preset-pet-display-changed', { presetId })
    }

    if (systemPrompt !== undefined) {
      const trimmedSystemPrompt = systemPrompt.trim()
      if (!trimmedSystemPrompt) {
        return reply.status(400).send({ error: 'systemPrompt is required' })
      }
      updatePresetSystemPrompt(presetId, trimmedSystemPrompt)
    }

    if ((modelType !== undefined) !== (modelName !== undefined)) {
      return reply.status(400).send({ error: 'modelType and modelName must be provided together' })
    }

    if (modelType !== undefined) {
      if (modelType === null) {
        if (modelName !== null) {
          return reply.status(400).send({ error: 'modelName must be null when modelType is null' })
        }
        updatePresetModelConfig(presetId, null, null)
      } else {
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

    if (applyNow === true) {
      refreshCurrentPresetIfActive(presetId)
    }

    return await buildStatePayload()
  })
}
