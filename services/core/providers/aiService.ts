import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'

let aiProcess: ChildProcess | null = null
let aiManagedByUs = false

// 只判断进程本身是否已经在跑（HTTP 能否连上、状态码是否 ok），不关心模型是否已加载——
// 模型是否加载由 EmbeddingProvider.ts 的 isEmbeddingReady（检查 embedding_loaded 字段）判断，
// 两者用途不同，不复用
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

async function waitForAiService(baseUrl: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isAiServiceRunning(baseUrl)) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

export async function ensureAiService(baseUrl: string): Promise<void> {
  if (await isAiServiceRunning(baseUrl)) {
    console.log('[AiService] Already running, not managed by MintBot')
    aiManagedByUs = false
    return
  }

  const pythonPath = path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe')
  if (!fs.existsSync(pythonPath)) {
    console.error(`[AiService] ${pythonPath} not found — run "pnpm setup:ai" first. AI 相关功能（embedding/NER）将不可用，走既有降级路径`)
    return
  }

  // 端口从调用方传入的 baseUrl 里解析，不独立再读一次 process.env.AI_PORT——
  // 否则这里和 EmbeddingProvider.ts 的 getAiBaseUrl() 各自算一遍端口，未来任一处的
  // 默认值/公式变了都会静默漂移，只会表现成一个查不出原因的启动超时。
  // URL.port 在端口等于 scheme 默认端口时返回空字符串（如 AI_PORT=80 时 http URL 的
  // .port 是 ''），兜底回退到 80，避免拼出 `--port ''` 这种参数
  const port = new URL(baseUrl).port || '80'
  console.log('[AiService] Not running, starting...')

  let stderrOutput = ''
  try {
    // stderr 走 pipe 而不是 ignore：Python 侧的启动失败模式（依赖缺失、端口占用、
    // import 报错）比 Ollama 多得多，全部丢弃会导致下面的超时日志除了"超时"什么都看不出
    aiProcess = spawn(pythonPath, ['-m', 'uvicorn', 'main:app', '--port', port], {
      cwd: path.resolve(process.cwd(), 'services/ai'),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (err) {
    // spawn 同步抛出的场景（如 EMFILE），不能让它冒泡到 ensureAiService 的调用方——
    // 那样会导致核心服务启动整体失败退出，正是本次改动要避免的
    console.error('[AiService] Failed to spawn:', err instanceof Error ? err.message : err)
    return
  }

  aiProcess.stderr?.on('data', chunk => {
    stderrOutput += chunk.toString()
  })

  aiProcess.on('error', (err) => {
    console.error('[AiService] Failed to start:', err.message)
  })

  aiManagedByUs = true
  const ready = await waitForAiService(baseUrl)
  // 只在启动等待窗口内累积 stderr，用于诊断这次启动是否失败；进程后续正常运行期间的
  // 输出不再需要（也不应该）无限累积在内存里，等到判断出 ready 与否就立刻停止监听
  aiProcess.stderr?.removeAllListeners('data')
  if (!ready) {
    console.error(
      '[AiService] Timed out waiting for AI service to start' +
      (stderrOutput ? `\n--- stderr ---\n${stderrOutput}` : '')
    )
    return
  }
  console.log('[AiService] Started and ready ✓')
}

export async function stopAiServiceIfManaged(): Promise<void> {
  if (!aiManagedByUs || !aiProcess) return

  console.log('[AiService] Stopping managed AI service process...')
  aiProcess.kill()
  aiProcess = null
  aiManagedByUs = false
  console.log('[AiService] Stopped')
}
