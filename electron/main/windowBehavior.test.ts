import { describe, it, expect } from 'vitest'
import { shouldSkipOverlayDodge, decideOverlayDodge, decideOverlayDodgeClear } from './windowBehavior'

// 只测 handleOverlayDodge 的前置守卫/决策（纯函数）。本模块其余部分依赖真实
// BrowserWindow/screen/activeWindowMonitor 轮询状态，需要真实 Electron 运行时才能验证，
// 这里不测——跟 windowAnimation.test.ts 只测纯函数同一个约定

describe('shouldSkipOverlayDodge', () => {
  it('skips when the overlay is hidden and not tracking a dodge', () => {
    expect(shouldSkipOverlayDodge(false, null)).toBe(true)
  })

  it('does not skip when the overlay is visible, regardless of dodge tracking', () => {
    expect(shouldSkipOverlayDodge(true, null)).toBe(false)
    expect(shouldSkipOverlayDodge(true, 3)).toBe(false)
  })

  it('does not skip when hidden but still tracking a parked dodge (single-monitor fallback)', () => {
    expect(shouldSkipOverlayDodge(false, 3)).toBe(false)
  })
})

// decideOverlayDodge 覆盖的是 handleOverlayDodge 里真正调用 moveToNonFullscreenDisplay
// 的那个决策，包括排除目标本身——不只是一个真假判断（见该函数头注释 review finding E）。
// 这一点是有意为之：上一版把纯函数切在"两个显示器 id 相不相等"这个恒等式上，把 bug 原样
// 改回调用点，三个测试照样全绿，等于没有回归防护。
describe('decideOverlayDodge', () => {
  it('dodges on the first conflict — overlay and conflict on the same display, no prior tracking', () => {
    // 覆盖点 (1)：首次躲避，overlay/conflict 都在显示器 1，此前没有任何跟踪值
    expect(decideOverlayDodge(true, false, 1, 1)).toEqual({ action: 'dodge', excludeDisplayId: 1 })
  })

  it('does not move when the conflict is on a display the overlay is not on (symptom 1)', () => {
    // 覆盖点 (2)：全屏出现在显示器 2，悬浮窗还在显示器 1——没有遮挡，不该动
    expect(decideOverlayDodge(true, false, 1, 2)).toEqual({ action: 'none' })
  })

  it('does not move on a second conflict on the original display after already dodging away (symptom 2)', () => {
    // 覆盖点 (3)：悬浮窗已经从显示器 1 躲到显示器 2。第二次冲突又出现在显示器 1，但悬浮窗
    // 现在人在显示器 2——两者不一致，不该动它。旧实现在这里会拿"悬浮窗自己所在的显示器 2"
    // 当排除项，displays.find(d => d.id !== 2) 解出显示器 1，正好把它排回冲突屏本身
    expect(decideOverlayDodge(true, false, 2, 1)).toEqual({ action: 'none' })
  })

  it('dodges using the CURRENT conflict display when the conflict relocates onto the overlay mid-episode (finding A)', () => {
    // 覆盖点 (4)：悬浮窗已经躲到显示器 2，此时调用方的 overlayDodgeSourceDisplayId 还留着
    // 上一次的冲突显示器 1（过期值）。冲突这次跟着挪到了悬浮窗当前所在的显示器 2——必须
    // 再次躲避，且排除目标必须是本次最新的冲突显示器 2。
    //
    // 本函数无状态、不接收任何跟踪值，所以过期值在这一层没有落脚点；这条断言钉住的是
    // "排除目标恒等于 conflictDisplayId"这个契约。若有人回归成用过期跟踪值算排除项
    // （exclude=1），displays.find(d => d.id !== 1) 会解出显示器 2——也就是悬浮窗已经在的、
    // 真正被遮挡的那块屏，跳屏变成 no-op，悬浮窗永久卡在冲突之上（见 review finding A）
    expect(decideOverlayDodge(true, false, 2, 2)).toEqual({ action: 'dodge', excludeDisplayId: 2 })
  })

  it('does not dodge when the conflict is whitelisted or dodging is not needed', () => {
    // 覆盖点 (5)：needsToDodge 为 false，或者前台程序在白名单里——都不该躲避
    expect(decideOverlayDodge(false, false, 1, 1)).toEqual({ action: 'none' })
    expect(decideOverlayDodge(true, true, 1, 1)).toEqual({ action: 'none' })
  })
})

// decideOverlayDodgeClear 覆盖"这一 tick 报告不需要躲避时，该不该结束当前躲避 episode"
// 这个判断。它只看"是否还欠着一次躲避账"，不做任何显示器比较——已删除的 问题1b 门槛
// （info.displayId === overlayDodgeSourceDisplayId）在**签名层面**就没有落脚点：函数只收
// 一个参数，要把那道比较加回来必须先给导出函数加参数，那是一次会连带改调用点的签名变更。
// 因此这两条测试不负责拦回归（拦不住也不该由它拦），只钉住这个决策的真值表。
describe('decideOverlayDodgeClear', () => {
  it('clears whenever there is an active dodge to account for', () => {
    expect(decideOverlayDodgeClear(1)).toBe(true)
  })

  it('does not clear when there is no active dodge to account for', () => {
    expect(decideOverlayDodgeClear(null)).toBe(false)
  })
})
