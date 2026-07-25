import Fastify from 'fastify'
import path from 'path'
import fs from 'fs'
import chokidar from 'chokidar'
import * as dotenv from 'dotenv'
import { initDb } from './db/index.js'
import { loadSession } from './session/index.js'
import { getAllPresets, backfillMessageFts } from './session/queries.js'
import { chatRoutes } from './routes/chat.js'
import { presetRoutes } from './routes/presets.js'
import { internalRoutes } from './routes/internal.js'
import { createModelProvider, ModelProvider } from './providers/ModelProvider.js'
import { BGEProvider, type EmbeddingProvider } from './providers/EmbeddingProvider.js'
import { Bert4NerProvider, type NERProvider } from './providers/NERProvider.js'
import type { ModelConfig } from '../../shared/types/index.js'
import { ensureOllama, stopOllamaIfManaged } from './providers/ollama.js'
import { startOrganizeModeScheduler } from './memory/orchestrator.js'
import { buildStatePayload } from './state.js'
import fastifyStatic from '@fastify/static'
import fastifyCors from '@fastify/cors'


dotenv.config()

const PORT = parseInt(process.env.CORE_PORT ?? '3000')
const CONFIG_PATH = path.resolve(process.cwd(), 'config.json')

let config: Record<string, unknown> = {}

function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    console.log('[Config] Loaded config.json')
  } catch {
    console.warn('[Config] config.json not found, using defaults')
  }
}

function watchConfig() {
  chokidar.watch(CONFIG_PATH).on('change', () => {
    console.log('[Config] Reloading config.json...')
    loadConfig()
    fastify.config = config
    fastify.modelProvider = createModelProvider(config.modelProvider as ModelConfig)
    console.log('[Config] modelProvider reloaded')
  })
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Record<string, unknown>
    modelProvider: ModelProvider
    embeddingProvider: EmbeddingProvider
    nerProvider: NERProvider
  }
}

const fastify = Fastify({ logger: true })

fastify.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }))

fastify.get('/state', async () => buildStatePayload(fastify))

let organizeModeTask: ReturnType<typeof startOrganizeModeScheduler> | undefined

async function start() {
  // start() 函数职责太多
  process.on('SIGINT', async () => {
    organizeModeTask?.stop()
    await stopOllamaIfManaged()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    organizeModeTask?.stop()
    await stopOllamaIfManaged()
    process.exit(0)
  })

  // loadConfig 和 watchConfig 耦合太紧
  loadConfig()
  const modelConfig = config.modelProvider as ModelConfig | undefined
  if (!modelConfig) throw new Error('[Config] modelProvider is not configured')
  const modelProvider = createModelProvider(modelConfig)

  fastify.decorate('config', config)
  fastify.decorate('modelProvider', modelProvider)
  fastify.decorate('embeddingProvider', new BGEProvider())
  fastify.decorate('nerProvider', new Bert4NerProvider())

  watchConfig()
  const { needsFtsBackfill } = initDb()
  if (needsFtsBackfill) {
    const backfilledCount = backfillMessageFts()
    console.log(`[Core] Backfilled ${backfilledCount} message(s) into message_fts after tokenizer migration`)
  }

  organizeModeTask = startOrganizeModeScheduler(fastify)

  // 全局配置或任意 preset 用 ollama，都需要确保 ollama 已启动（per-preset provider 构建
  // 依赖 preset.modelType，而不仅仅是全局配置）
  const anyPresetUsesOllama = getAllPresets().some(p => p.modelType === 'ollama')
  if (modelConfig?.type === 'ollama' || anyPresetUsesOllama) {
    await ensureOllama(modelConfig?.ollamaBaseUrl)
  }

  const defaultPresetId = config.defaultPresetId as string | undefined
  if (defaultPresetId) {
    loadSession(defaultPresetId)
  }

  await fastify.register(fastifyCors, {
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  })

  await fastify.register(fastifyStatic, {
  root: path.resolve(process.cwd(), 'data/wallpapers'),
  prefix: '/wallpapers/',
  })
  
  await fastify.register(chatRoutes)
  await fastify.register(presetRoutes)
  await fastify.register(internalRoutes)
  await fastify.listen({ port: PORT, host: '127.0.0.1' })
  console.log(`[Core] Running on port ${PORT}`)

}

start().catch(err => {
  console.error(err)
  process.exit(1)
})