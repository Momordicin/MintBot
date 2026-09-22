import { spawn, ChildProcess } from 'child_process'

let ollamaProcess: ChildProcess | null = null
let ollamaManagedByUs = false

export function getOllamaBaseUrl(baseUrl?: string): string {
  return baseUrl ?? 'http://localhost:11434'
}

export async function isOllamaRunning(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return []
    const json = await response.json()
    if (!Array.isArray(json?.models)) return []
    return json.models
      .map((model: unknown) => (model && typeof model === 'object' && typeof (model as { name?: unknown }).name === 'string' ? (model as { name: string }).name : null))
      .filter((name: string | null): name is string => name !== null)
  } catch {
    return []
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
  try {
    ollamaProcess = spawn('ollama', ['serve'], {
      detached: false,
      stdio: 'ignore',
    })
  } catch (err) {
    console.error('[Ollama] Failed to spawn:', err instanceof Error ? err.message : err)
    return
  }

  ollamaProcess.on('error', (err) => {
    console.error('[Ollama] Failed to start:', err.message)
  })

  ollamaManagedByUs = true
  try {
    await waitForOllama(baseUrl)
    console.log('[Ollama] Started and ready ✓')
  } catch (err) {
    console.error('[Ollama] Failed to start:', err)
  }
}

export async function stopOllamaIfManaged(): Promise<void> {
  if (!ollamaManagedByUs || !ollamaProcess) return

  console.log('[Ollama] Stopping managed Ollama process...')
  ollamaProcess.kill()
  ollamaProcess = null
  ollamaManagedByUs = false
  console.log('[Ollama] Stopped')
}