import { spawn, ChildProcess } from 'child_process'
import type { Readable } from 'stream'
import fs from 'fs'
import path from 'path'

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

export async function isAiServiceRunning(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

const AI_SERVICE_STARTUP_TIMEOUT_MS = 90000

async function waitForAiService(baseUrl: string, timeoutMs = AI_SERVICE_STARTUP_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isAiServiceRunning(baseUrl)) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

export async function ensureAiService(baseUrl: string): Promise<boolean> {
  if (await isAiServiceRunning(baseUrl)) {
    await new Promise(r => setTimeout(r, 500))
    if (await isAiServiceRunning(baseUrl)) {
      console.log('[AiService] Already running, not managed by MintBot')
      aiManagedByUs = false
      return true
    }
  }

  const pythonPath = path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe')
  if (!fs.existsSync(pythonPath)) {
    console.error(`[AiService] ${pythonPath} not found — run "pnpm setup:ai" first. AI 相关功能（embedding/NER）将不可用，走既有降级路径`)
    return false
  }

  const port = new URL(baseUrl).port || '80'
  console.log('[AiService] Not running, starting...')

  try {

    aiProcess = spawn(pythonPath, ['-m', 'uvicorn', 'main:app', '--port', port, '--no-access-log'], {
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

  aiManagedByUs = true
  const ready = await waitForAiService(baseUrl)
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

  console.log('[AiService] Stopping managed AI service process...')
  const proc = aiProcess
  aiProcess = null
  aiManagedByUs = false

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
