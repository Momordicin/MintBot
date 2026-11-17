// services/core/tts/routes.ts — 语音设置页的语音合成组件路由：读取状态（含开关、当前角色语音模型、情绪参考音频与朗读状态）、重新匹配情绪参考音频、指定已下载的文件夹、下载安装或更新、取消安装、开关语音合成、试听；聊天窗口读取朗读中状态与停止朗读
// 用法：core/index.ts 里 fastify.register(ttsRoutes)；GET /tts/status、POST /tts/use-existing { dir }、POST /tts/install { variant, root? }、POST /tts/install/cancel、POST /tts/enabled { enabled }、POST /tts/preview（audio/wav）、POST /tts/references/rematch，由 src/settings/TtsSection.tsx 调用；GET /tts/narration、POST /tts/narration/stop 由 src/chat/ChatWindow.tsx 调用；管理器取自 tts/manager.ts 的 getTtsManager()，当前角色取自 session/index.ts 的 getCurrentState()，语音组件状态取自 voice/agent.ts 的 getVoiceStatus() / getPlaybackSupported()，情绪参考音频取自 tts/voiceRefs.ts
// 对应文件：services/core/tts/manager.ts / services/core/tts/narration.ts / services/core/tts/voiceRefs.ts / services/core/voice/agent.ts / src/chat/ChatWindow.tsx / services/core/session/index.ts / services/core/config/index.ts / services/core/characters/manifest.ts / src/settings/TtsSection.tsx / services/core/tts/routes.test.ts
import path from 'path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { TtsError, type TtsErrorCode, type TtsManager } from '@mintbot/voice-agent-client'
import { ERROR_CODES, errorBody, invalidRequest } from '../../../shared/errorCodes.js'
import { CHARACTERS_ROOT } from '../characters/manifest.js'
import { ConfigFileUnreadableError } from '../config/configFileError.js'
import { getTtsEnabled } from '../config/index.js'
import { getCurrentState } from '../session/index.js'
import { getPlaybackSupported, getVoiceStatus } from '../voice/agent.js'
import {
  applyCharacterVoice,
  applyTtsEnabled,
  characterVoiceStatus,
  getTtsManager,
  TTS_DEFAULT_ROOT,
  type TtsCharacter,
} from './manager.js'
import { getNarrationLastError, isSpeaking, stopNarration } from './narration.js'
import { getVoiceReferencesStatus, rematchVoiceReferences } from './voiceRefs.js'

const ERROR_STATUS: Partial<Record<TtsErrorCode, number>> = {
  TTS_BUSY: 409,
  TTS_DISPOSED: 503,
  TTS_EXISTING_INVALID: 400,
  TTS_PROBE: 400,
  TTS_NOT_READY: 409,
  TTS_SYNTHESIS: 502,
}

function currentCharacter(): TtsCharacter | null {
  const state = getCurrentState()
  return state === null ? null : { characterId: state.preset.characterId, manifest: state.manifest }
}

function applyCurrentCharacterVoice(): void {
  try {
    applyCharacterVoice(currentCharacter())
  } catch (err) {
    if (!(err instanceof TtsError && err.code === 'TTS_DISPOSED')) throw err
  }
}

type NarrationState =
  | 'no_voice_agent'
  | 'agent_starting'
  | 'agent_failed'
  | 'unsupported'
  | 'no_voice'
  | 'waiting'
  | 'unavailable'
  | 'ok'

function narrationState(
  installed: boolean,
  phase: string | null,
  voiceOk: boolean,
  service: ReturnType<TtsManager['status']>['service']
): NarrationState {
  if (!installed) return 'no_voice_agent'
  if (phase === 'failed') return 'agent_failed'
  if (phase !== 'running') return 'agent_starting'
  const supported = getPlaybackSupported()
  if (supported === null) return 'agent_starting'
  if (!supported) return 'unsupported'
  if (!voiceOk) return 'no_voice'
  if (service.state === 'failed' || service.modelState === 'failed') return 'unavailable'
  if (service.state !== 'running' || service.modelState !== 'loaded') return 'waiting'
  return 'ok'
}

