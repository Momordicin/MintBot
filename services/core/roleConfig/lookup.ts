// services/core/roleConfig/lookup.ts — 一键生成角色配置的查找：抽名字、联网搜索、统合出备选项
// 用法：routes/roleConfig.ts 调 lookupRoleConfig(preset, signal, onStep)
// 对应文件：services/core/routes/roleConfig.ts / services/core/roleConfig/prompts.ts / services/core/search/webSearch.ts / services/core/providers/ModelProvider.ts / services/core/util/jsonSalvage.ts
import type { Preset } from '../../../shared/types/index.js'
import { getModelProviderConfig } from '../config/index.js'
import { createModelProviderForPreset } from '../providers/ModelProvider.js'
import { getPresetApiKeys } from '../session/queries.js'
import { webSearch } from '../search/webSearch.js'
import { parseJsonSalvage } from '../util/jsonSalvage.js'
import { buildExtractPrompt, buildMergePrompt, buildSearchPrompt } from './prompts.js'

export type RoleConfigStep = 'extract' | 'search' | 'merge'

export interface RoleConfigAlias {
  name: string
  pages: number[]
}

export interface RoleConfigCandidate {
  main_name: string
  aliases: RoleConfigAlias[]
  source_summary: string
  relation: string | null
  pages: number[]
}

export type RoleConfigStepState = 'start' | 'done' | 'failed'

export type RoleConfigResult =
  | { kind: 'candidates'; candidates: RoleConfigCandidate[]; personaMainName: string; personaNames: string[] }
  | { kind: 'names'; mainName: string | null; names: string[]; failed: boolean }

class RoleConfigStepError extends Error {
  constructor(readonly reason: string, readonly raw?: string) {
    super(reason)
  }
}

const BAD_FORMAT_REASON = '模型返回的内容不是要求的格式'

interface Extracted {
  main_name: string
  work: string
  aliases: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === 'number')
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function parseExtracted(raw: string): Extracted | undefined {
  const parsed = parseJsonSalvage(raw)
  if (!isRecord(parsed)) return undefined
  const { main_name, work, aliases } = parsed
  if (typeof main_name !== 'string' || main_name.trim() === '') return undefined
  if (typeof work !== 'string' || !isStringArray(aliases)) return undefined
  return { main_name, work, aliases }
}

function isCandidate(value: unknown): value is RoleConfigCandidate {
  if (!isRecord(value)) return false
  const { main_name, aliases, source_summary, relation, pages } = value
  return typeof main_name === 'string' && main_name.trim() !== ''
    && Array.isArray(aliases)
    && aliases.every(alias => isRecord(alias) && typeof alias.name === 'string' && isNumberArray(alias.pages))
    && typeof source_summary === 'string'
    && (typeof relation === 'string' || relation === null)
    && isNumberArray(pages)
}

function parseCandidates(raw: string): RoleConfigCandidate[] | undefined {
  const parsed = parseJsonSalvage(raw)
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) return undefined
  return parsed.candidates.every(isCandidate) ? parsed.candidates : undefined
}

async function runStep<T>(
  step: RoleConfigStep,
  signal: AbortSignal,
  onStep: (step: RoleConfigStep, state: RoleConfigStepState) => void,
  run: () => Promise<T>
): Promise<T | undefined> {
  onStep(step, 'start')
  try {
    const value = await run()
    onStep(step, 'done')
    return value
  } catch (err) {
    if (signal.aborted) throw err
    const reason = err instanceof RoleConfigStepError ? err.reason : messageOf(err)
    const raw = err instanceof RoleConfigStepError ? err.raw : undefined
    console.error(`[RoleConfig] ${step} 失败：${reason}${raw !== undefined ? `；模型原始回复：${raw}` : ''}`)
    onStep(step, 'failed')
    return undefined
  }
}

export async function lookupRoleConfig(
  preset: Preset,
  signal: AbortSignal,
  onStep: (step: RoleConfigStep, state: RoleConfigStepState) => void
): Promise<RoleConfigResult> {
  const extractResult = await runStep('extract', signal, onStep, async () => {
    const model = createModelProviderForPreset(preset, getModelProviderConfig(), getPresetApiKeys(preset.presetId))
    const raw = await model.completeSync(
      { system: '', messages: [{ role: 'user', content: buildExtractPrompt(preset.systemPrompt, preset.name) }] },
      { signal }
    )
    const parsed = parseExtracted(raw)
    if (!parsed) throw new RoleConfigStepError(BAD_FORMAT_REASON, raw)
    return { model, extracted: parsed }
  })
  if (!extractResult) return { kind: 'names', mainName: null, names: [], failed: true }

  const { model, extracted: { main_name: mainName, work, aliases } } = extractResult
  const personaNames = [mainName, ...aliases]
  const personaOnly: RoleConfigResult = { kind: 'names', mainName, names: personaNames, failed: true }

  const search = await runStep('search', signal, onStep, () => webSearch({
    query: [work, mainName, '别名', '外号'].filter(part => part.trim() !== '').join(' '),
    subscriptionPrompt: buildSearchPrompt(mainName, work),
    signal,
  }))
  if (!search) return personaOnly

  const candidates = await runStep('merge', signal, onStep, async () => {
    const raw = await model.completeSync(
      { system: '', messages: [{ role: 'user', content: buildMergePrompt(search, mainName, work, aliases) }] },
      { signal }
    )
    const parsed = parseCandidates(raw)
    if (!parsed) throw new RoleConfigStepError(BAD_FORMAT_REASON, raw)
    return parsed
  })
  if (!candidates) return personaOnly

  return candidates.length > 0
    ? { kind: 'candidates', candidates, personaMainName: mainName, personaNames }
    : { kind: 'names', mainName, names: personaNames, failed: false }
}
