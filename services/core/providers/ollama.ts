import { spawn, ChildProcess } from 'child_process'

let ollamaProcess: ChildProcess | null = null
let ollamaManagedByUs = false

function getOllamaBaseUrl(baseUrl?: string): string {
  const url = baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1'
  return url.replace('/v1', '')
}

async function isOllamaRunning(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function waitForOllama(baseUrl: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isOllamaRunning(baseUrl)) return
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('[Ollama] Timed out waiting for Ollama to start')
}

export async function ensureOllama(ollamaBaseUrl?: string): Promise<void> {
  const baseUrl = getOllamaBaseUrl(ollamaBaseUrl)

  if (await isOllamaRunning(baseUrl)) {
    console.log('[Ollama] Already running, not managed by MintBot')
    ollamaManagedByUs = false
    return
  }

  console.log('[Ollama] Not running, starting...')
  ollamaProcess = spawn('ollama', ['serve'], {
    detached: false,
    stdio: 'ignore',
  })

  ollamaProcess.on('error', (err) => {
    console.error('[Ollama] Failed to start:', err.message)
    throw new Error('[Ollama] Failed to start Ollama — is it installed?')
  })

  ollamaManagedByUs = true
  await waitForOllama(baseUrl)
  console.log('[Ollama] Started and ready ✓')
}

export async function stopOllamaIfManaged(): Promise<void> {
  if (!ollamaManagedByUs || !ollamaProcess) return

  console.log('[Ollama] Stopping managed Ollama process...')
  ollamaProcess.kill()
  ollamaProcess = null
  ollamaManagedByUs = false
  console.log('[Ollama] Stopped')
}