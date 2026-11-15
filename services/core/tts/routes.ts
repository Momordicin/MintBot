// services/core/tts/routes.ts — 语音设置页的语音合成组件路由：读取状态、指定已下载的文件夹、下载安装或更新、取消安装
// 用法：core/index.ts 里 fastify.register(ttsRoutes)；GET /tts/status、POST /tts/use-existing { dir }、POST /tts/install { variant, root? }、POST /tts/install/cancel，由 src/settings/TtsSection.tsx 调用；管理器取自 tts/manager.ts 的 getTtsManager()
// 对应文件：services/core/tts/manager.ts / src/settings/TtsSection.tsx / services/core/tts/routes.test.ts
import type { FastifyInstance, FastifyReply } from 'fastify'
import { TtsError, type TtsErrorCode, type TtsManager } from '@mintbot/voice-agent-client'
import { ERROR_CODES, errorBody, invalidRequest } from '../../../shared/errorCodes.js'
import { getTtsManager, TTS_DEFAULT_ROOT } from './manager.js'

const ERROR_STATUS: Partial<Record<TtsErrorCode, number>> = {
  TTS_BUSY: 409,
  TTS_DISPOSED: 503,
  TTS_EXISTING_INVALID: 400,
  TTS_PROBE: 400,
}

function withManager(reply: FastifyReply, run: (manager: TtsManager) => Promise<FastifyReply> | FastifyReply) {
  const manager = getTtsManager()
  if (manager === null) return reply.status(503).send(errorBody(ERROR_CODES.VOICE_INSTALL_UNCONFIGURED))
  return run(manager)
}

export async function ttsRoutes(fastify: FastifyInstance) {
  fastify.get('/tts/status', async (_request, reply) =>
    withManager(reply, manager => reply.status(200).send(manager.status()))
  )

  fastify.post<{ Body: { dir?: unknown } }>('/tts/use-existing', async (request, reply) => {
    const dir = request.body?.dir
    if (typeof dir !== 'string' || dir.trim() === '') return reply.status(400).send(invalidRequest('dir 必须是非空字符串'))
    return withManager(reply, async manager => {
      try {
        const installed = await manager.useExisting(dir)
        return reply.status(200).send({ installed })
      } catch (err) {
        if (err instanceof TtsError) {
          return reply.status(ERROR_STATUS[err.code] ?? 500).send({ ...errorBody(err.code), details: err.details })
        }
        throw err
      }
    })
  })

  fastify.post<{ Body: { variant?: unknown; root?: unknown } }>('/tts/install', async (request, reply) => {
    const variant = request.body?.variant
    const root = request.body?.root
    if (variant !== 'v2pro' && variant !== 'v5') return reply.status(400).send(invalidRequest('variant 必须是 v2pro 或 v5'))
    if (root !== undefined && (typeof root !== 'string' || root.trim() === '')) {
      return reply.status(400).send(invalidRequest('root 必须是非空字符串'))
    }
    return withManager(reply, manager => {
      const status = manager.status()
      const updating = status.installed && status.source === 'download'
      try {
        void manager.install({ variant, root: root ?? (updating ? undefined : TTS_DEFAULT_ROOT) })
      } catch (err) {
        if (err instanceof TtsError && (err.code === 'TTS_BUSY' || err.code === 'TTS_DISPOSED')) {
          return reply.status(ERROR_STATUS[err.code] ?? 500).send(errorBody(err.code))
        }
        throw err
      }
      return reply.status(202).send({ ok: true })
    })
  })

  fastify.post('/tts/install/cancel', async (_request, reply) =>
    withManager(reply, manager => {
      manager.cancel()
      return reply.status(200).send({ ok: true })
    })
  )
}
