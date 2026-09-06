import type { PresetDisplayConfig } from '../../../shared/types/index.js'

// Presets.displayConfig 的默认值与读时合并解析，见 docs/MintBot_TDD.md §3.2.2
// 「Presets.displayConfig（每角色显示设置）」。chatBgRgb/chatBgOpacity 的默认值必须与
// src/styles/global.css 的 --chat-bg-rgb / --chat-bg-opacity 硬编码值完全一致，保证没
// 自定义过的角色显示效果不变。
// accentRgb 曾经默认 carry over 自 chatBgRgb 的默认值（"单个字段缺失全部键时二者本来就
// 该指向同一个源色"），但这个理由本身站不住：chatBgRgb 是按*背景色*模型选出来的值
// （[15, 15, 20]，接近消色差的深蓝灰），background 对 accent 而言没有意义。
//
// ⚠️ 当初记在这里的实测理由是「它的 a/b 分量接近零，tintStrength 从 0 扫到 1 各表面
// 只移动 1 个通道 1 个单位」——那是**旧染色模型**（只推 a/b、锁死 L）下的观测。染色后来
// 改成了 oklab 三分量混合（见 src/chat/theme.ts），在新模型下这句话只对**夜间**成立：
// 夜间背景 L≈0，深色无彩 accent 与它距离本来就近，确实几乎不动；而**日间**背景 L=1，
// 同一个 accent 会把它拉出明显位移。也就是说「滑杆看起来没反应」这个具体症状已经不再
// 是丢弃 carry over 的充分理由。
//
// 决定本身不变，理由改成更根本的那条：chatBgRgb 是按背景色模型选出来的值，把一个背景色
// 当强调色用是范畴错误——它会同时决定 outgoing 气泡的底色，而 [15,15,20] 作为气泡是一块
// 近黑。改成参考实现的 systemBlue
// #007AFF（本文件其它地方、theme.ts 注释与测试里已经在用的参照点），有足够彩度让 tint
// 滑杆产生肉眼可见的效果，同时不再是一个"看起来正常但其实是背景色"的错误默认值
export const DEFAULT_DISPLAY_CONFIG: PresetDisplayConfig = {
  chatBgRgb: [15, 15, 20],
  chatBgOpacity: 0.65,
  themeMode: 'auto',
  accentRgb: [0, 122, 255],
  tintStrength: 0,
}

// 导出给 routes/presets.ts 的 PATCH 路由做入参严格校验复用——两边共享同一份"什么值算合法"
// 的判断，避免各自维护一份、以后改校验范围时漏改一处
export function isValidChatBgRgb(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(channel => typeof channel === 'number' && Number.isInteger(channel) && channel >= 0 && channel <= 255)
  )
}

export function isValidChatBgOpacity(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1
}

// accentRgb 与 chatBgRgb 同为 3 个 0-255 整数的 RGB 元组，复用同一条校验逻辑，不重复实现
export function isValidAccentRgb(value: unknown): value is [number, number, number] {
  return isValidChatBgRgb(value)
}

export function isValidThemeMode(value: unknown): value is 'day' | 'night' | 'auto' {
  return value === 'day' || value === 'night' || value === 'auto'
}

