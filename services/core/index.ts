import Fastify from 'fastify'
import path from 'path'
import fs from 'fs'
import * as dotenv from 'dotenv'
import { initDb } from './db/index.js'
import { loadSession, resolveStartupPresetId } from './session/index.js'
import { getAllPresets, backfillMessageFts } from './session/queries.js'
import { chatRoutes } from './routes/chat.js'
import { eventsRoutes } from './routes/events.js'
import { presetRoutes } from './routes/presets.js'
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
import fastifyStatic from '@fastify/static'
import fastifyCors from '@fastify/cors'


dotenv.config({ quiet: true })

const PORT = parseInt(process.env.CORE_PORT ?? '3000')
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

// streaming 目前没有真实的类型化消费者，不属于独立 config 模块的类型范围（见 config/index.ts
// 头部说明），这里保留一次独立的原始读取，行为与迁移前一致：被 chat.ts 每次请求读取，因此
// 额外 decorate 到 fastify 实例上缓存（避免每个请求都读一次磁盘），并在 startConfigWatcher
// 的热更新回调里跟着 modelProvider 一起刷新。defaultPresetId 曾经也走这条 ad-hoc 读取路径，
// 现已迁移进独立 config 模块（getDefaultPresetId()，见下方启动逻辑）——它现在有了真正的
// 写入通道（session/index.ts 的 switchPreset），不再是"只读不写"的孤立字段
function readStreamingEnabled(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    return typeof raw.streaming === 'boolean' ? raw.streaming : true
  } catch {
    return true
  }
}

// 同一个 logger 实例的request.log.error/fastify.log.* 仍正常输出
const fastify = Fastify({ logger: true, disableRequestLogging: true })

fastify.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }))

fastify.get('/state', async () => buildStatePayload())

let organizeModeTask: ReturnType<typeof startOrganizeModeScheduler> | undefined

async function start() {
  // start() 函数职责太多
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
  // ensureAiService 本地模型轮询 可能较长
  // tsx watch 热重载时会触发冷启动
  // 两者失败都只记录日志，只是错过了提前加载的时机，不影响功能
  // ensureAiService 返回 false（生成失败/等待超时）时直接跳过预热请求 /embed
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

  // 任意配置用 ollama，都需确保 ollama 已启动?
  const anyPresetUsesOllama = getAllPresets().some(p => p.modelType === 'ollama')
  const modelConfig = getModelProviderConfig()
  if (modelConfig.type === 'ollama' || anyPresetUsesOllama) {
    await ensureOllama(modelConfig.ollamaBaseUrl)
  }

  // 处理"没有 persisted 值"（首次启动）与 reset 已不存在两种降级情况
  // 一律回退到最近更新的 preset；一个 preset 都没有时不加载任何 session
  const startupPresetId = resolveStartupPresetId(getDefaultPresetId())
  if (startupPresetId) {
    loadSession(startupPresetId)
  }

  // @fastify/cors 在不传 methods 时的默认值是 'GET,HEAD,POST'（见其 node_modules 源码），
  // 不包含 PATCH：新增会用到某方法的路由（如本文件里唯一的 PATCH /presets/:presetId）时，
  // 必须同步把该方法加进这个数组，否则浏览器端的 CORS 预检会静默拦截请求，
  // 现象是请求根本到不了下面的路由处理函数、服务端日志里也看不到任何东西
  await fastify.register(fastifyCors, {
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'HEAD', 'POST', 'PATCH'],
  })

  await fastify.register(fastifyStatic, {
  root: path.resolve(process.cwd(), 'data/wallpapers'),
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
  await fastify.listen({ port: PORT, host: '127.0.0.1' })
  console.log(`[Core] Running on port ${PORT}`)

}

start().catch(err => {
  console.error(err)
  process.exit(1)
})