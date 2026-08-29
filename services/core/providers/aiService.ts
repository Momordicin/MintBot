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

// 30s 曾经是默认值，实测在冷缓存/系统负载较高时不够用——torch/transformers/FlagEmbedding
// 这几个 import 本身（不是模型权重加载，是模块导入）在这种情况下就可能超过 30s，导致
// Node 侧判定"启动超时"时，Python 进程其实还在正常导入，只是比平时慢，并非卡死或联网失败。
// 90s 留出更宽松的余量；真的卡死的情况这个时间也足够暴露问题，不算无限等待
const AI_SERVICE_STARTUP_TIMEOUT_MS = 90000

async function waitForAiService(baseUrl: string, timeoutMs = AI_SERVICE_STARTUP_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isAiServiceRunning(baseUrl)) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

// 返回值供调用方（index.ts）判断要不要跟着发一次 embedding 预热请求——超时/生成失败时
// 已经确定服务没就绪，再去发一次必然失败的请求只会多一条误导性的报错日志，没有意义
export async function ensureAiService(baseUrl: string): Promise<boolean> {
  if (await isAiServiceRunning(baseUrl)) {
    // 开发模式下 tsx watch 热重载：旧 core 实例退出时会杀掉它管理的 Python 子进程，但
    // uvicorn 收到 SIGTERM 到真正关闭监听端口之间有短暂窗口——上面这次检查可能刚好落在
    // 这个窗口内，探测到"还在"，但进程其实正在死。若就此判定为"别人管的、已经稳定运行"
    // 直接 return，一旦它随后真的退出，这个 core 实例永远不会为自己补拉一个替代进程
    // （ensureAiService 只在启动时调用一次）。稍等再确认一次，避免误判
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
    //
    // HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE=1：即使模型权重已被 `pnpm setup:ai` 预下载到本地
    // 缓存，transformers 的 AutoTokenizer.from_pretrained 在部分版本上仍会为 chat-template
    // 自动检测发起一次实时 HuggingFace Hub API 请求（list_repo_templates → list_repo_tree）。
    // 无网络或网络较慢时这个请求会一直挂到它自己的超时才返回，远超 Node 侧 embedding
    // 预热等待的 30s，表现为一次误导性的"预热失败"级联超时。huggingface_hub 内部把这
    // 两个变量当同一个开关的两种写法处理（互为 fallback，见 huggingface_hub/constants.py），
    // 两个都设置只是兼容万一装到某个 transformers 版本自己也单独检查这个变量的情况，
    // 不代表两边各有一套独立生效的离线开关
    aiProcess = spawn(pythonPath, ['-m', 'uvicorn', 'main:app', '--port', port], {
      cwd: path.resolve(process.cwd(), 'services/ai'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
    })
  } catch (err) {
    // spawn 同步抛出的场景（如 EMFILE），不能让它冒泡到 ensureAiService 的调用方——
    // 那样会导致核心服务启动整体失败退出，正是本次改动要避免的
    console.error('[AiService] Failed to spawn:', err instanceof Error ? err.message : err)
    return false
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
    return false
  }
  console.log('[AiService] Started and ready ✓')
  return true
}

// 强制杀死前的等待上限：正常情况下 uvicorn 收到 SIGTERM 会很快退出，这里只是兜底，
// 避免一个卡住不退的子进程让 stopAiServiceIfManaged 无限期挂住调用方（SIGINT/SIGTERM 处理器）
const FORCE_KILL_TIMEOUT_MS = 3000

export async function stopAiServiceIfManaged(): Promise<void> {
  if (!aiManagedByUs || !aiProcess) return

  console.log('[AiService] Stopping managed AI service process...')
  const proc = aiProcess
  aiProcess = null
  aiManagedByUs = false

  // 必须等到子进程真正退出（监听端口真正释放）才 resolve——这是 ensureAiService 里
  // "已经在跑就不重复启动"这个检查能可靠区分"上一个实例还没死透"和"确实有人在跑"的前提，
  // 否则调用方（SIGTERM 处理器）以为已经停好就继续往下走，下一个 core 实例可能在端口
  // 还没释放的窗口内探测到"还在跑"，误判为不归自己管
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
