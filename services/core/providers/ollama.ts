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

async function waitForOllama(baseUrl: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isOllamaRunning(baseUrl)) return
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('[Ollama] Timed out waiting for Ollama to start')
}

// 启动失败（spawn 报错 / 等待超时）不向调用方抛出——TDD Phase 1 checklist 要求的"未运行时
// 明确 UI 提示"由 state.ts 的 buildStatePayload 每次重新调用 isOllamaRunning 独立承担，不依赖
// 这里启动时这一次检测是否成功；这里失败只需 console.error 记录，让核心服务继续启动
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
    // spawn 同步抛出的场景（如 EMFILE），不能让它冒泡到调用方导致核心服务启动整体失败退出
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