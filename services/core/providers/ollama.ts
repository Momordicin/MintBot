// services/core/providers/ollama.ts — Ollama 本地模型服务的探测、模型列表查询，以及未运行时由 core 启动 `ollama serve`
// 用法：index.ts 的 start() 在配置或任一预设使用 ollama 时调 ensureOllama(baseUrl)（等待至多 30 秒），SIGINT/SIGTERM 时调 stopOllamaIfManaged()（仅停止自己启动的进程）；routes/models.ts 调 listOllamaModels / getOllamaBaseUrl；state.ts 调 isOllamaRunning
// 对应文件：services/core/index.ts / services/core/routes/models.ts / services/core/state.ts / services/core/providers/ollama.test.ts
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