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

  try {
    // stderr/stdout 都走 pipe 而不是 ignore：Python 侧启动失败模式（依赖缺失、端口占用、
    // import 报错）以及运行期间懒加载模型时的异常，都要能在 Node 控制台看到，不能丢弃。
    //
    // PYTHONIOENCODING=utf-8：Python 在 Windows 上，标准输出如果不是直接接在真实终端上、
    // 而是被管道（pipe）捕获（现在这个 stdio 配置就是这种情况），会退回用系统 ANSI 代码页
    // （中文 Windows 下是 GBK）编码输出——一旦 print 里有 GBK 编不出来的字符（比如 "✓"，
    // 或 tqdm 进度条用的 "█"），就会直接抛 UnicodeEncodeError 把整个请求（乃至进程）炸掉。
    // 显式强制 UTF-8，不依赖系统代码页
    aiProcess = spawn(pythonPath, ['-m', 'uvicorn', 'main:app', '--port', port], {
      cwd: path.resolve(process.cwd(), 'services/ai'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
  } catch (err) {
    // spawn 同步抛出的场景（如 EMFILE），不能让它冒泡到 ensureAiService 的调用方——
    // 那样会导致核心服务启动整体失败退出，正是本次改动要避免的
    console.error('[AiService] Failed to spawn:', err instanceof Error ? err.message : err)
    return
  }

  // 持续转发，不只在启动等待窗口内——加载可能发生在启动之后很久（RAG 召回/整理模式触发
  // 的懒加载），运行期间任何时候的输出/报错都要能看到，不能提前摘掉监听
  aiProcess.stdout?.on('data', chunk => {
    console.log(`[AiService] ${chunk.toString().trimEnd()}`)
  })
  aiProcess.stderr?.on('data', chunk => {
    console.error(`[AiService] ${chunk.toString().trimEnd()}`)
  })

  aiProcess.on('error', (err) => {
    console.error('[AiService] Failed to start:', err.message)
  })

  aiManagedByUs = true
  const ready = await waitForAiService(baseUrl)
  if (!ready) {
    console.error('[AiService] Timed out waiting for AI service to start')
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
