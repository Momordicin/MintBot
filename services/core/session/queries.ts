import { db } from '../db/index.js'
import { encrypt, decrypt } from '../db/crypto.js'
import type { Message, Session, Preset, PresetSnapshot } from '../../../shared/types/index.js'

// ─── Preset ───────────────────────────────────────────────

export function getPresetById(presetId: string): Preset | null {
  const row = db.prepare(`SELECT * FROM Presets WHERE presetId = ?`).get(presetId) as any
  if (!row) return null
  return {
    ...row,
    wallpaperPath: row.wallpaperPath ?? undefined,
    systemPrompt: decrypt(row.systemPrompt),
  }
}

export function getAllPresets(): Preset[] {
  const rows = db.prepare(`SELECT * FROM Presets ORDER BY updatedAt DESC`).all() as any[]
  return rows.map(row => ({ ...row, wallpaperPath: row.wallpaperPath ?? undefined, systemPrompt: decrypt(row.systemPrompt) }))
}

export function upsertPreset(preset: Omit<Preset, 'createdAt' | 'updatedAt'>): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO Presets (presetId, name, characterId, modelType, modelName, wallpaperPath, systemPrompt, createdAt, updatedAt)
    VALUES (@presetId, @name, @characterId, @modelType, @modelName, @wallpaperPath, @systemPrompt, @createdAt, @updatedAt)
    ON CONFLICT(presetId) DO UPDATE SET
      name = excluded.name,
      characterId = excluded.characterId,
      modelType = excluded.modelType,
      modelName = excluded.modelName,
      wallpaperPath = excluded.wallpaperPath,
      systemPrompt = excluded.systemPrompt,
      updatedAt = excluded.updatedAt
  `).run({
    ...preset,
    wallpaperPath: preset.wallpaperPath ?? null,
    systemPrompt: encrypt(preset.systemPrompt),
    createdAt: now,
    updatedAt: now,
  })
}

// ─── Session ──────────────────────────────────────────────

export function getLatestSessionByPreset(presetId: string): Session | null {
  const row = db.prepare(`
    SELECT * FROM Sessions WHERE presetId = ? ORDER BY lastActiveAt DESC LIMIT 1
  `).get(presetId) as any
  if (!row) return null
  return {
    ...row,
    presetSnapshot: JSON.parse(row.presetSnapshot) as PresetSnapshot,
    title: row.title ?? undefined,
  }
}

export function createSession(session: Session): void {
  db.prepare(`
    INSERT INTO Sessions (sessionId, presetId, presetSnapshot, title, createdAt, lastActiveAt)
    VALUES (@sessionId, @presetId, @presetSnapshot, @title, @createdAt, @lastActiveAt)
  `).run({
    ...session,
    presetSnapshot: JSON.stringify(session.presetSnapshot),
    title: session.title ?? null,
  })
}

export function touchSession(sessionId: string): void {
  db.prepare(`UPDATE Sessions SET lastActiveAt = ? WHERE sessionId = ?`)
    .run(Date.now(), sessionId)
}

// ─── Messages ─────────────────────────────────────────────

export function getRecentMessages(sessionId: string, limit = 50): Message[] {
  const rows = db.prepare(`
    SELECT * FROM Messages
    WHERE sessionId = ? AND visibleToUser = 1
    ORDER BY createdAt DESC
    LIMIT ?
  `).all(sessionId, limit) as any[]

  return rows
    .reverse()  // 返回正序
    .map(row => ({
      ...row,
      content: decrypt(row.content),
      embedded: row.embedded === 1,
      summarized: row.summarized === 1,
      visibleToUser: row.visibleToUser === 1,
    }))
}

export function appendMessage(msg: Omit<Message, 'id'>): number {
  const result = db.prepare(`
    INSERT INTO Messages
      (sessionId, role, content, createdAt, embedded, summarized, visibleToUser, trigger, triggerEventId)
    VALUES
      (@sessionId, @role, @content, @createdAt, @embedded, @summarized, @visibleToUser, @trigger, @triggerEventId)
  `).run({
    ...msg,
    content: encrypt(msg.content),
    embedded: msg.embedded ? 1 : 0,
    summarized: msg.summarized ? 1 : 0,
    visibleToUser: msg.visibleToUser ? 1 : 0,
  })
  return result.lastInsertRowid as number
}