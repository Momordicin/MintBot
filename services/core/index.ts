import Fastify from 'fastify'
import path from 'path'
import fs from 'fs'
import chokidar from 'chokidar'
import * as dotenv from 'dotenv'
import { initDb } from './db/index.js'
import { loadSession } from './session/index.js'
import { chatRoutes } from './routes/chat.js'
import { createModelProvider, ModelProvider } from './providers/ModelProvider.js'
import type { ModelConfig } from '../../shared/types/index.js'

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

fastify.get('/state', async () => ({
  sessionId: null,
  characterId: null,
  presetSnapshot: null,
  emotion: null,
  embeddingQueue: null,
}))

async function start() {
  loadConfig()
  const modelProvider = createModelProvider(config.modelProvider as ModelConfig)

  fastify.decorate('config', config)
  fastify.decorate('modelProvider', modelProvider)

  watchConfig()
  initDb()
  
  const defaultPresetId = (config as any)?.defaultPresetId
  if (defaultPresetId) {
    loadSession(defaultPresetId)
  }
  await fastify.register(chatRoutes)  
  await fastify.listen({ port: PORT, host: '127.0.0.1' })
  console.log(`[Core] Running on port ${PORT}`)
}

start().catch(err => {
  console.error(err)
  process.exit(1)
})