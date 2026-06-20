// ESM
import Fastify from 'fastify'
import path from 'path'
import fs from 'fs'
import chokidar from 'chokidar'
import * as dotenv from 'dotenv'


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
  })
}


const fastify = Fastify({ logger: true })

// health route
fastify.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }))

// state route
fastify.get('/state', async () => ({
  sessionId: null,
  characterName: null,
  emotion: null,
  embeddingQueue: null,
}))


async function start() {
  loadConfig()
  watchConfig()
  await fastify.listen({ port: PORT, host: '127.0.0.1' })
  console.log(`[Core] Running on port ${PORT}`)
}

start().catch(err => {
  console.error(err)
  process.exit(1)
})