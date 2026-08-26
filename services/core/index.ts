import Fastify from 'fastify'
import path from 'path'
import fs from 'fs'
import * as dotenv from 'dotenv'
import { initDb } from './db/index.js'
import { loadSession } from './session/index.js'
import { getAllPresets, backfillMessageFts } from './session/queries.js'
import { chatRoutes } from './routes/chat.js'
import { presetRoutes } from './routes/presets.js'
import { internalRoutes } from './routes/internal.js'
import { statusRoutes } from './routes/status.js'
import { messageRoutes } from './routes/messages.js'
import { createModelProvider, ModelProvider } from './providers/ModelProvider.js'
import { BGEProvider, getAiBaseUrl, type EmbeddingProvider } from './providers/EmbeddingProvider.js'
import { Bert4NerProvider, type NERProvider } from './providers/NERProvider.js'
import { startConfigWatcher, getModelProviderConfig } from './config/index.js'
import { ensureOllama, stopOllamaIfManaged } from './providers/ollama.js'
import { startOrganizeModeScheduler } from './memory/orchestrator.js'
import { buildStatePayload } from './state.js'
import fastifyStatic from '@fastify/static'
import fastifyCors from '@fastify/cors'


dotenv.config()

const PORT = parseInt(process.env.CORE_PORT ?? '3000')
const CONFIG_PATH = path.resolve(process.cwd(), 'config.json')

declare module 'fastify' {
  interface FastifyInstance {
    modelProvider: ModelProvider
    embeddingProvider: EmbeddingProvider
    nerProvider: NERProvider
    streamingEnabled: boolean
  }
}

// defaultPresetId / streaming 目前都没有真实的类型化消费者，不属于独立 config 模块的类型范围
// （见 config/index.ts 头部说明），这里各自保留一次独立的原始读取，行为与迁移前一致：
// defaultPresetId 只在启动时读取一次；streaming 被 chat.ts 每次请求读取，因此额外 decorate
// 到 fastify 实例上缓存（避免每个请求都读一次磁盘），并在 startConfigWatcher 的热更新回调里
// 跟着 modelProvider 一起刷新
function readDefaultPresetId(): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    return raw.defaultPresetId as string | undefined
  } catch {
    return undefined
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

const fastify = Fastify({ logger: true })

fastify.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }))

fastify.get('/state', async () => buildStatePayload())

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

  fastify.decorate('modelProvider', createModelProvider(getModelProviderConfig()))
  fastify.decorate('streamingEnabled', readStreamingEnabled())
  const aiBaseUrl = getAiBaseUrl()
  fastify.decorate('embeddingProvider', new BGEProvider(aiBaseUrl))
  // 非阻塞预热：不 await，不能延迟 fastify.listen()，失败只记录日志（下一次真实 /embed
  // 调用时 load_model() 会照常懒加载，预热失败不影响功能，只是错过了提前加载的时机）。
  // bge-m3 冷加载耗时不确定，可能超过 embed() 默认的 5 秒超时，这里显式给这次预热调用
  // 更宽松的 30 秒上限，避免仅仅因为模型还在加载中就打印误导性的失败日志（FastAPI 端
  // 同步路由本身仍会继续跑完加载，不受这里超时与否影响）
  fastify.embeddingProvider.embed('ping', undefined, 30000).catch(err => console.error('[Startup] embedding warm-up failed:', err))
  fastify.decorate('nerProvider', new Bert4NerProvider(aiBaseUrl))

  startConfigWatcher(() => {
    fastify.modelProvider = createModelProvider(getModelProviderConfig())
    fastify.streamingEnabled = readStreamingEnabled()
    console.log('[Config] modelProvider reloaded')
  })
  const { needsFtsBackfill } = initDb()
  if (needsFtsBackfill) {
    const backfilledCount = backfillMessageFts()
    console.log(`[Core] Backfilled ${backfilledCount} message(s) into message_fts after tokenizer migration`)
  }

  organizeModeTask = startOrganizeModeScheduler(fastify)

  // 全局配置或任意 preset 用 ollama，都需要确保 ollama 已启动（per-preset provider 构建
  // 依赖 preset.modelType，而不仅仅是全局配置）
  const anyPresetUsesOllama = getAllPresets().some(p => p.modelType === 'ollama')
  const modelConfig = getModelProviderConfig()
  if (modelConfig.type === 'ollama' || anyPresetUsesOllama) {
    await ensureOllama(modelConfig.ollamaBaseUrl)
  }

  const defaultPresetId = readDefaultPresetId()
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

  await fastify.register(fastifyStatic, {
  root: path.resolve(process.cwd(), 'assets/characters'),
  prefix: '/characters/',
  decorateReply: false,
  })

  await fastify.register(chatRoutes)
  await fastify.register(presetRoutes)
  await fastify.register(internalRoutes)
  await fastify.register(statusRoutes)
  await fastify.register(messageRoutes)
  await fastify.listen({ port: PORT, host: '127.0.0.1' })
  console.log(`[Core] Running on port ${PORT}`)

}

start().catch(err => {
  console.error(err)
  process.exit(1)
})