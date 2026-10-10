// services/core/characters/transitionChain.ts
// 用途：检查角色目录内的一组素材文件（checkFileGroup），并把 manifest 中某个触发点的转场链解析成每步的候选文件集合（resolveTransitionChain）
// 用法：checkFileGroup(characterDir, group, context) 返回合法文件；resolveTransitionChain({ characterId, characterDir, raw, trigger, form }) 返回整条链，问题一律 console.warn
// 对应文件：services/core/characters/manifest.ts（加载时检查）/ services/core/routes/transitionChain.ts（接口）/ shared/transitionChain.ts（契约）/ services/core/characters/transitionChain.test.ts

import fs from 'fs'
import path from 'path'
import {
  DEFAULT_TRANSITION_DURATION_MS,
  TRANSITION_PICKS,
  type TransitionChainStep,
  type TransitionForm,
} from '../../../shared/transitionChain.js'

const ALLOWED_EXTENSIONS = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp'])
const FROM_PREFIX = 'emotions.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownValue(source: unknown, key: string): unknown {
  return isRecord(source) && Object.hasOwn(source, key) ? source[key] : undefined
}

function fileProblem(characterDir: string, file: unknown): string | null {
  if (typeof file !== 'string' || file === '') return '不是非空字符串'
  if (path.win32.isAbsolute(file) || path.posix.isAbsolute(file)) return '是绝对路径'
  const relative = path.relative(characterDir, path.resolve(characterDir, file))
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return '越出角色目录'
  }
  if (!ALLOWED_EXTENSIONS.has(path.extname(file).toLowerCase())) return '扩展名不在 gif/png/jpg/jpeg/webp 内'
  let isFile = false
  try {
    isFile = fs.statSync(path.resolve(characterDir, file)).isFile()
  } catch {
    isFile = false
  }
  return isFile ? null : '磁盘上不存在'
}

export function checkFileGroup(characterDir: string, group: unknown, context: string): string[] {
  if (!Array.isArray(group)) {
    console.warn(`[Transition] ${context} 文件组类型错误，应为数组，忽略该组`)
    return []
  }
  const valid: string[] = []
  for (const file of group) {
    const problem = fileProblem(characterDir, file)
    if (problem === null) {
      valid.push(file as string)
    } else {
      console.warn(`[Transition] ${context} 文件 ${JSON.stringify(file)} ${problem}，已跳过`)
    }
  }
  return valid
}

function normalizeFromEntries(from: unknown): unknown[] | null {
  if (typeof from === 'string') return [from]
  if (Array.isArray(from)) return from
  return null
}

function resolveStep(
  characterDir: string,
  step: unknown,
  emotions: unknown,
  context: string
): TransitionChainStep | null {
  if (!isRecord(step)) {
    console.warn(`[Transition] ${context} 不是对象，已去掉该步`)
    return null
  }

  const entries = normalizeFromEntries(step.from)
  if (entries === null) {
    console.warn(`[Transition] ${context} from 缺失或类型错误，应为字符串或字符串数组，已去掉该步`)
    return null
  }

  const files = new Set<string>()
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.startsWith(FROM_PREFIX) || entry.length === FROM_PREFIX.length) {
      console.warn(`[Transition] ${context} 键 ${JSON.stringify(entry)} 不是 "emotions.xx" 形式，已跳过`)
      continue
    }
    const group = ownValue(emotions, entry.slice(FROM_PREFIX.length))
    if (group === undefined) {
      console.warn(`[Transition] ${context} 键 ${entry} 在立绘文件组里不存在，已跳过`)
      continue
    }
    for (const file of checkFileGroup(characterDir, group, `${context} 键 ${entry}`)) files.add(file)
  }
  if (files.size === 0) {
    console.warn(`[Transition] ${context} 没有可用候选文件，已去掉该步`)
    return null
  }

  let durationMs = DEFAULT_TRANSITION_DURATION_MS
  if (typeof step.durationMs === 'number' && Number.isFinite(step.durationMs) && step.durationMs > 0) {
    durationMs = step.durationMs
  } else {
    console.warn(`[Transition] ${context} durationMs 缺失或不是正数，使用默认值 ${DEFAULT_TRANSITION_DURATION_MS}`)
  }

  let pick: TransitionChainStep['pick'] = 'random'
  if (typeof step.pick === 'string' && (TRANSITION_PICKS as readonly string[]).includes(step.pick)) {
    pick = step.pick as TransitionChainStep['pick']
  } else {
    console.warn(`[Transition] ${context} pick 缺失或不在允许范围，使用默认值 'random'`)
  }

  return { files: [...files], durationMs, pick }
}

export function resolveTransitionChain(params: {
  characterId: string
  characterDir: string
  raw: unknown
  trigger: string
  form: TransitionForm
}): TransitionChainStep[] {
  const { characterId, characterDir, raw, trigger, form } = params
  const chain = ownValue(ownValue(raw, 'transitions'), trigger)
  if (chain === undefined) return []
  if (!Array.isArray(chain)) {
    console.warn(`[Transition] 角色 ${characterId} 触发点 ${trigger} 类型错误，应为数组，按空链处理`)
    return []
  }

  const emotions = ownValue(ownValue(ownValue(raw, 'portraits'), form), 'emotions')
  const steps: TransitionChainStep[] = []
  chain.forEach((step, index) => {
    const resolved = resolveStep(characterDir, step, emotions, `角色 ${characterId} 触发点 ${trigger} 第 ${index + 1} 步`)
    if (resolved) steps.push(resolved)
  })
  return steps
}
