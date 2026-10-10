// services/core/characters/manifestAssets.ts — 角色包素材文件校验与转场链解析的唯一实现：检查素材组里的文件是否可用，并据此解析某个转场触发器的步骤
//
// 用法：checkFileGroup(characterDir, group) 检查单个素材组；resolveTransitionChain({...}) 解析一条转场链（每次调用都基于传入的原始 manifest，不缓存）；validateManifestAssets(characterId, raw, characterDir) 载入期整包校验；logAssetProblems(problems) 统一输出告警
// 配套文件：services/core/characters/manifest.ts（载入期校验）/ services/core/routes/transitions.ts（转场链接口）/ services/core/characters/manifestAssets.test.ts

import fs from 'fs'
import path from 'path'

export const ALLOWED_IMAGE_EXTENSIONS: readonly string[] = ['.gif', '.png', '.jpg', '.jpeg', '.webp']
export const DEFAULT_TRANSITION_DURATION_MS = 3000
export const PORTRAIT_FORMS = ['pixel', 'illustration'] as const

export type PortraitFormName = (typeof PORTRAIT_FORMS)[number]
export type IsRegularFile = (absolutePath: string) => boolean

export interface AssetProblem {
  severity: 'warn' | 'error'
  message: string
}

export interface FileGroupCheck {
  validFiles: string[]
  problems: AssetProblem[]
}

export interface TransitionStepFiles {
  files: string[]
  durationMs: number
}

export interface ResolvedTransitionChain {
  steps: TransitionStepFiles[]
  problems: AssetProblem[]
}

const TRANSITION_FROM_PREFIX = 'emotions.'

