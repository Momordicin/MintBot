// services/core/providers/aiService.ts — 探测并托管 Python AI 服务（services/ai，提供 embedding/NER）：已在运行则直接用，否则用 .venv 里的 python 启动 uvicorn 并等待 /health 就绪
// 用法：index.ts 的 start() 调 ensureAiService(baseUrl)，SIGINT/SIGTERM 时调 shutdownAiService()；orchestrator 空闲时调 stopAiServiceForIdle()；EmbeddingProvider / NERProvider 调 runAiRequest；AI_SERVICE_IDENTITY 供 EmbeddingProvider 校验 /health 身份
// 形状：ensureAiService(baseUrl) -> Promise<boolean>（服务是否可用）
// 对应文件：services/ai/main.py / services/core/providers/EmbeddingProvider.ts / services/core/providers/NERProvider.ts / services/core/memory/orchestrator.ts / services/core/config/ports.ts / scripts/dev-ai.ts / services/core/providers/aiService.test.ts
import { spawn, ChildProcess } from 'child_process'
import type { Readable } from 'stream'
import fs from 'fs'
import path from 'path'
import { LOOPBACK_HOST } from '../config/ports.js'

function forwardLines(stream: Readable | null | undefined, onLine: (line: string) => void): void {
  if (!stream) return
  let buffer = ''
  stream.on('data', chunk => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '')
      if (trimmed.length > 0) onLine(trimmed)
    }
  })
  stream.on('end', () => {
    const trimmed = buffer.replace(/\r$/, '')
    if (trimmed.length > 0) onLine(trimmed)
    buffer = ''
  })
}

let aiProcess: ChildProcess | null = null
let aiManagedByUs = false

export const AI_SERVICE_IDENTITY = 'mintbot-ai'

type AiServiceProbeResult = 'ours' | 'legacy' | 'foreign' | 'unreachable'

function looksLikeLegacyHealth(body: Record<string, unknown>): boolean {
  return body.service === undefined
    && body.status === 'ok'
    && typeof body.embedding_loaded === 'boolean'
    && typeof body.ner_loaded === 'boolean'
}

async function probeAiService(baseUrl: string): Promise<AiServiceProbeResult> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    return 'unreachable'
  }

  if (!response.ok) return 'foreign'

  try {
    const body = await response.json() as Record<string, unknown>
    if (body.service === AI_SERVICE_IDENTITY) return 'ours'
    if (looksLikeLegacyHealth(body)) return 'legacy'
    return 'foreign'
  } catch {
    return 'foreign'
  }
}

export async function isAiServiceRunning(baseUrl: string): Promise<boolean> {
  return (await probeAiService(baseUrl)) === 'ours'
}

const AI_SERVICE_STARTUP_TIMEOUT_MS = 90000

async function waitForAiService(baseUrl: string, proc: ChildProcess, timeoutMs = AI_SERVICE_STARTUP_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isAiServiceRunning(baseUrl)) return true
    if (aiProcess !== proc) return false
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

export async function ensureAiService(baseUrl: string): Promise<boolean> {
  const port = new URL(baseUrl).port || '80'

  const reportPortConflict = () => {
    console.error(`[AiService] Port ${port} is occupied by another service (identity mismatch on /health, expected '${AI_SERVICE_IDENTITY}') — 请修改 .env 中的 AI_PORT 或停止占用该端口的进程`)
  }

  const reportLegacyService = () => {
    console.error(`[AiService] Port ${port} 上是一个旧版 MintBot AI service（/health 结构符合旧版但缺少 '${AI_SERVICE_IDENTITY}' 身份字段）— 请重启它以加载最新的 services/ai 代码`)
  }

  const initialProbe = await probeAiService(baseUrl)

  if (initialProbe === 'legacy') {
    reportLegacyService()
    return false
  }

  if (initialProbe === 'foreign') {
    reportPortConflict()
    return false
  }

  if (initialProbe === 'ours') {
    await new Promise(r => setTimeout(r, 500))
    const confirmProbe = await probeAiService(baseUrl)
    if (confirmProbe === 'ours') {
      console.log('[AiService] Already running, not managed by MintBot')
      aiManagedByUs = false
      return true
    }
    if (confirmProbe === 'legacy') {
      reportLegacyService()
      return false
    }
    if (confirmProbe === 'foreign') {
      reportPortConflict()
      return false
    }
  }

  if (shuttingDown) return false

  const pythonPath = path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe')
  if (!fs.existsSync(pythonPath)) {
    console.error(`[AiService] ${pythonPath} not found — run "pnpm setup:ai" first. AI 相关功能（embedding/NER）将不可用，走既有降级路径`)
    return false
  }

  console.log('[AiService] Not running, starting...')

  try {

    aiProcess = spawn(pythonPath, ['-m', 'uvicorn', 'main:app', '--host', LOOPBACK_HOST, '--port', port, '--no-access-log'], {
      cwd: path.resolve(process.cwd(), 'services/ai'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_PROGRESS_BARS: '1', 
      },
    })
  } catch (err) {
    console.error('[AiService] Failed to spawn:', err instanceof Error ? err.message : err)
    return false
  }

  forwardLines(aiProcess.stdout, line => console.log(`[AiService] ${line}`))
  forwardLines(aiProcess.stderr, line => console.error(`[AiService] ${line}`))

  aiProcess.on('error', (err) => {
    console.error('[AiService] Failed to start:', err.message)
  })

  const proc = aiProcess
  proc.on('exit', (code, signal) => {
    if (aiProcess === proc) {
      console.warn(`[AiService] Process exited (code=${code}, signal=${signal})`)
      aiProcess = null
      aiManagedByUs = false
    }
  })

  aiManagedByUs = true
  const ready = await waitForAiService(baseUrl, proc)
  if (aiProcess !== proc) {
    if (ready && await isAiServiceRunning(baseUrl)) {
      console.log(`[AiService] Port ${port} is already served by another MintBot AI service; using it (not managed)`)
      return true
    }
    console.error('[AiService] Process exited before the AI service became ready')
    return false
  }
  if (!ready) {
    console.error('[AiService] Timed out waiting for AI service to start')
    return false
  }
  console.log('[AiService] Started and ready ✓')
  return true
}

