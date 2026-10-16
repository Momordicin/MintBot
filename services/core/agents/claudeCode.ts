// services/core/agents/claudeCode.ts — 经官方 claude CLI 调用用户自己的 Claude Code 订阅：登录、登录状态与各单次/多轮场景
// 用法：routes/agents.ts 调 getClaudeLoginStatus / launchClaudeLogin；其余场景函数 claudeWebSearch / claudeUnderstandImage / claudeAsk / claudeExtract / claudeRoleplay 供 core 内业务调用；提示词走 stdin
// 对应文件：services/core/routes/agents.ts / services/core/agents/codex.ts / src/settings/SubscriptionLogin.tsx
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

const CONFIG_DIR = path.resolve(process.cwd(), 'data', '.claude-mintbot')
const RUN_DIR = path.resolve(process.cwd(), 'data', 'agent-run')

const FIXED_ARGS = [
  '-p',
  '--output-format', 'json',
  '--setting-sources', 'user',
  '--strict-mcp-config',
  '--permission-mode', 'dontAsk',
  '--permission-prompts', 'none',
  '--disable-slash-commands',
]

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ClaudeOptions {
  model?: string
  effort?: ClaudeEffort
  maxBudgetUsd?: number
  signal?: AbortSignal
}

export interface ClaudeResult {
  text: string
  sessionId?: string
  costUsd?: number
  structured?: unknown
}

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

function ensureDirs(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.mkdirSync(RUN_DIR, { recursive: true })
}

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
  env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '1'
  return env
}

function runProcess(args: string[], cwd: string, stdin: string | null, signal?: AbortSignal): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Claude Code 调用已取消'))
      return
    }
    const child = spawn('claude', args, { cwd, env: buildEnv(), shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let aborted = false
    const onAbort = () => {
      aborted = true
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdin.on('error', () => {})
    child.on('error', err => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort)
      if (aborted) {
        reject(new Error('Claude Code 调用已取消'))
        return
      }
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(stdin ?? '')
  })
}

function optionArgs(opts: ClaudeOptions): string[] {
  const args: string[] = []
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd))
  return args
}

async function runClaude(prompt: string, extraArgs: string[], opts: ClaudeOptions, cwd: string = RUN_DIR): Promise<ClaudeResult> {
  ensureDirs()
  const args = [...FIXED_ARGS, ...optionArgs(opts), ...extraArgs]
  let proc: ProcessResult
  try {
    proc = await runProcess(args, cwd, prompt, opts.signal)
  } catch (err) {
    if (opts.signal?.aborted) throw err
    console.error('[ClaudeCode] spawn failed:', err)
    throw new Error('无法启动 Claude Code，请确认已安装 claude 命令行')
  }

  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(proc.stdout)
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>
  } catch {
    parsed = null
  }

  if (proc.code !== 0 || parsed === null || parsed.is_error === true) {
    console.error('[ClaudeCode] call failed:', { code: proc.code, stderr: proc.stderr, result: parsed?.result ?? proc.stdout })
    throw new Error('Claude Code 调用失败，请确认订阅已登录且额度可用')
  }

  return {
    text: typeof parsed.result === 'string' ? parsed.result : '',
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined,
    structured: parsed.structured_output,
  }
}

export async function getClaudeLoginStatus(): Promise<boolean> {
  try {
    ensureDirs()
    const proc = await runProcess(['auth', 'status'], RUN_DIR, null, AbortSignal.timeout(10000))
    const parsed = JSON.parse(proc.stdout)
    return parsed?.loggedIn === true
  } catch {
    return false
  }
}

export function launchClaudeLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      ensureDirs()
    } catch (err) {
      reject(err)
      return
    }
    const child = spawn('cmd.exe', ['/c', 'start "" /wait cmd /c claude auth login'], {
      cwd: RUN_DIR,
      env: buildEnv(),
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
    child.on('error', reject)
    child.on('exit', () => resolve())
  })
}

export function claudeWebSearch(params: { query: string } & ClaudeOptions): Promise<ClaudeResult> {
  const { query, ...opts } = params
  return runClaude(query, ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch', '--no-session-persistence'], opts)
}

export async function claudeUnderstandImage(params: { imagePath: string; question: string } & ClaudeOptions): Promise<ClaudeResult> {
  const { imagePath, question, ...opts } = params
  ensureDirs()
  const subDir = path.join(RUN_DIR, randomUUID())
  const fileName = path.basename(imagePath)
  try {
    fs.mkdirSync(subDir, { recursive: true })
    fs.copyFileSync(imagePath, path.join(subDir, fileName))
    const prompt = `请读取文件 ${fileName}，并回答：${question}`
    return await runClaude(prompt, ['--tools', 'Read', '--no-session-persistence'], opts, subDir)
  } finally {
    fs.rmSync(subDir, { recursive: true, force: true })
  }
}

export function claudeAsk(params: { prompt: string } & ClaudeOptions): Promise<ClaudeResult> {
  const { prompt, ...opts } = params
  return runClaude(prompt, ['--tools', '', '--no-session-persistence'], opts)
}

export function claudeExtract(params: { prompt: string; schema: object } & ClaudeOptions): Promise<ClaudeResult> {
  const { prompt, schema, ...opts } = params
  return runClaude(prompt, ['--tools', '', '--json-schema', JSON.stringify(schema), '--no-session-persistence'], opts)
}

export async function claudeRoleplay(params: { persona: string; message: string; sessionId?: string } & ClaudeOptions): Promise<ClaudeResult> {
  const { persona, message, sessionId, ...opts } = params
  ensureDirs()
  const personaFile = path.join(RUN_DIR, `${randomUUID()}.txt`)
  try {
    fs.writeFileSync(personaFile, persona, 'utf-8')
    const extra = ['--tools', '', '--system-prompt-file', personaFile]
    if (sessionId) extra.push('--resume', sessionId)
    return await runClaude(message, extra, opts)
  } finally {
    fs.rmSync(personaFile, { force: true })
  }
}
