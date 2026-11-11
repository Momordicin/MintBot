// services/core/roleConfig/hotwords.ts — 语音错写表（hotwords.txt）的生成、按角色编号覆盖一段、判断某角色是否配置完整，以及读写这个文件
// 用法：roleConfig/collect.ts 调 saveHotwordsSection(presetName, presetId, entries)；routes/roleConfig.ts 调 readHotwords() 与 isComplete(text, presetId, names)
// 对应文件：services/core/roleConfig/collect.ts / services/core/routes/roleConfig.ts / services/core/voice/agent.ts / services/core/roleConfig/hotwords.test.ts
import fs from 'fs'
import { hotwordsPath } from '../voice/agent.js'

export interface HotwordEntry {
  name: string
  misspellings: string[]
}

function cleanMisspellings(name: string, misspellings: string[]): string[] {
  const seen = new Set<string>()
  const lowerName = name.toLowerCase()
  for (const raw of misspellings) {
    const item = raw.trim()
    if (item === '' || item.toLowerCase() === lowerName) continue
    if (item.includes('|') || item.includes('~~~') || /[\r\n]/.test(item) || item.startsWith('#')) continue
    seen.add(item)
  }
  return [...seen]
}

export function buildSection(presetName: string, date: string, presetId: string, entries: HotwordEntry[]): string {
  const header = `# ${presetName.replace(/\s+/g, ' ').trim()} ${date} ${presetId}`
  const lines = entries.map(entry => [entry.name, ...cleanMisspellings(entry.name, entry.misspellings)].join(' | '))
  return [header, ...lines].join('\n')
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function findSection(lines: string[], presetId: string): { start: number; end: number } | null {
  const start = lines.findIndex(line => {
    if (!line.startsWith('#')) return false
    const parts = line.trim().split(/\s+/)
    return parts[parts.length - 1] === presetId
  })
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !lines[end].trimStart().startsWith('#')) end++
  return { start, end }
}

export function upsertSection(fileText: string, presetId: string, section: string): string {
  const lines = splitLines(fileText)
  const found = findSection(lines, presetId)
  const sectionLines = section.split('\n')
  if (found) lines.splice(found.start, found.end - found.start, ...sectionLines)
  else lines.push(...sectionLines)
  return lines.join('\n') + '\n'
}

export function isComplete(fileText: string, presetId: string, names: string[]): boolean {
  const lines = splitLines(fileText)
  const found = findSection(lines, presetId)
  if (!found) return false
  const present = new Set(lines.slice(found.start + 1, found.end).map(line => line.split('|')[0].trim()))
  return names.every(name => present.has(name))
}

function localDate(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export async function readHotwords(): Promise<string> {
  try {
    return await fs.promises.readFile(hotwordsPath(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

export async function saveHotwordsSection(presetName: string, presetId: string, entries: HotwordEntry[]): Promise<void> {
  const target = hotwordsPath()
  const next = upsertSection(await readHotwords(), presetId, buildSection(presetName, localDate(), presetId, entries))
  const temp = `${target}.tmp`
  await fs.promises.writeFile(temp, next, 'utf-8')
  await fs.promises.rename(temp, target)
}
