// services/core/roleConfig/collect.ts — 一键生成角色配置的错写收集：检查并安装语音插件、合成朗读并识别、让模型找错写、写入错写表并重启语音插件
// 用法：routes/roleConfig.ts 调 synthesizeRoleConfig(presetId, signal, onStep) 与 finishRoleConfig(preset, samples, signal, onStep)
// 对应文件：services/core/routes/roleConfig.ts / services/core/roleConfig/tts.ts / services/core/roleConfig/recognize.ts / services/core/roleConfig/hotwords.ts / services/core/roleConfig/confirm.ts / services/core/roleConfig/prompts.ts / services/core/voice/agent.ts
import fs from 'fs'
import type { Preset } from '../../../shared/types/index.js'
import { getModelProviderConfig } from '../config/index.js'
import { createModelProviderForPreset } from '../providers/ModelProvider.js'
import { getPresetApiKeys } from '../session/queries.js'
import { parseJsonSalvage } from '../util/jsonSalvage.js'
import { getVoiceStatus, isNewerVersion, reloadHotwords, startInstall, waitForInstall } from '../voice/agent.js'
import { MIN_VOICE_VERSION } from '../voice/install.js'
import { readNamesDraft } from './confirm.js'
import { saveHotwordsSection } from './hotwords.js'
import { buildMisspellingPrompt, type MisspellingGroup } from './prompts.js'
import { recognizeWav } from './recognize.js'
import { detectLanguage, synthesizeJobs, withTtsDir, type NameLanguage, type TtsJob } from './tts.js'

export type CollectStep = 'check' | 'install' | 'synthesize' | 'analyze' | 'write'

export type CollectStepState = 'start' | 'done' | 'failed'

export interface RoleConfigSample {
  name: string
  script: string
  transcript: string
}

export interface SynthesizeResult {
  samples: RoleConfigSample[]
  readings: { name: string; script: string }[]
}

export interface FinishResult {
  complete: true
}

export class RoleConfigStepFailed extends Error {}


const BAD_FORMAT_REASON = '模型返回的内容不是要求的格式'

const NAME_PLACEHOLDER = '{称呼}'

type ScriptPair = [string, string]

const READING_SCRIPTS: Record<NameLanguage, { head: ScriptPair; middle: ScriptPair; tail: ScriptPair }> = {
  zh: {
    head: ['{称呼}，今天陪我聊一会儿天好不好？', '{称呼}，你今天过得怎么样，有没有遇到什么开心的事？'],
    middle: ['我刚才还跟朋友说起，{称呼}上次推荐给我的那首歌，我已经循环听了好几遍了。', '昨天晚上我做了个梦，梦见{称呼}带着我去海边看了一整晚的星星。'],
    tail: ['晚安啦，{称呼}。', '明天见，{称呼}。'],
  },
  ja: {
    head: ['{称呼}、今日はちょっとおしゃべりに付き合ってくれない？', '{称呼}、今日はどんな一日だった？何か楽しいことあった？'],
    middle: ['さっき友達に話してたんだけど、{称呼}が前におすすめしてくれたあの曲、もう何回も繰り返し聴いてるんだ。', '昨日の夜、{称呼}と一緒に海辺で一晩中星を眺める夢を見たんだ。'],
    tail: ['おやすみ、{称呼}。', 'また明日ね、{称呼}。'],
  },
  en: {
    head: ['{称呼}, could you keep me company and chat for a while?', '{称呼}, how was your day, did anything fun happen?'],
    middle: ['I was just telling my friend that the song {称呼} recommended last time has been on repeat all week.', 'Last night I dreamed that {称呼} took me to the beach to watch the stars all night.'],
    tail: ['Good night, {称呼}.', 'See you tomorrow, {称呼}.'],
  },
}

function pickIndex(): 0 | 1 {
  return Math.random() < 0.5 ? 0 : 1
}

