// services/core/voice/routes.ts — 语音识别文字的取走路由、语音设置页的状态与操作路由
// 用法：core/index.ts 里 fastify.register(voiceRoutes)；POST /voice/take → { texts }，由 src/chat/ChatWindow.tsx 调用；POST /voice/input-mode { mode } 由 src/chat/ChatWindow.tsx 与 electron/main/index.ts 托盘调用；GET /voice/update-check 由 src/settings/VoicePanel.tsx 调用
// 对应文件：services/core/voice/agent.ts / src/chat/ChatWindow.tsx / services/core/voice/agent.test.ts
import type { FastifyInstance, FastifyReply } from 'fastify'
import { ERROR_CODES, errorBody, invalidRequest } from '../../../shared/errorCodes.js'
import { isVoiceInputMode } from '../../../shared/voiceInputMode.js'
import { ConfigFileUnreadableError } from '../config/configFileError.js'
import {
  VoiceOperationError,
  cancelEnroll,
  cancelInstall,
  checkVoiceUpdate,
  clearEnrollInterrupted,
  clearTest,
  commitEnroll,
  deleteSpeaker,
  getVoiceStatus,
  setInputMode,
  startEnroll,
  startInstall,
  startTest,
  stopTest,
  takePending,
} from './agent.js'

async function runOperation(reply: FastifyReply, operation: () => Promise<void>) {
  try {
    await operation()
    return reply.status(200).send({ ok: true })
  } catch (err) {
    if (err instanceof VoiceOperationError) {
      return reply.status(err.status).send(errorBody(err.errorCode))
    }
    throw err
  }
}

export async function voiceRoutes(fastify: FastifyInstance) {
  fastify.post('/voice/take', async (_request, reply) => {
    return reply.status(200).send({ texts: takePending() })
  })

  fastify.get('/voice/status', async (_request, reply) => {
    return reply.status(200).send(await getVoiceStatus())
  })

  fastify.get('/voice/update-check', async (_request, reply) => {
    await checkVoiceUpdate()
    return reply.status(200).send({ ok: true })
  })

  fastify.post<{ Body: { mode?: unknown } }>('/voice/input-mode', async (request, reply) => {
    const mode = request.body?.mode
    if (!isVoiceInputMode(mode)) return reply.status(400).send(invalidRequest('mode 必须是 off、listen 或 transcribe'))
    try {
      setInputMode(mode)
    } catch (err) {
      if (err instanceof VoiceOperationError) return reply.status(err.status).send(errorBody(err.errorCode))
      if (err instanceof ConfigFileUnreadableError) {
        console.error(err.message)
        return reply.status(500).send(errorBody(ERROR_CODES.CONFIG_FILE_UNREADABLE))
      }
      throw err
    }
    return reply.status(200).send(await getVoiceStatus())
  })

  fastify.post('/voice/install', async (_request, reply) => {
    try {
      startInstall()
    } catch (err) {
      if (err instanceof VoiceOperationError) return reply.status(err.status).send(errorBody(err.errorCode))
      throw err
    }
    return reply.status(202).send({ ok: true })
  })

  fastify.post('/voice/install/cancel', async (_request, reply) => {
    cancelInstall()
    return reply.status(200).send({ ok: true })
  })

  fastify.post('/voice/enroll/start', (_request, reply) => runOperation(reply, startEnroll))
  fastify.post('/voice/enroll/commit', (_request, reply) => runOperation(reply, commitEnroll))
  fastify.post('/voice/enroll/cancel', (_request, reply) => runOperation(reply, cancelEnroll))
  fastify.post('/voice/enroll/dismiss-interrupted', (_request, reply) =>
    runOperation(reply, async () => clearEnrollInterrupted())
  )
  fastify.post('/voice/test/start', (_request, reply) => runOperation(reply, startTest))
  fastify.post('/voice/test/stop', (_request, reply) => runOperation(reply, stopTest))
  fastify.post('/voice/test/clear', (_request, reply) => runOperation(reply, async () => clearTest()))
  fastify.delete('/voice/speaker', (_request, reply) => runOperation(reply, deleteSpeaker))
}
