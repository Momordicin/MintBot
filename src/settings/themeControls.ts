export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`
}

export function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return [r, g, b].map(n => (Number.isFinite(n) ? n : 0)) as [number, number, number]
}

export function percentToTintStrength(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(1, Math.max(0, percent / 100))
}

export function tintStrengthToPercent(tintStrength: number): number {
  if (!Number.isFinite(tintStrength)) return 0
  return Math.round(Math.min(1, Math.max(0, tintStrength)) * 100)
}