function withManager(reply: FastifyReply, run: (manager: TtsManager) => Promise<FastifyReply> | FastifyReply) {
  const manager = getTtsManager()
  if (manager === null) return reply.status(503).send(errorBody(ERROR_CODES.VOICE_INSTALL_UNCONFIGURED))
  return run(manager)
}

export async function ttsRoutes(fastify: FastifyInstance) {
  fastify.get('/tts/status', async (_request, reply) =>
    withManager(reply, async manager => {
      const character = currentCharacter()
      const { voice, missing } = characterVoiceStatus(character)
      const status = manager.status()
      const voiceStatus = await getVoiceStatus()
      const voiceOk = voice === 'ok' && Boolean(character?.manifest?.voice?.preview)
      return reply.status(200).send({
        ...status,
        enabled: getTtsEnabled(),
        character: { name: character?.manifest?.displayName ?? '', voice, missing },
        narration: {
          state: narrationState(voiceStatus.installed, voiceStatus.phase, voiceOk, status.service),
          lastError: getNarrationLastError(),
          voiceInstalling: voiceStatus.install.state === 'installing',
          voiceBusy: voiceStatus.mode !== 'normal',
        },
        listenWithoutVoiceprint: voiceStatus.inputMode === 'listen' && voiceStatus.speaker !== null && !voiceStatus.speaker.enrolled,
        references: getVoiceReferencesStatus(),
      })
    })
  )

  fastify.post('/tts/references/rematch', async (_request, reply) => {
    if (rematchVoiceReferences(currentCharacter(), getCurrentState()) === 'busy') {
      return reply.status(409).send(errorBody(ERROR_CODES.TTS_REFERENCES_MATCHING))
    }
    return reply.status(202).send({ ok: true })
  })

  fastify.get('/tts/narration', async (_request, reply) => reply.status(200).send({ speaking: isSpeaking() }))

  fastify.post('/tts/narration/stop', async (_request, reply) => {
    await stopNarration()
    return reply.status(200).send({ ok: true })
  })

  fastify.post<{ Body: { enabled?: unknown } }>('/tts/enabled', async (request, reply) => {
    const enabled = request.body?.enabled
    if (typeof enabled !== 'boolean') return reply.status(400).send(invalidRequest('enabled 必须是布尔值'))
    return withManager(reply, () => {
      try {
        applyTtsEnabled(enabled, currentCharacter())
      } catch (err) {
        if (err instanceof TtsError && err.code === 'TTS_DISPOSED') {
          return reply.status(ERROR_STATUS[err.code] ?? 500).send(errorBody(err.code))
        }
        if (err instanceof ConfigFileUnreadableError) {
          console.error(err.message)
          return reply.status(500).send(errorBody(ERROR_CODES.CONFIG_FILE_UNREADABLE))
        }
        throw err
      }
      return reply.status(200).send({ ok: true })
    })
  })

  fastify.post('/tts/preview', async (_request, reply) =>
    withManager(reply, async manager => {
      await stopNarration()
      const character = currentCharacter()
      const manifest = character?.manifest
      const preview = manifest?.voice?.preview
      if (!character || !manifest || !preview) return reply.status(400).send(errorBody(ERROR_CODES.TTS_VOICE_UNCONFIGURED))
      try {
        const wav = await manager.synthesize({
          text: `你好，我是${manifest.displayName}，很高兴见到你。`,
          textLang: 'zh',
          refAudio: path.join(CHARACTERS_ROOT, character.characterId, preview.audio),
          refText: preview.text,
          promptLang: preview.lang,
        })
        return reply.status(200).type('audio/wav').send(wav)
      } catch (err) {
        if (err instanceof TtsError) {
          return reply.status(ERROR_STATUS[err.code] ?? 500).send({ ...errorBody(err.code), details: err.details })
        }
        throw err
      }
    })
  )

  fastify.post<{ Body: { dir?: unknown } }>('/tts/use-existing', async (request, reply) => {
    const dir = request.body?.dir
    if (typeof dir !== 'string' || dir.trim() === '') return reply.status(400).send(invalidRequest('dir 必须是非空字符串'))
    return withManager(reply, async manager => {
      try {
        const installed = await manager.useExisting(dir)
        if (installed) applyCurrentCharacterVoice()
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
          .then(applyCurrentCharacterVoice)
          .catch(err => console.error('[TTS] Applying the character voice after install failed:', err))
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