export function isRegularFileOnDisk(absolutePath: string): boolean {
  try {
    return fs.statSync(absolutePath).isFile()
  } catch {
    return false
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function getOwn(record: Record<string, unknown> | null, key: string): unknown {
  if (record === null || !Object.prototype.hasOwnProperty.call(record, key)) return undefined
  return record[key]
}

function prefixProblems(problems: AssetProblem[], prefix: string): AssetProblem[] {
  return problems.map(problem => ({ severity: problem.severity, message: `${prefix} ${problem.message}` }))
}

export function checkFileGroup(
  characterDir: string,
  group: unknown,
  isRegularFile: IsRegularFile = isRegularFileOnDisk
): FileGroupCheck {
  if (!Array.isArray(group)) {
    return { validFiles: [], problems: [{ severity: 'warn', message: '素材组类型错误，应为字符串数组，忽略该组' }] }
  }

  const root = path.resolve(characterDir)
  const validFiles: string[] = []
  const problems: AssetProblem[] = []
  const reject = (message: string) => problems.push({ severity: 'warn', message })

  for (const entry of group) {
    if (typeof entry !== 'string') {
      reject(`file=${JSON.stringify(entry)} 条目类型错误，应为字符串，忽略该文件`)
      continue
    }
    if (!ALLOWED_IMAGE_EXTENSIONS.includes(path.extname(entry).toLowerCase())) {
      reject(`file=${entry} 扩展名不受支持（允许 ${ALLOWED_IMAGE_EXTENSIONS.join('/')}），忽略该文件`)
      continue
    }
    const resolved = path.resolve(root, entry)
    if (path.isAbsolute(entry) || !resolved.startsWith(root + path.sep)) {
      reject(`file=${entry} 路径越出角色包目录，忽略该文件`)
      continue
    }
    if (!isRegularFile(resolved)) {
      reject(`file=${entry} 文件不存在或不是普通文件，忽略该文件`)
      continue
    }
    validFiles.push(entry)
  }
  return { validFiles, problems }
}

export function resolveTransitionChain(params: {
  characterId: string
  characterDir: string
  rawManifest: unknown
  trigger: string
  form: PortraitFormName
  isRegularFile?: IsRegularFile
}): ResolvedTransitionChain {
  const { characterId, characterDir, rawManifest, trigger, form, isRegularFile } = params
  const steps: TransitionStepFiles[] = []
  const problems: AssetProblem[] = []
  const chainPrefix = `[Transition] character=${characterId} trigger=${trigger}`

  const manifest = asRecord(rawManifest)
  const chain = getOwn(asRecord(getOwn(manifest, 'transitions')), trigger)
  if (chain === undefined) return { steps, problems }
  if (!Array.isArray(chain)) {
    problems.push({ severity: 'warn', message: `${chainPrefix} 转场链类型错误，应为数组，视为空链` })
    return { steps, problems }
  }

  const emotions = asRecord(getOwn(asRecord(getOwn(asRecord(getOwn(manifest, 'portraits')), form)), 'emotions'))

  chain.forEach((rawStep, index) => {
    const stepPrefix = `${chainPrefix} step=${index}`
    const step = asRecord(rawStep)
    if (step === null) {
      problems.push({ severity: 'warn', message: `${stepPrefix} 步骤类型错误，应为对象，跳过该步` })
      return
    }

    const from = step.from
    const sources: unknown[] = typeof from === 'string' ? [from] : Array.isArray(from) ? from : []
    if (sources.length === 0) {
      problems.push({ severity: 'warn', message: `${stepPrefix} from 缺失、类型错误或为空，跳过该步` })
      return
    }

    const candidates = new Set<string>()
    for (const source of sources) {
      if (typeof source !== 'string' || !source.startsWith(TRANSITION_FROM_PREFIX) || source.length === TRANSITION_FROM_PREFIX.length) {
        problems.push({ severity: 'warn', message: `${stepPrefix} key=${typeof source === 'string' ? source : JSON.stringify(source)} 不是 "emotions.<key>" 形式，忽略该来源` })
        continue
      }
      const group = getOwn(emotions, source.slice(TRANSITION_FROM_PREFIX.length))
      if (group === undefined) {
        problems.push({ severity: 'warn', message: `${stepPrefix} key=${source} 在 portraits.${form}.emotions 中不存在，忽略该来源` })
        continue
      }
      const check = checkFileGroup(characterDir, group, isRegularFile)
      problems.push(...prefixProblems(check.problems, `${stepPrefix} key=${source}`))
      check.validFiles.forEach(file => candidates.add(file))
    }

    if (step.pick !== undefined && step.pick !== 'random') {
      problems.push({ severity: 'error', message: `${stepPrefix} pick=${JSON.stringify(step.pick)} 不受支持，按 random 处理` })
    }

    let durationMs = DEFAULT_TRANSITION_DURATION_MS
    if (typeof step.durationMs === 'number' && Number.isFinite(step.durationMs) && step.durationMs > 0) {
      durationMs = step.durationMs
    } else {
      problems.push({ severity: 'warn', message: `${stepPrefix} durationMs 缺失或不是正数，使用默认值 ${DEFAULT_TRANSITION_DURATION_MS}` })
    }

    if (candidates.size === 0) {
      problems.push({ severity: 'warn', message: `${stepPrefix} 没有可用素材，跳过该步` })
      return
    }
    steps.push({ files: [...candidates], durationMs })
  })

  return { steps, problems }
}

export function validateManifestAssets(
  characterId: string,
  rawManifest: unknown,
  characterDir: string,
  isRegularFile?: IsRegularFile
): AssetProblem[] {
  const problems: AssetProblem[] = []
  const manifest = asRecord(rawManifest)

  const checkGroup = (location: string, group: unknown) => {
    const check = checkFileGroup(characterDir, group, isRegularFile)
    problems.push(...prefixProblems(check.problems, `[CharacterAssets] character=${characterId} ${location}`))
  }
  const checkGroupMap = (location: string, map: unknown, wrapSingle: boolean) => {
    const record = asRecord(map)
    if (record === null) return
    for (const [key, group] of Object.entries(record)) {
      checkGroup(`${location}.${key}`, wrapSingle ? [group] : group)
    }
  }

  const portraits = asRecord(getOwn(manifest, 'portraits'))
  for (const form of PORTRAIT_FORMS) {
    const emotions = getOwn(asRecord(getOwn(portraits, form)), 'emotions')
    checkGroupMap(`portraits.${form}.emotions`, emotions, false)
  }
  checkGroupMap('interactionStates', getOwn(manifest, 'interactionStates'), true)
  checkGroupMap('reservedStates', getOwn(manifest, 'reservedStates'), false)

  const transitions = asRecord(getOwn(manifest, 'transitions'))
  for (const trigger of Object.keys(transitions ?? {})) {
    const chain = resolveTransitionChain({
      characterId,
      characterDir,
      rawManifest,
      trigger,
      form: 'pixel',
      isRegularFile,
    })
    problems.push(...chain.problems)
  }
  return problems
}

export function logAssetProblems(problems: AssetProblem[]): void {
  for (const problem of problems) {
    if (problem.severity === 'error') console.error(problem.message)
    else console.warn(problem.message)
  }
}
