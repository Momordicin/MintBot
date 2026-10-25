// electron/main/coreProcess.ts — 正式版本下拉起与停止 core 服务
// 用法：index.ts 在 app ready 后 await ensureCoreRunning(coreUrl, appPath)，在 will-quit / quit 调 stopSpawnedCore()；导出 pollUntilReady、buildTaskkillArgs、reportCoreExit 供测试
// 对应文件：electron/main/index.ts / electron/main/coreProcess.test.ts / scripts/run-core-prod.mjs
import { spawn, spawnSync } from 'child_process'

export const CORE_READY_TIMEOUT_MS = 60000
const CORE_PROBE_TIMEOUT_MS = 1500
const CORE_POLL_INTERVAL_MS = 500
const TASKKILL_TIMEOUT_MS = 5000

let spawnedCorePid: number | null = null

export function buildTaskkillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F']
}

export function reportCoreExit(
  childPid: number | undefined,
  currentPid: number | null,
  code: number | null,
  logger: Pick<Console, 'log' | 'error'> = console
): void {
  if (currentPid !== childPid) {
    logger.log('[Core] core service stopped')
    return
  }
  logger.error(`[Core] spawned core service exited (code ${code})`)
}

export async function pollUntilReady(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
  options: {
    shouldContinue?: () => boolean
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  } = {}
): Promise<boolean> {
  const shouldContinue = options.shouldContinue ?? (() => true)
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const deadline = now() + timeoutMs
  while (shouldContinue()) {
    if (await probe()) return true
    if (now() >= deadline) return false
    await sleep(intervalMs)
  }
  return false
}

async function probeCoreHealth(coreUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${coreUrl}/health`, { signal: AbortSignal.timeout(CORE_PROBE_TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}

export async function ensureCoreRunning(coreUrl: string, appPath: string): Promise<void> {
  if (await probeCoreHealth(coreUrl)) return

  let gone = false
  try {
    const child = spawn('node', ['scripts/run-core-prod.mjs'], {
      cwd: appPath,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.once('error', err => {
      gone = true
      spawnedCorePid = null
      console.error('[Core] failed to spawn core service:', err)
    })
    child.once('exit', code => {
      gone = true
      reportCoreExit(child.pid, spawnedCorePid, code)
      spawnedCorePid = null
    })
    if (child.pid === undefined) return
    spawnedCorePid = child.pid
  } catch (err) {
    console.error('[Core] failed to spawn core service:', err)
    return
  }

  const ready = await pollUntilReady(
    () => probeCoreHealth(coreUrl),
    CORE_READY_TIMEOUT_MS,
    CORE_POLL_INTERVAL_MS,
    { shouldContinue: () => !gone }
  )
  if (!ready) console.error('[Core] core service not ready; continuing without it')
}

export function stopSpawnedCore(): void {
  const pid = spawnedCorePid
  if (pid === null) return
  spawnedCorePid = null
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', buildTaskkillArgs(pid), {
        windowsHide: true,
        stdio: 'ignore',
        timeout: TASKKILL_TIMEOUT_MS,
      })
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch (err) {
    console.error('[Core] failed to stop core service:', err)
  }
}
