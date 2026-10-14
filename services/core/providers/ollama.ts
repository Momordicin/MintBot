// services/core/providers/ollama.ts — Ollama 本地模型服务的探测、模型列表查询，以及未运行时由 core 启动 `ollama serve`
// 用法：index.ts 的 start() 调 shouldEnsureOllama / ensureOllama，SIGINT/SIGTERM 时调 stopOllamaIfManaged；routes/models.ts 调 ensureOllama / listOllamaModels / getOllamaBaseUrl；state.ts 调 isOllamaRunning
// 对应文件：services/core/index.ts / services/core/routes/models.ts / services/core/state.ts / services/core/providers/ollama.test.ts
import { spawn, ChildProcess } from 'child_process'

let ollamaProcess: ChildProcess | null = null
let ollamaManagedByUs = false
let ollamaStartInFlight: Promise<boolean> | null = null
let ollamaProcessFailure: Promise<void> = new Promise<void>(() => {})

export function getOllamaBaseUrl(baseUrl?: string): string {
  return baseUrl || 'http://localhost:11434'
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

async function waitForOllama(baseUrl: string, failure: Promise<void>, timeoutMs = 30000): Promise<void> {
  let failed = false
  void failure.then(() => {
    failed = true
  })
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (failed) throw new Error('[Ollama] Process failed or exited before Ollama became ready')
    if (await isOllamaRunning(baseUrl)) return
    if (failed) throw new Error('[Ollama] Process failed or exited before Ollama became ready')
    await Promise.race([new Promise(r => setTimeout(r, 1000)), failure])
  }
  throw new Error('[Ollama] Timed out waiting for Ollama to start')
}

export function shouldEnsureOllama(chatType: string, backgroundType: string, anyPresetUsesOllama: boolean): boolean {
  return chatType === 'ollama' || backgroundType === 'ollama' || anyPresetUsesOllama
}

export function ensureOllama(ollamaBaseUrl?: string): Promise<boolean> {
  if (!ollamaStartInFlight) {
    ollamaStartInFlight = startOllamaIfNeeded(ollamaBaseUrl).finally(() => {
      ollamaStartInFlight = null
    })
  }
  return ollamaStartInFlight
}

async function startOllamaIfNeeded(ollamaBaseUrl?: string): Promise<boolean> {
  const baseUrl = getOllamaBaseUrl(ollamaBaseUrl)

  if (ollamaManagedByUs && ollamaProcess && ollamaProcess.exitCode === null && ollamaProcess.signalCode === null) {
    if (await isOllamaRunning(baseUrl)) return true
    console.log('[Ollama] Managed process is not responding yet, waiting...')
    try {
      await waitForOllama(baseUrl, ollamaProcessFailure)
      console.log('[Ollama] Started and ready ✓')
      return true
    } catch (err) {
      console.error('[Ollama] Failed to start:', err)
      return false
    }
  }

  if (await isOllamaRunning(baseUrl)) {
    console.log('[Ollama] Already running, not managed by MintBot')
    ollamaManagedByUs = false
    return true
  }

  console.log('[Ollama] Not running, starting...')
  try {
    ollamaProcess = spawn('ollama', ['serve'], {
      detached: false,
      stdio: 'ignore',
    })
  } catch (err) {
    console.error('[Ollama] Failed to spawn:', err instanceof Error ? err.message : err)
    return false
  }

  const child = ollamaProcess
  ollamaProcessFailure = new Promise<void>(resolve => {
    child.on('error', (err) => {
      console.error('[Ollama] Failed to start:', err.message)
      if (ollamaProcess === child) {
        ollamaProcess = null
        ollamaManagedByUs = false
      }
      resolve()
    })
    child.on('exit', () => {
      resolve()
    })
  })

  ollamaManagedByUs = true
  try {
    await waitForOllama(baseUrl, ollamaProcessFailure)
    console.log('[Ollama] Started and ready ✓')
    return true
  } catch (err) {
    console.error('[Ollama] Failed to start:', err)
    return false
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