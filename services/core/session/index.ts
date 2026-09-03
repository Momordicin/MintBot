import { randomUUID } from 'crypto'
import type { Session, Preset, Message, PresetSnapshot } from '../../../shared/types/index.js'
import { loadCharacterManifest, type CharacterManifest } from '../characters/manifest.js'
import {
  getPresetById,
  getLatestSessionByPreset,
  createSession,
  touchSession,
  getRecentMessages,
  appendMessage,
} from './queries.js'

interface SessionState {
  session: Session
  preset: Preset
  manifest: CharacterManifest | null
}

let current: SessionState | null = null

// ─── 加载或新建 session ────────────────────────────────────

export function loadSession(presetId: string): SessionState {
  const preset = getPresetById(presetId)
  if (!preset) throw new Error(`[Session] Preset not found: ${presetId}`)

  // 兑现原 TODO Phase 3「加载 preset 后需验证 characterId 对应的角色包是否存在」：
  // manifest 在这里读一次并常驻内存（TDD §3.7「加载与缓存」），不在每轮对话时读盘。
  // 角色包缺失/manifest.json 解析失败时 loadCharacterManifest 返回 null——这不阻塞
  // session 加载，buildContext.ts 按空词表降级处理（TDD §3.9「情绪标签词表的归属」）
  const manifest = loadCharacterManifest(preset.characterId)

  let session = getLatestSessionByPreset(presetId)

  if (!session) {
    const snapshot: PresetSnapshot = {
      presetId: preset.presetId,
      name: preset.name,
      characterId: preset.characterId, 
      modelType: preset.modelType,
      modelName: preset.modelName,
      wallpaperPath: preset.wallpaperPath,
      displayConfig: preset.displayConfig,
      systemPrompt: preset.systemPrompt,
    }
    session = {
      sessionId: randomUUID(),
      presetId: preset.presetId,
      presetSnapshot: snapshot,
      title: undefined,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    createSession(session)
    console.log(`[Session] Created new session ${session.sessionId} for preset ${presetId}`)
  } else {
    console.log(`[Session] Resumed session ${session.sessionId} for preset ${presetId}`)
  }

  current = { session, preset, manifest }
  return current
}

// ─── 切换角色 ──────────────────────────────────────────────

export function switchPreset(presetId: string): SessionState {
  console.log(`[Session] Switching to preset ${presetId}`)
  current = null
  const state = loadSession(presetId)
  return state
}

// 设置页编辑 systemPrompt 后"立即生效"用：只替换内存缓存的 preset 对象本身，不碰 session
// （这是与 switchPreset 真正的区别所在——switchPreset 会通过 loadSession 换一个新的
// session）。编辑的 preset 若当前不是激活状态则是 no-op，等它真正被切换到时自然读到新值。
// 竞态安全：buildContext.ts 的 requireCurrentState() 是同步执行、之前没有 await，
// 在途 /chat 请求早已把 preset 复制进局部变量，这里换掉 current.preset 不影响它
// （与 chat.ts 里 sessionId "dispatch 时刻捕获" 同一安全模式）。
// 不重新读取 manifest：这里能触发刷新的字段（systemPrompt/modelType/modelName 等，见
// routes/presets.ts 的 PATCH /presets/:presetId）都不会改变 characterId，缓存的 manifest
// 因此始终仍然有效——重新读盘不会得到不同结果，只是白白多一次文件 I/O。
export function refreshCurrentPresetIfActive(presetId: string): void {
  if (current?.session.presetId !== presetId) return
  const preset = getPresetById(presetId)
  if (!preset) return
  current = { ...current, preset }
}

// ─── 读取当前状态 ──────────────────────────────────────────

export function getCurrentState(): SessionState | null {
  return current
}

export function requireCurrentState(): SessionState {
  if (!current) throw new Error('[Session] No active session')
  return current
}

// ─── 消息操作 ──────────────────────────────────────────────

export function getHistory(limit = 50): Message[] {
  const { session } = requireCurrentState()
  return getRecentMessages(session.sessionId, limit)
}

// sessionId 必须由调用方显式传入（请求开始时捕获的 session），不回退读全局"当前 session"。
// 原因：调用方（如 chat.ts）可能在 await 模型回复期间被 preset 切换请求打断，
// 若在此处重新读取全局状态，消息会被错误地记到切换后的新 session 上。
export function addMessage(
  sessionId: string,
  role: Message['role'],
  content: string,
  trigger: Message['trigger'] = 'user'
): number {
  const id = appendMessage({
    sessionId,
    role,
    content,
    createdAt: Date.now(),
    embedded: false,
    summarized: false,
    visibleToUser: true,
    trigger,
    triggerEventId: null,
  })
  touchSession(sessionId)
  return id
}