// tintStrength 的“合法”只要求是有限数字——是否落在 [0, 1] 内由 clampTintStrength 处理，
// 不在这里拒绝：滑杆传来的越界值（比如浮点误差导致的 1.0000000001）应该被夹回范围内，
// 而不是当成一次 400/回退默认值的错误上报
export function isValidTintStrength(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function clampTintStrength(value: number): number {
  return Math.min(1, Math.max(0, value))
}

// 按字段合并策略，与 config/index.ts 的 mergeNumberField/mergeMemoryConfig 一致：一个字段
// 缺失/类型错误/超出范围只回退该字段自己的默认值并告警，不连累其它已经写对的字段
function mergeDisplayConfig(source: unknown): PresetDisplayConfig {
  const record = source as Record<string, unknown> | undefined
  const chatBgRgb = record?.chatBgRgb
  const chatBgOpacity = record?.chatBgOpacity
  const themeMode = record?.themeMode
  const accentRgb = record?.accentRgb
  const tintStrength = record?.tintStrength

  if (!isValidChatBgRgb(chatBgRgb)) {
    console.warn(`[DisplayConfig] chatBgRgb 缺失或类型错误，使用默认值 ${JSON.stringify(DEFAULT_DISPLAY_CONFIG.chatBgRgb)}`)
  }
  if (!isValidChatBgOpacity(chatBgOpacity)) {
    console.warn(`[DisplayConfig] chatBgOpacity 缺失或类型错误，使用默认值 ${DEFAULT_DISPLAY_CONFIG.chatBgOpacity}`)
  }

  const resolvedChatBgRgb = isValidChatBgRgb(chatBgRgb) ? chatBgRgb : DEFAULT_DISPLAY_CONFIG.chatBgRgb

  // themeMode/accentRgb/tintStrength 是本次新增字段，事后加进已经存在、非空的旧 blob 里：
  // 对几乎所有已存 preset 来说，这三个键"缺失"是必然会命中的常态（schema 演进），不是
  // 需要告警的异常，因此缺失时静默回退，只有键存在但类型/取值非法（真正的脏数据）才告警——
  // 这与 chatBgRgb/chatBgOpacity"缺失也告警"不同：那两个字段随 v7 迁移新增列一起诞生，
  // 迁移前的旧行走的是 parseDisplayConfig 的 raw === null 分支（同样不告警），到这里
  // individual-field 缺失分支的只会是解析出来的对象确实漏了字段的脏数据
  if (themeMode !== undefined && !isValidThemeMode(themeMode)) {
    console.warn(`[DisplayConfig] themeMode 类型错误，使用默认值 ${DEFAULT_DISPLAY_CONFIG.themeMode}`)
  }
  if (accentRgb !== undefined && !isValidAccentRgb(accentRgb)) {
    console.warn(`[DisplayConfig] accentRgb 类型错误，使用默认值 ${JSON.stringify(DEFAULT_DISPLAY_CONFIG.accentRgb)}`)
  }
  if (tintStrength !== undefined && !isValidTintStrength(tintStrength)) {
    console.warn(`[DisplayConfig] tintStrength 类型错误，使用默认值 ${DEFAULT_DISPLAY_CONFIG.tintStrength}`)
  }

  return {
    chatBgRgb: resolvedChatBgRgb,
    chatBgOpacity: isValidChatBgOpacity(chatBgOpacity) ? chatBgOpacity : DEFAULT_DISPLAY_CONFIG.chatBgOpacity,
    themeMode: isValidThemeMode(themeMode) ? themeMode : DEFAULT_DISPLAY_CONFIG.themeMode,
    // 缺失或非法时回退到固定默认色 DEFAULT_DISPLAY_CONFIG.accentRgb，不再沿用刚解析好的
    // chatBgRgb——那是按背景色模型选的值，carry over 成 accent 对 tint 规则而言等于没有
    // 彩度可染，见本文件顶部 DEFAULT_DISPLAY_CONFIG 的注释
    accentRgb: isValidAccentRgb(accentRgb) ? accentRgb : DEFAULT_DISPLAY_CONFIG.accentRgb,
    tintStrength: isValidTintStrength(tintStrength) ? clampTintStrength(tintStrength) : DEFAULT_DISPLAY_CONFIG.tintStrength,
  }
}

// raw 为 null（列迁移前的旧行，或从未写过的行）等价于空对象，直接取全部默认值且不告警——
// 这是正常情况不是错误；JSON 解析失败取全部默认值并告警，逐字段校验交给 mergeDisplayConfig
export function parseDisplayConfig(raw: string | null): PresetDisplayConfig {
  if (raw === null) return { ...DEFAULT_DISPLAY_CONFIG }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn('[DisplayConfig] displayConfig JSON 解析失败，使用默认值:', err)
    return { ...DEFAULT_DISPLAY_CONFIG }
  }

  return mergeDisplayConfig(parsed)
}