const FORCE_KILL_TIMEOUT_MS = 3000

export async function stopAiServiceIfManaged(): Promise<void> {
  if (!aiManagedByUs || !aiProcess) return

  const proc = aiProcess
  aiProcess = null
  aiManagedByUs = false

  if (proc.exitCode !== null || proc.signalCode !== null) return

  console.log('[AiService] Stopping managed AI service process...')

  await new Promise<void>(resolve => {
    const forceKillTimer = setTimeout(() => proc.kill('SIGKILL'), FORCE_KILL_TIMEOUT_MS)
    proc.once('exit', () => {
      clearTimeout(forceKillTimer)
      resolve()
    })
    proc.kill()
  })

  console.log('[AiService] Stopped')
}

const EMBED_WARMUP_TIMEOUT_MS = 30000

let shuttingDown = false
let idleStopped = false
let startFailed = false
let idleStop: Promise<void> | null = null
let onDemandStart: Promise<void> | null = null
let inFlightRequests = 0

export function isAiServiceManaged(): boolean {
  return aiManagedByUs && aiProcess !== null
}

export function isAiServiceIdleStopped(): boolean {
  return idleStopped
}

export function isAiServiceStartableOnDemand(): boolean {
  return idleStopped && !startFailed
}

export async function shutdownAiService(): Promise<void> {
  shuttingDown = true
  await stopAiServiceIfManaged()
}

async function warmUpEmbedding(baseUrl: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['ping'] }),
      signal: AbortSignal.timeout(EMBED_WARMUP_TIMEOUT_MS),
    })
    if (!response.ok) console.error(`[AiService] Embedding warm-up failed: HTTP ${response.status}`)
  } catch (err) {
    console.error('[AiService] Embedding warm-up failed:', err instanceof Error ? err.message : err)
  }
}

export async function stopAiServiceForIdle(): Promise<boolean> {
  if (!isAiServiceManaged() || inFlightRequests > 0) return false
  idleStopped = true
  console.log('[AiService] Idle, stopping managed AI service process to release memory')
  idleStop = stopAiServiceIfManaged()
  await idleStop
  idleStop = null
  return true
}

function startOnDemand(baseUrl: string): Promise<void> {
  onDemandStart ??= (async () => {
    await idleStop
    if (shuttingDown) return
    startFailed = false
    console.log('[AiService] Starting managed AI service process on demand')
    if (await ensureAiService(baseUrl)) {
      await warmUpEmbedding(baseUrl)
      idleStopped = false
      return
    }
    startFailed = true
    await stopAiServiceIfManaged()
  })().finally(() => { onDemandStart = null })
  return onDemandStart
}

export async function runAiRequest<T>(baseUrl: string, signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
  inFlightRequests++
  try {
    if (idleStopped) {
      const started = startOnDemand(baseUrl)
      if (!signal) {
        await started
      } else {
        await Promise.race([
          started,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason)
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
        ])
      }
    }
    return await request()
  } finally {
    inFlightRequests--
  }
}
