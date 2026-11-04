// services/core/profile/userProfile.ts — 用户资料文档（所有角色共用的本地 Markdown）的所在地读写
// 用法：context/buildContext.ts 与 routes/userProfile.ts 调 getLocation；tools/rememberLocation.ts 调 setLocation；路径取自 USER_PROFILE_PATH（缺省 ./data/user-profile.md）
// 对应文件：services/core/context/buildContext.ts / services/core/routes/userProfile.ts / services/core/tools/rememberLocation.ts / services/core/profile/userProfile.test.ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as dotenv from 'dotenv'

dotenv.config({ quiet: true })

export const USER_PROFILE_PATH = path.resolve(process.cwd(), process.env.USER_PROFILE_PATH ?? './data/user-profile.md')

if (process.env.VITEST && !USER_PROFILE_PATH.startsWith(os.tmpdir() + path.sep)) {
  throw new Error(`[UserProfile] refusing USER_PROFILE_PATH "${USER_PROFILE_PATH}" under vitest; it must resolve inside ${os.tmpdir()}`)
}

export interface UserLocation {
  value: string
  userInput: string
  recordedAt: string
  nameZh: string | null
  latitude: number | null
  longitude: number | null
  timezone: string | null
  countryCode: string | null
  exactAddress: string | null
}

export interface LocationInput {
  value: string
  userInput: string
  nameZh?: string | null
  latitude?: number | null
  longitude?: number | null
  timezone?: string | null
  countryCode?: string | null
  exactAddress?: string | null
}

const FILE_HEADER = '# 用户资料'
const LOCATION_HEADING = '## 所在地'
const SECTION_START = /^#{1,2}\s/

function findLocationSection(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex(line => line.trimEnd() === LOCATION_HEADING)
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_START.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

function readField(sectionLines: string[], label: string): string | null {
  const prefix = `- ${label}：`
  const line = sectionLines.find(l => l.startsWith(prefix))
  const value = line?.slice(prefix.length).trim()
  return value ? value : null
}

function readCoordinates(value: string | null): { latitude: number; longitude: number } | null {
  if (value === null) return null
  const parts = value.split(',')
  if (parts.length !== 2 || parts.some(part => part.trim() === '')) return null
  const latitude = Number(parts[0])
  const longitude = Number(parts[1])
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null
}

function readProfileText(): string | null {
  try {
    return fs.readFileSync(USER_PROFILE_PATH, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.warn('[UserProfile] failed to read user profile:', err)
    return null
  }
}

export function getLocation(): UserLocation | null {
  const text = readProfileText()
  if (text === null) return null
  const lines = text.split('\n')
  const section = findLocationSection(lines)
  if (!section) return null
  const body = lines.slice(section.start + 1, section.end)
  const value = readField(body, '当前')
  const userInput = readField(body, '用户原话')
  const recordedAt = readField(body, '记下时间')
  if (!value || !userInput || !recordedAt) {
    console.warn('[UserProfile] location section is malformed, ignoring it')
    return null
  }
  const coordinates = readCoordinates(readField(body, '坐标'))
  return {
    value,
    userInput,
    recordedAt,
    nameZh: readField(body, '中文名'),
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    timezone: readField(body, '时区'),
    countryCode: readField(body, '国家代码'),
    exactAddress: readField(body, '精确地址'),
  }
}

function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

function localIsoWithOffset(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function setLocation(input: LocationInput): void {
  const sectionLines = [LOCATION_HEADING, `- 当前：${singleLine(input.value)}`]
  if (input.nameZh) sectionLines.push(`- 中文名：${singleLine(input.nameZh)}`)
  if (typeof input.latitude === 'number' && typeof input.longitude === 'number') {
    sectionLines.push(`- 坐标：${input.latitude}, ${input.longitude}`)
  }
  if (input.timezone) sectionLines.push(`- 时区：${singleLine(input.timezone)}`)
  if (input.countryCode) sectionLines.push(`- 国家代码：${singleLine(input.countryCode)}`)
  if (input.exactAddress) sectionLines.push(`- 精确地址：${singleLine(input.exactAddress)}`)
  sectionLines.push(`- 用户原话：${singleLine(input.userInput)}`, `- 记下时间：${localIsoWithOffset(new Date())}`)

  const existing = readProfileText()
  let next: string
  if (existing === null || existing.trim() === '') {
    next = `${FILE_HEADER}\n\n${sectionLines.join('\n')}\n`
  } else {
    const lines = existing.split('\n')
    const section = findLocationSection(lines)
    if (section) {
      const hasFollowing = section.end < lines.length
      const replacement = hasFollowing ? [...sectionLines, ''] : sectionLines
      next = [...lines.slice(0, section.start), ...replacement, ...lines.slice(section.end)].join('\n')
      if (!hasFollowing && !next.endsWith('\n')) next += '\n'
    } else {
      const base = existing.endsWith('\n') ? existing : `${existing}\n`
      next = `${base}\n${sectionLines.join('\n')}\n`
    }
  }

  fs.mkdirSync(path.dirname(USER_PROFILE_PATH), { recursive: true })
  const tempPath = `${USER_PROFILE_PATH}.tmp`
  try {
    fs.writeFileSync(tempPath, next, 'utf8')
    fs.renameSync(tempPath, USER_PROFILE_PATH)
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
    }
    throw err
  }
}