function fillScript(template: string, name: string): string {
  return template.split(NAME_PLACEHOLDER).join(name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

class BadFormatError extends Error {
  constructor(readonly raw: string) {
    super(BAD_FORMAT_REASON)
  }
}

async function runStep<T>(
  step: CollectStep,
  signal: AbortSignal,
  onStep: (step: CollectStep, state: CollectStepState, update?: boolean) => void,
  run: () => Promise<T>,
  update?: boolean
): Promise<T> {
  onStep(step, 'start', update)
  try {
    const value = await run()
    onStep(step, 'done', update)
    return value
  } catch (err) {
    if (signal.aborted) throw err
    const reason = messageOf(err)
    const raw = err instanceof BadFormatError ? err.raw : undefined
    console.error(`[RoleConfig] ${step} 失败：${reason}${raw !== undefined ? `；模型原始回复：${raw}` : ''}`)
    onStep(step, 'failed', update)
    throw new RoleConfigStepFailed(reason)
  }
}

async function requireNamesDraft(presetId: string): Promise<string[]> {
  const names = await readNamesDraft(presetId)
  if (!names) throw new Error('称呼草稿不存在')
  return names
}

async function ensureVoiceInstalled(
  signal: AbortSignal,
  onStep: (step: CollectStep, state: CollectStepState, update?: boolean) => void
): Promise<void> {
  onStep('check', 'start')
  let installed: boolean
  let outdated: boolean
  try {
    const status = await getVoiceStatus()
    installed = status.installed
    outdated = installed && (status.version === null || isNewerVersion(MIN_VOICE_VERSION, status.version))
  } catch (err) {
    if (signal.aborted) throw err
    const reason = messageOf(err)
    console.error(`[RoleConfig] check 失败：${reason}`)
    onStep('check', 'failed')
    throw new RoleConfigStepFailed(reason)
  }
  if (installed && !outdated) {
    onStep('check', 'done')
    return
  }
  const verb = installed ? '更新' : '安装'
  await runStep('install', signal, onStep, async () => {
    if ((await getVoiceStatus()).install.state !== 'installing') startInstall()
    await waitForInstall()
    const status = await getVoiceStatus()
    if (!status.installed || status.install.state === 'failed') {
      throw new Error(`语音插件${verb}失败${status.install.errorCode ? `：${status.install.errorCode}` : ''}`)
    }
    if (installed && (!status.version || isNewerVersion(MIN_VOICE_VERSION, status.version))) {
      throw new Error(`语音插件更新失败：版本仍为 ${status.version || '未知'}`)
    }
  }, installed)
}

export async function synthesizeRoleConfig(
  presetId: string,
  signal: AbortSignal,
  onStep: (step: CollectStep, state: CollectStepState, update?: boolean) => void
): Promise<SynthesizeResult> {
  const names = await requireNamesDraft(presetId)
  await ensureVoiceInstalled(signal, onStep)
  signal.throwIfAborted()

  const usedIndex = new Map<string, { head: 0 | 1; middle: 0 | 1 }>()
  const samples = await runStep('synthesize', signal, onStep, () => withTtsDir(async dir => {
    const jobs: (TtsJob & { name: string })[] = []
    for (const name of names) {
      const language = detectLanguage(name)
      if (!language) continue
      const { head, middle, tail } = READING_SCRIPTS[language]
      const headIndex = pickIndex()
      const middleIndex = pickIndex()
      usedIndex.set(name, { head: headIndex, middle: middleIndex })
      for (const template of [head[headIndex], middle[middleIndex], tail[pickIndex()]]) jobs.push({ name, language, text: fillScript(template, name) })
    }
    const found: RoleConfigSample[] = []
    for (const clip of await synthesizeJobs(dir, jobs, signal)) {
      const job = jobs[clip.jobIndex]
      const transcript = await recognizeWav(clip.wavPath, signal)
      await fs.promises.rm(clip.wavPath, { force: true })
      if (transcript !== null) found.push({ name: job.name, script: job.text, transcript })
    }
    return found
  }))

  const readings = names.map(name => {
    const language = detectLanguage(name) ?? 'zh'
    const { head, middle } = READING_SCRIPTS[language]
    const used = usedIndex.get(name)
    const script = language === 'en' ? head[used ? 1 - used.head : pickIndex()] : middle[used ? 1 - used.middle : pickIndex()]
    return { name, script: fillScript(script, name) }
  })
  return { samples, readings }
}

function parseMisspellings(raw: string): Map<string, string[]> {
  const parsed = parseJsonSalvage(raw)
  if (!isRecord(parsed) || !Array.isArray(parsed.names)) throw new BadFormatError(raw)
  const found = new Map<string, string[]>()
  for (const item of parsed.names) {
    if (!isRecord(item) || typeof item.name !== 'string') throw new BadFormatError(raw)
    const { misspellings } = item
    if (!Array.isArray(misspellings) || !misspellings.every(entry => typeof entry === 'string')) throw new BadFormatError(raw)
    found.set(item.name, [...(found.get(item.name) ?? []), ...(misspellings as string[])])
  }
  return found
}

export async function finishRoleConfig(
  preset: Preset,
  samples: RoleConfigSample[],
  signal: AbortSignal,
  onStep: (step: CollectStep, state: CollectStepState) => void
): Promise<FinishResult> {
  const names = await requireNamesDraft(preset.presetId)

  const found = await runStep('analyze', signal, onStep, async () => {
    const groups: MisspellingGroup[] = names
      .map(name => ({ name, samples: samples.filter(sample => sample.name === name) }))
      .filter(group => group.samples.length > 0)
    if (groups.length === 0) return new Map<string, string[]>()
    const model = createModelProviderForPreset(preset, getModelProviderConfig(), getPresetApiKeys(preset.presetId))
    const raw = await model.completeSync(
      { system: '', messages: [{ role: 'user', content: buildMisspellingPrompt(groups) }] },
      { signal }
    )
    return parseMisspellings(raw)
  })

  signal.throwIfAborted()
  await runStep('write', signal, onStep, async () => {
    const entries = names.map(name => ({ name, misspellings: found.get(name) ?? [] }))
    await saveHotwordsSection(preset.name, preset.presetId, entries)
    await reloadHotwords()
  })
  return { complete: true }
}
