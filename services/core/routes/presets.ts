// services/core/routes/presets.ts — 预设（角色人设档案）的增删改、切换与壁纸上传路由
// 用法：core/index.ts 里 fastify.register(presetRoutes)，并取其导出的 WALLPAPER_DIR 作 /wallpapers/ 静态目录；GET /presets、GET /presets/:presetId/model-keys、POST /presets、POST /switch-preset、POST /presets/:presetId/wallpaper、PATCH /presets/:presetId、DELETE /presets/:presetId；广播 preset-pet-display-changed
// 形状：切换、壁纸、PATCH、DELETE 的响应为 buildStatePayload() 的状态载荷
// 对应文件：src/settings/CharacterPanel.tsx（调用方）/ src/overlay/OverlayApp.tsx（消费 preset-pet-display-changed）/ services/core/session/queries.ts / services/core/session/index.ts / services/core/session/displayConfig.ts / services/core/state.ts / services/core/providers/envCredentials.ts / services/core/config/keySummary.ts / services/core/routes/presets.test.ts / services/core/routes/wallpaperGuard.test.ts
import type { FastifyInstance } from 'fastify'
import path from 'path'
import os from 'os'
import fs from 'fs'
import crypto from 'crypto'
import * as dotenv from 'dotenv'
import { getAllPresets, getPresetById, createPreset, updatePresetWallpaper, updatePresetName, updatePresetDisplayConfig, updatePresetSystemPrompt, updatePresetModelConfig, deletePresetWithData, getMostRecentOtherPresetId, getPresetApiKeys, upsertPresetApiKey, type PresetKeyProvider, type PresetApiKeyUpdate, type PresetModelType } from '../session/queries.js'
import { ENV_VAR_BY_PROVIDER, isEnvCredentialDetected } from '../providers/envCredentials.js'
import { summarizeSavedKey } from '../config/keySummary.js'
import { switchPreset, refreshCurrentPresetIfActive, getCurrentState, PresetNotFoundError } from '../session/index.js'
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
const API_KEY_INVALID_MESSAGE = 'API key 无效或未配置'
const SUMMARY_API_KEY_INVALID_MESSAGE = '摘要模型的 API key 无效或未配置'

function isKeyProvider(type: string | null): type is PresetKeyProvider {
  return type === 'anthropic' || type === 'openai' || type === 'deepseek'
}

