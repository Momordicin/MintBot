import Fastify from 'fastify'
import path from 'path'
import fs from 'fs'
import chokidar from 'chokidar'
import * as dotenv from 'dotenv'
import { initDb } from './db/index.js'
import { getCurrentState, loadSession } from './session/index.js'
import { chatRoutes } from './routes/chat.js'
import { createModelProvider, ModelProvider } from './providers/ModelProvider.js'
import type { ModelConfig } from '../../shared/types/index.js'
import { ensureOllama, isOllamaRunning, getOllamaBaseUrl, stopOllamaIfManaged } from './providers/ollama.js'
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
  }
}

const fastify = Fastify({ logger: true })

fastify.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }))

fastify.get('/state', async () => {
  const state = getCurrentState()
  const snapshot = state?.session.presetSnapshot ?? null

  let ollamaReady: boolean | null = null
  if (snapshot?.modelType === 'ollama') {
    const modelConfig = fastify.config.modelProvider as ModelConfig | undefined
    const baseUrl = getOllamaBaseUrl(modelConfig?.ollamaBaseUrl)
    ollamaReady = await isOllamaRunning(baseUrl)
  }

  return {
    sessionId: state?.session.sessionId ?? null,
    presetSnapshot: snapshot,
    ollamaReady,
    emotion: null,
    embeddingQueue: null,
  }
})

async function start() {
  // start() 函数职责太多
  process.on('SIGINT', async () => {
    await stopOllamaIfManaged()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
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

  watchConfig()
  initDb()
  
  if (modelConfig?.type === 'ollama') {
    await ensureOllama(modelConfig.ollamaBaseUrl)
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
  await fastify.listen({ port: PORT, host: '127.0.0.1' })
  console.log(`[Core] Running on port ${PORT}`)

}

start().catch(err => {
  console.error(err)
  process.exit(1)
})