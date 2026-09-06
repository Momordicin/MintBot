// 设置窗口主题控件（CharacterPanel.tsx）用到的纯函数，从组件里抽出来单测——本仓库没有
// 渲染层测试基础设施，但这些函数本身不依赖 DOM/React，可以直接用现有的 vitest 覆盖。
//
// hex ↔ RGB 元组：与 accentRgb（原生 <input type="color"> 只认 hex 格式）互转，
// 沿用 CharacterPanel.tsx 里原有的 chatBgRgb 颜色选择器同一套转换规则。
export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`
}

export function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  // parseInt 对非法输入返回 NaN，而 JSON.stringify(NaN) 是 null——PATCH body 里会静默
  // 变成 accentRgb: [null, null, null]，服务端 400 拒掉，用户只看到「保存没生效」。
  // 现在唯一的调用方是原生 <input type="color">，它保证吐出合法的 #rrggbb，所以这条
  // 兜底在当前接线下不可达；留着是为了让函数本身是全函数，而不是靠调用方的约定才正确
  return [r, g, b].map(n => (Number.isFinite(n) ? n : 0)) as [number, number, number]
}

// tint 滑块给用户看的是 0-100 的整数百分比，Presets.displayConfig.tintStrength 存的是
// 0..1（见 shared/types/index.ts、src/chat/theme.ts ThemeInput.tintStrength）。两个方向
// 都夹到合法范围内，避免滑块的边界值或浮点误差产生越界的 PATCH body。
// 注意 Math.min/Math.max 夹不住 NaN——Math.min(1, Math.max(0, NaN)) 仍然是 NaN，
// 所以非有限值必须单独挡掉，理由同 hexToRgb 的注释
export function percentToTintStrength(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(1, Math.max(0, percent / 100))
}

export function tintStrengthToPercent(tintStrength: number): number {
  if (!Number.isFinite(tintStrength)) return 0
  return Math.round(Math.min(1, Math.max(0, tintStrength)) * 100)
}
