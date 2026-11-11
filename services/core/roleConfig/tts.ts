// services/core/roleConfig/tts.ts — 用 Windows 自带 TTS（System.Speech）把称呼朗读稿合成 16 kHz 单声道 wav，并判断称呼的语言
// 用法：roleConfig/collect.ts 调 detectLanguage(name)、withTtsDir(fn)、synthesizeJobs(dir, jobs, signal)
// 对应文件：services/core/roleConfig/collect.ts
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export type NameLanguage = 'zh' | 'ja' | 'en'

export interface TtsJob {
  text: string
  language: NameLanguage
}

export interface TtsClip {
  jobIndex: number
  wavPath: string
}

interface InstalledVoice {
  name: string
  culture: string
}

const POWERSHELL_TIMEOUT_MS = 3 * 60 * 1000
const LEADING_SILENCE_MS = 800
const TRAILING_SILENCE_MS = 1500

const LIST_VOICES_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$lines = @()
foreach ($voice in $synth.GetInstalledVoices()) {
  if ($voice.Enabled) { $lines += ($voice.VoiceInfo.Name + [char]9 + $voice.VoiceInfo.Culture.Name) }
}
[System.IO.File]::WriteAllLines($env:MINTBOT_TTS_OUTPUT, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
`

const SYNTHESIZE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$data = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:MINTBOT_TTS_INPUT | ConvertFrom-Json
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo -ArgumentList 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
foreach ($item in $data.items) {
  $synth.SelectVoice($item.voice)
  $synth.SetOutputToWaveFile($item.out, $format)
  $builder = New-Object System.Speech.Synthesis.PromptBuilder -ArgumentList $synth.Voice.Culture
  $builder.AppendBreak([TimeSpan]::FromMilliseconds(${LEADING_SILENCE_MS}))
  $builder.AppendText($item.text)
  $builder.AppendBreak([TimeSpan]::FromMilliseconds(${TRAILING_SILENCE_MS}))
  $synth.Speak($builder)
  $synth.SetOutputToNull()
}
`

export function detectLanguage(name: string): NameLanguage | null {
  if (/[぀-ヿ]/.test(name)) return 'ja'
  if (/[㐀-䶿一-鿿]/.test(name)) return 'zh'
  if (/^[A-Za-z '.-]+$/.test(name) && /[A-Za-z]/.test(name)) return 'en'
  return null
}

export async function withTtsDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mintbot-role-config-'))
  try {
    return await run(dir)
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

function runPowerShell(script: string, env: Record<string, string>, signal: AbortSignal): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { env: { ...process.env, ...env }, windowsHide: true, signal, timeout: POWERSHELL_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (!err) return resolve()
        if (signal.aborted) return reject(err)
        const detail = String(stderr).trim()
        reject(new Error(`powershell.exe 执行失败：${detail !== '' ? detail : err.message}`))
      }
    )
  })
}

async function listVoices(dir: string, signal: AbortSignal): Promise<InstalledVoice[]> {
  const output = path.join(dir, 'voices.txt')
  await runPowerShell(LIST_VOICES_SCRIPT, { MINTBOT_TTS_OUTPUT: output }, signal)
  const text = await fs.promises.readFile(output, 'utf-8')
  return text
    .split(/\r?\n/)
    .filter(line => line.includes('\t'))
    .map(line => {
      const [name, culture] = line.split('\t')
      return { name, culture }
    })
}

function voicesFor(voices: InstalledVoice[], language: NameLanguage): InstalledVoice[] {
  const matching = voices.filter(voice => voice.culture.toLowerCase().startsWith(language))
  return language === 'en' ? matching : matching.slice(0, 1)
}

export async function synthesizeJobs(dir: string, jobs: TtsJob[], signal: AbortSignal): Promise<TtsClip[]> {
  if (jobs.length === 0) return []
  const voices = await listVoices(dir, signal)
  const clips: TtsClip[] = []
  const items: { voice: string; text: string; out: string }[] = []
  jobs.forEach((job, jobIndex) => {
    for (const voice of voicesFor(voices, job.language)) {
      const wavPath = path.join(dir, `${clips.length}.wav`)
      clips.push({ jobIndex, wavPath })
      items.push({ voice: voice.name, text: job.text, out: wavPath })
    }
  })
  if (items.length === 0) return []
  const input = path.join(dir, 'input.json')
  await fs.promises.writeFile(input, JSON.stringify({ items }), 'utf-8')
  await runPowerShell(SYNTHESIZE_SCRIPT, { MINTBOT_TTS_INPUT: input }, signal)
  return clips
}
