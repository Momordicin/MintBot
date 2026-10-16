// services/core/agents/codex.ts — 经官方 codex CLI 调用用户自己的 Codex 订阅：登录、登录状态与各单次/多轮场景
// 用法：routes/agents.ts 调 getCodexLoginStatus / launchCodexLogin；其余场景函数 codexWebSearch / codexUnderstandImage / codexAsk / codexExtract（schema 须含 additionalProperties:false）/ codexRoleplayDeep / codexRoleplayShallow 供 core 内业务调用；提示词走 stdin
// 对应文件：services/core/routes/agents.ts / services/core/agents/claudeCode.ts / src/settings/SubscriptionLogin.tsx
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

const CODEX_HOME_DIR = path.resolve(process.cwd(), 'data', '.codex-mintbot')
const RUN_DIR = path.resolve(process.cwd(), 'data', 'agent-run')

const FIXED_ARGS = [
  '--json',
  '--skip-git-repo-check',
  '--sandbox', 'read-only',
  '-c', 'project_root_markers=[]',
  '-c', 'features.shell_tool=false',
  '-c', 'tools.view_image=false',
  '-c', 'features.apps=false',
  '--disable', 'browser_use',
  '--disable', 'computer_use',
]

export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface CodexOptions {
  model?: string
  effort?: CodexEffort
  multiAgent?: boolean
  imageGeneration?: boolean
  signal?: AbortSignal
}

export interface CodexResult {
  text: string
  sessionId?: string
  structured?: unknown
}

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

function ensureDirs(): void {
  fs.mkdirSync(CODEX_HOME_DIR, { recursive: true })
  fs.mkdirSync(RUN_DIR, { recursive: true })
}

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  env.CODEX_HOME = CODEX_HOME_DIR
  return env
}

function runProcess(args: string[], stdin: string | null, signal?: AbortSignal): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Codex 调用已取消'))
      return
    }
    const child = spawn('codex', args, { cwd: RUN_DIR, env: buildEnv(), shell: false, windowsHide: true })
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
        reject(new Error('Codex 调用已取消'))
        return
      }
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(stdin ?? '')
  })
}

function tomlLiteral(value: string): string {
  return `'${value}'`
}

function optionArgs(opts: CodexOptions): string[] {
  const args: string[] = []
  if (opts.model) args.push('-m', opts.model)
  if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`)
  if (opts.multiAgent !== undefined) args.push(opts.multiAgent ? '--enable' : '--disable', 'multi_agent')
  if (opts.imageGeneration !== undefined) args.push(opts.imageGeneration ? '--enable' : '--disable', 'image_generation')
  return args
}

interface RunSpec {
  stdin: string
  webSearch?: boolean
  extraArgs?: string[]
  resumeId?: string
}

async function runCodex(spec: RunSpec, opts: CodexOptions): Promise<CodexResult> {
  ensureDirs()
  const args = [
    'exec',
    ...FIXED_ARGS,
    '-c', `web_search="${spec.webSearch ? 'live' : 'disabled'}"`,
    ...optionArgs(opts),
    ...(spec.extraArgs ?? []),
    ...(spec.resumeId ? ['resume', spec.resumeId] : []),
    '-',
  ]

  let proc: ProcessResult
  try {
    proc = await runProcess(args, spec.stdin, opts.signal)
  } catch (err) {
    if (opts.signal?.aborted) throw err
    console.error('[Codex] spawn failed:', err)
    throw new Error('无法启动 Codex，请确认已安装 codex 命令行')
  }

  let sessionId: string | undefined
  let text: string | undefined
  const failures: string[] = []
  for (const line of proc.stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: Record<string, any>
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id
    } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      text = event.item.text
    } else if (event.type === 'turn.failed') {
      failures.push(String(event.error?.message ?? trimmed))
    } else if (event.type === 'error') {
      failures.push(String(event.message ?? trimmed))
    }
  }

  if (failures.length > 0 || proc.code !== 0 || text === undefined) {
    console.error('[Codex] call failed:', { code: proc.code, stderr: proc.stderr, failures, text })
    throw new Error('Codex 调用失败，请确认订阅已登录且额度可用')
  }

  return { text, sessionId }
}

export async function getCodexLoginStatus(): Promise<boolean> {
  try {
    ensureDirs()
    const proc = await runProcess(['login', 'status'], null, AbortSignal.timeout(10000))
    return proc.code === 0
  } catch {
    return false
  }
}

export function launchCodexLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      ensureDirs()
    } catch (err) {
      reject(err)
      return
    }
    const child = spawn('cmd.exe', ['/c', 'start "" /wait cmd /c codex login'], {
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

export function codexWebSearch(params: { query: string } & CodexOptions): Promise<CodexResult> {
  const { query, ...opts } = params
  return runCodex({ stdin: query, webSearch: true, extraArgs: ['--ephemeral'] }, opts)
}

export function codexUnderstandImage(params: { imagePath: string; question: string } & CodexOptions): Promise<CodexResult> {
  const { imagePath, question, ...opts } = params
  return runCodex({ stdin: question, extraArgs: ['-i', imagePath, '--ephemeral'] }, opts)
}

export function codexAsk(params: { prompt: string } & CodexOptions): Promise<CodexResult> {
  const { prompt, ...opts } = params
  return runCodex({ stdin: prompt, extraArgs: ['--ephemeral'] }, opts)
}

export async function codexExtract(params: { prompt: string; schema: object } & CodexOptions): Promise<CodexResult> {
  const { prompt, schema, ...opts } = params
  ensureDirs()
  const schemaFile = path.join(RUN_DIR, `${randomUUID()}.json`)
  try {
    fs.writeFileSync(schemaFile, JSON.stringify(schema), 'utf-8')
    const result = await runCodex({ stdin: prompt, extraArgs: ['--output-schema', schemaFile, '--ephemeral'] }, opts)
    try {
      return { ...result, structured: JSON.parse(result.text) }
    } catch (err) {
      console.error('[Codex] structured output is not valid JSON:', { text: result.text, err })
      throw new Error('Codex 返回的结构化结果不是有效的 JSON')
    }
  } finally {
    fs.rmSync(schemaFile, { force: true })
  }
}

export async function codexRoleplayDeep(params: { persona: string; message: string; sessionId?: string } & CodexOptions): Promise<CodexResult> {
  const { persona, message, sessionId, ...opts } = params
  ensureDirs()
  const personaFile = path.join(RUN_DIR, `${randomUUID()}.txt`)
  try {
    fs.writeFileSync(personaFile, persona, 'utf-8')
    return await runCodex({
      stdin: message,
      extraArgs: ['-c', `model_instructions_file=${tomlLiteral(personaFile)}`],
      resumeId: sessionId,
    }, opts)
  } finally {
    fs.rmSync(personaFile, { force: true })
  }
}

export function codexRoleplayShallow(params: { persona: string; message: string; sessionId?: string } & CodexOptions): Promise<CodexResult> {
  const { persona, message, sessionId, ...opts } = params
  return runCodex({
    stdin: sessionId ? message : `${persona}\n\n${message}`,
    extraArgs: ['-c', 'personality="none"'],
    resumeId: sessionId,
  }, opts)
}
