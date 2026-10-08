import Fastify from 'fastify'
import path from 'path'
import fs from 'fs'
import * as dotenv from 'dotenv'
import { initDb } from './db/index.js'
import { loadSession, resolveStartupPresetId } from './session/index.js'
import { getAllPresets, backfillMessageFts } from './session/queries.js'
import { chatRoutes } from './routes/chat.js'
import { eventsRoutes } from './routes/events.js'
import { presetRoutes, WALLPAPER_DIR } from './routes/presets.js'
import { characterImportRoutes } from './routes/characterImport.js'
import { modelsRoutes } from './routes/models.js'
import { internalRoutes } from './routes/internal.js'
import { statusRoutes } from './routes/status.js'
import { messageRoutes } from './routes/messages.js'
import { forgetRoutes } from './routes/forget.js'
import { memoryRoutes } from './routes/memory.js'
import { configRoutes } from './routes/config.js'
import { windowBehaviorRoutes } from './routes/windowBehavior.js'
import { createModelProvider, ModelProvider } from './providers/ModelProvider.js'
import { BGEProvider, getAiBaseUrl, type EmbeddingProvider } from './providers/EmbeddingProvider.js'
import { Bert4NerProvider, type NERProvider } from './providers/NERProvider.js'
import { startConfigWatcher, getModelProviderConfig, getBackgroundModelProviderConfig, getDefaultPresetId } from './config/index.js'
import { ensureOllama, stopOllamaIfManaged } from './providers/ollama.js'
import { ensureAiService, stopAiServiceIfManaged } from './providers/aiService.js'
import { startOrganizeModeScheduler } from './memory/orchestrator.js'
import { buildStatePayload } from './state.js'
import { CHARACTERS_ROOT } from './characters/manifest.js'
import { LOOPBACK_HOST, CORE_PORT, RENDERER_ORIGINS } from './config/ports.js'
import fastifyStatic from '@fastify/static'
import fastifyCors from '@fastify/cors'


dotenv.config({ quiet: true })

const PORT = CORE_PORT
const CONFIG_PATH = path.resolve(process.cwd(), 'config.json')

declare module 'fastify' {
  interface FastifyInstance {
    modelProvider: ModelProvider
    backgroundModelProvider: ModelProvider
    embeddingProvider: EmbeddingProvider
    nerProvider: NERProvider
    streamingEnabled: boolean
  }
}

function readStreamingEnabled(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    return typeof raw.streaming === 'boolean' ? raw.streaming : true
  } catch {
    return true
  }
}

const fastify = Fastify({ logger: true, disableRequestLogging: true })

fastify.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }))

fastify.get('/state', async () => buildStatePayload())

let organizeModeTask: ReturnType<typeof startOrganizeModeScheduler> | undefined

async function start() {
  process.on('SIGINT', async () => {
    organizeModeTask?.stop()
    await stopOllamaIfManaged()
    await stopAiServiceIfManaged()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    organizeModeTask?.stop()
    await stopOllamaIfManaged()
    await stopAiServiceIfManaged()
    process.exit(0)
  })

  fastify.decorate('modelProvider', createModelProvider(getModelProviderConfig()))
  fastify.decorate('backgroundModelProvider', createModelProvider(getBackgroundModelProviderConfig()))
  fastify.decorate('streamingEnabled', readStreamingEnabled())
  const aiBaseUrl = getAiBaseUrl()
  fastify.decorate('embeddingProvider', new BGEProvider(aiBaseUrl))
  fastify.decorate('nerProvider', new Bert4NerProvider(aiBaseUrl))
  ensureAiService(aiBaseUrl)
    .then(ready => {
      if (!ready) return
      return fastify.embeddingProvider.embed('ping', undefined, 30000)
    })
    .catch(err => console.error('[Startup] AI service startup / embedding warm-up failed:', err))

  startConfigWatcher(() => {
    fastify.modelProvider = createModelProvider(getModelProviderConfig())
    fastify.backgroundModelProvider = createModelProvider(getBackgroundModelProviderConfig())
    fastify.streamingEnabled = readStreamingEnabled()
    console.log('[Config] modelProvider reloaded')
  })
  const { needsFtsBackfill } = initDb()
  if (needsFtsBackfill) {
    const backfilledCount = backfillMessageFts()
    console.log(`[Core] Backfilled ${backfilledCount} message(s) into message_fts after tokenizer migration`)
  }

  organizeModeTask = startOrganizeModeScheduler(fastify)

  const anyPresetUsesOllama = getAllPresets().some(p => p.modelType === 'ollama')
  const modelConfig = getModelProviderConfig()
  if (modelConfig.type === 'ollama' || anyPresetUsesOllama) {
    await ensureOllama(modelConfig.ollamaBaseUrl)
  }

  const startupPresetId = resolveStartupPresetId(getDefaultPresetId())
  if (startupPresetId) {
    loadSession(startupPresetId)
  }

  await fastify.register(fastifyCors, {
  origin: [...RENDERER_ORIGINS],
  methods: ['GET', 'HEAD', 'POST', 'PATCH'],
  })

  await fastify.register(fastifyStatic, {
  root: WALLPAPER_DIR,
  prefix: '/wallpapers/',
  })

  await fastify.register(fastifyStatic, {
  root: CHARACTERS_ROOT,
  prefix: '/characters/',
  decorateReply: false,
  })

  await fastify.register(chatRoutes)
  await fastify.register(eventsRoutes)
  await fastify.register(presetRoutes)
  await fastify.register(characterImportRoutes)
  await fastify.register(modelsRoutes)
  await fastify.register(internalRoutes)
  await fastify.register(statusRoutes)
  await fastify.register(messageRoutes)
  await fastify.register(forgetRoutes)
  await fastify.register(memoryRoutes)
  await fastify.register(configRoutes)
  await fastify.register(windowBehaviorRoutes)
  await fastify.listen({ port: PORT, host: LOOPBACK_HOST })
  console.log(`[Core] Running on port ${PORT}`)

}

start().catch(err => {
  console.error(err)
  process.exit(1)
})