export async function presetRoutes(fastify: FastifyInstance) {
  fastify.get('/presets', async () => {
    return getAllPresets().map(p => ({ presetId: p.presetId, name: p.name }))
  })

  fastify.get<{
    Params: { presetId: string }
  }>('/presets/:presetId/model-keys', async (request, reply) => {
    const { presetId } = request.params
    if (!getPresetById(presetId)) {
      return reply.status(404).send({ error: 'Preset not found' })
    }

    const credentials = getPresetApiKeys(presetId)
    const summarize = (provider: PresetKeyProvider) => {
      const { apiKey, fromEnv, summaryApiKey, summaryFromEnv } = credentials[provider]
      return {
        ...summarizeSavedKey(apiKey),
        fromEnv,
        summary: { ...summarizeSavedKey(summaryApiKey), fromEnv: summaryFromEnv },
      }
    }
    return {
      anthropic: summarize('anthropic'),
      openai: summarize('openai'),
      deepseek: summarize('deepseek'),
    }
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
    } catch (err) {
      if (!(err instanceof PresetNotFoundError)) {
        console.error('[Presets] Switch preset failed:', err)
        throw err
      }
      return reply.status(404).send({ error: 'Preset not found' })
    }

    return buildStatePayload()
  })

  fastify.delete<{
    Params: { presetId: string }
  }>('/presets/:presetId', async (request, reply) => {
    const { presetId } = request.params
    if (!getPresetById(presetId)) {
      return reply.status(404).send({ error: 'Preset not found' })
    }
    if (getAllPresets().length <= 1) {
      return reply.status(409).send({ error: 'Cannot delete the last preset' })
    }

    if (getCurrentState()?.session.presetId === presetId) {
      try {
        switchPreset(getMostRecentOtherPresetId(presetId)!)
      } catch (err) {
        if (!(err instanceof PresetNotFoundError)) {
          console.error('[Presets] Switch before delete failed:', err)
          throw err
        }
        return reply.status(404).send({ error: 'Preset not found' })
      }
    }

    deletePresetWithData(presetId)

    for (const ext of ALLOWED_WALLPAPER_EXTENSIONS) {
      try {
        fs.rmSync(path.join(WALLPAPER_DIR, `${presetId}-wallpaper.${ext}`), { force: true })
      } catch (err) {
        request.log.error(err, 'Failed to remove wallpaper')
      }
    }

    return await buildStatePayload()
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
      apiKey?: string
      apiKeyFromEnv?: boolean
      summaryModelType?: PresetModelType | null
      summaryModelName?: string | null
      summaryApiKey?: string
      summaryApiKeyFromEnv?: boolean
      applyNow?: boolean
    }
  }>('/presets/:presetId', async (request, reply) => {
    const { presetId } = request.params
    const preset = getPresetById(presetId)
    if (!preset) {
      return reply.status(404).send({ error: 'Preset not found' })
    }

    const { name, displayConfig, systemPrompt, modelType, modelName, apiKeyFromEnv, summaryModelType, summaryModelName, summaryApiKeyFromEnv, applyNow } = request.body
    if (request.body.apiKey !== undefined && typeof request.body.apiKey !== 'string') {
      return reply.status(400).send({ error: 'apiKey must be a string' })
    }
    if (apiKeyFromEnv !== undefined && typeof apiKeyFromEnv !== 'boolean') {
      return reply.status(400).send({ error: 'apiKeyFromEnv must be a boolean' })
    }
    if (request.body.summaryApiKey !== undefined && typeof request.body.summaryApiKey !== 'string') {
      return reply.status(400).send({ error: 'summaryApiKey must be a string' })
    }
    if (summaryApiKeyFromEnv !== undefined && typeof summaryApiKeyFromEnv !== 'boolean') {
      return reply.status(400).send({ error: 'summaryApiKeyFromEnv must be a boolean' })
    }
    const apiKey = request.body.apiKey?.trim() || undefined
    const summaryApiKey = request.body.summaryApiKey?.trim() || undefined
    if (
      name === undefined &&
      displayConfig === undefined &&
      systemPrompt === undefined &&
      modelType === undefined &&
      modelName === undefined &&
      apiKey === undefined &&
      apiKeyFromEnv === undefined &&
      summaryModelType === undefined &&
      summaryModelName === undefined &&
      summaryApiKey === undefined &&
      summaryApiKeyFromEnv === undefined
    ) {
      return reply.status(400).send({ error: 'name, displayConfig, systemPrompt, modelType, modelName, apiKey, apiKeyFromEnv, summaryModelType, summaryModelName, summaryApiKey or summaryApiKeyFromEnv is required' })
    }

    const trimmedName = name?.trim()
    if (name !== undefined && !trimmedName) {
      return reply.status(400).send({ error: 'name is required' })
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
    }

    const trimmedSystemPrompt = systemPrompt?.trim()
    if (systemPrompt !== undefined && !trimmedSystemPrompt) {
      return reply.status(400).send({ error: 'systemPrompt is required' })
    }

    if ((modelType !== undefined) !== (modelName !== undefined)) {
      return reply.status(400).send({ error: 'modelType and modelName must be provided together' })
    }

    let modelConfig: { modelType: 'anthropic' | 'openai' | 'ollama' | 'deepseek' | null; modelName: string | null } | undefined
    if (modelType !== undefined) {
      if (modelType === null) {
        if (modelName !== null) {
          return reply.status(400).send({ error: 'modelName must be null when modelType is null' })
        }
        modelConfig = { modelType: null, modelName: null }
      } else {
        if (!VALID_MODEL_TYPES.includes(modelType)) {
          return reply.status(400).send({ error: 'modelType must be one of anthropic, openai, ollama, deepseek, or null' })
        }
        const trimmedModelName = (modelName ?? '').trim()
        if (!trimmedModelName) {
          return reply.status(400).send({ error: 'modelName is required when modelType is set' })
        }
        modelConfig = { modelType, modelName: trimmedModelName }
      }
    }

    if ((summaryModelType !== undefined) !== (summaryModelName !== undefined)) {
      return reply.status(400).send({ error: 'summaryModelType and summaryModelName must be provided together' })
    }

    let summaryConfig: { modelType: PresetModelType | null; modelName: string | null } | undefined
    if (summaryModelType !== undefined) {
      if (summaryModelType === null) {
        if (summaryModelName !== null) {
          return reply.status(400).send({ error: 'summaryModelName must be null when summaryModelType is null' })
        }
        summaryConfig = { modelType: null, modelName: null }
      } else {
        if (!VALID_MODEL_TYPES.includes(summaryModelType)) {
          return reply.status(400).send({ error: 'summaryModelType must be one of anthropic, openai, ollama, deepseek, or null' })
        }
        const trimmedSummaryModelName = (summaryModelName ?? '').trim()
        if (!trimmedSummaryModelName) {
          return reply.status(400).send({ error: 'summaryModelName is required when summaryModelType is set' })
        }
        summaryConfig = { modelType: summaryModelType, modelName: trimmedSummaryModelName }
      }
    }

    const resultingModelType = modelConfig !== undefined ? modelConfig.modelType : preset.modelType
    const keyFieldsSent = apiKey !== undefined || apiKeyFromEnv !== undefined
    let keyUpdate: { provider: PresetKeyProvider; apiKey?: string; fromEnv?: boolean } | undefined
    if (keyFieldsSent && !isKeyProvider(resultingModelType)) {
      return reply.status(400).send({ error: 'apiKey and apiKeyFromEnv only apply to anthropic, openai or deepseek' })
    }
    if (isKeyProvider(resultingModelType)) {
      const saved = getPresetApiKeys(presetId)[resultingModelType]
      if (apiKeyFromEnv === true && !saved.fromEnv && !isEnvCredentialDetected(resultingModelType)) {
        return reply.status(400).send({ error: `未检测到环境变量 ${ENV_VAR_BY_PROVIDER[resultingModelType]}` })
      }
      if (modelConfig !== undefined || keyFieldsSent) {
        const mergedFromEnv = apiKeyFromEnv ?? saved.fromEnv
        const mergedApiKey = apiKey ?? saved.apiKey
        const configured = mergedFromEnv ? isEnvCredentialDetected(resultingModelType) : !!mergedApiKey
        if (!configured) {
          return reply.status(400).send({ error: API_KEY_INVALID_MESSAGE })
        }
      }
      if (keyFieldsSent) {
        keyUpdate = { provider: resultingModelType, apiKey, fromEnv: apiKeyFromEnv }
      }
    }

    const summaryKeyFieldsSent = summaryApiKey !== undefined || summaryApiKeyFromEnv !== undefined
    let summaryKeyUpdate: PresetApiKeyUpdate | undefined
    if ((summaryConfig !== undefined || summaryKeyFieldsSent) && resultingModelType === null) {
      return reply.status(400).send({ error: 'summary settings require a role-specific model config' })
    }
    const resultingSummaryType = summaryConfig !== undefined ? summaryConfig.modelType : preset.summaryModelType
    if (summaryKeyFieldsSent && !isKeyProvider(resultingSummaryType)) {
      return reply.status(400).send({ error: 'summaryApiKey and summaryApiKeyFromEnv only apply to anthropic, openai or deepseek' })
    }
    if (resultingModelType !== null && isKeyProvider(resultingSummaryType)) {
      const saved = getPresetApiKeys(presetId)[resultingSummaryType]
      if (summaryApiKeyFromEnv === true && !saved.summaryFromEnv && !isEnvCredentialDetected(resultingSummaryType)) {
        return reply.status(400).send({ error: `未检测到环境变量 ${ENV_VAR_BY_PROVIDER[resultingSummaryType]}` })
      }
      if (modelConfig !== undefined || summaryConfig !== undefined || summaryKeyFieldsSent) {
        const mergedFromEnv = summaryApiKeyFromEnv ?? saved.summaryFromEnv
        const mergedApiKey = summaryApiKey ?? saved.summaryApiKey
        const configured = mergedFromEnv ? isEnvCredentialDetected(resultingSummaryType) : !!mergedApiKey
        if (!configured) {
          return reply.status(400).send({ error: SUMMARY_API_KEY_INVALID_MESSAGE })
        }
      }
      if (summaryKeyFieldsSent) {
        summaryKeyUpdate = { provider: resultingSummaryType, summaryApiKey, summaryFromEnv: summaryApiKeyFromEnv }
      }
    }

    if (trimmedName !== undefined) {
      updatePresetName(presetId, trimmedName)
    }

    if (displayConfig !== undefined) {
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

    if (trimmedSystemPrompt !== undefined) {
      updatePresetSystemPrompt(presetId, trimmedSystemPrompt)
    }

    const summaryUpdate = summaryConfig !== undefined || summaryKeyUpdate !== undefined
      ? { model: summaryConfig, keyUpdate: summaryKeyUpdate }
      : undefined
    if (modelConfig !== undefined || summaryUpdate !== undefined) {
      updatePresetModelConfig(
        presetId,
        modelConfig !== undefined ? modelConfig.modelType : preset.modelType,
        modelConfig !== undefined ? modelConfig.modelName : preset.modelName,
        keyUpdate,
        summaryUpdate
      )
    } else if (keyUpdate !== undefined) {
      upsertPresetApiKey(presetId, keyUpdate)
    }

    if (applyNow === true) {
      refreshCurrentPresetIfActive(presetId)
    }

    return await buildStatePayload()
  })
}
