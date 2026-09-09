import { describe, it, expect } from 'vitest'
import { shouldSkipOverlayDodge, decideDodge, decideDodgeClear } from './windowBehavior'

// 只测 handleOverlayDodge/handlePinMode 的前置守卫/决策（纯函数）。本模块其余部分依赖
// 真实 BrowserWindow/screen/activeWindowMonitor 轮询状态，需要真实 Electron 运行时才能
// 验证，这里不测——跟 windowAnimation.test.ts 只测纯函数同一个约定

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

// decideDodge 覆盖的是 handleOverlayDodge/handlePinMode 里真正调用
// moveToNonFullscreenDisplay 的那个决策，包括排除目标本身——不只是一个真假判断（见该
// 函数头注释 review finding E）。这一点是有意为之：上一版把纯函数切在"两个显示器 id 相不
// 相等"这个恒等式上，把 bug 原样改回调用点，三个测试照样全绿，等于没有回归防护。
//
// 本函数是窗口无关的纯函数，同时被悬浮窗（handleOverlayDodge）与聊天窗口
// （handlePinMode 的 dodge-fullscreen 分支）复用，见该函数头注释。下面前半段用悬浮窗的
// 场景命名（历史用例，行为不变），后半段追加聊天窗口的场景，钉住本轮修的三个缺陷
// 里可单测的部分
describe('decideDodge', () => {
  it('dodges on the first conflict — own window and conflict on the same display, no prior tracking', () => {
    // 覆盖点 (1)：首次躲避，本窗口/冲突都在显示器 1，此前没有任何跟踪值
    expect(decideDodge(true, false, 1, 1)).toEqual({ action: 'dodge', excludeDisplayId: 1 })
  })

  it('does not move when the conflict is on a display the window is not on (symptom 1)', () => {
    // 覆盖点 (2)：全屏出现在显示器 2，本窗口还在显示器 1——没有遮挡，不该动
    expect(decideDodge(true, false, 1, 2)).toEqual({ action: 'none' })
  })

  it('does not move on a second conflict on the original display after already dodging away (symptom 2)', () => {
    // 覆盖点 (3)：本窗口已经从显示器 1 躲到显示器 2。第二次冲突又出现在显示器 1，但本窗口
    // 现在人在显示器 2——两者不一致，不该动它。旧实现在这里会拿"本窗口自己所在的显示器 2"
    // 当排除项，displays.find(d => d.id !== 2) 解出显示器 1，正好把它排回冲突屏本身
    expect(decideDodge(true, false, 2, 1)).toEqual({ action: 'none' })
  })

  it('dodges using the CURRENT conflict display when the conflict relocates onto the window mid-episode (finding A)', () => {
    // 覆盖点 (4)：本窗口已经躲到显示器 2，此时调用方的跟踪值还留着上一次的冲突显示器 1
    // （过期值）。冲突这次跟着挪到了本窗口当前所在的显示器 2——必须再次躲避，且排除目标
    // 必须是本次最新的冲突显示器 2。
    //
    // 本函数无状态、不接收任何跟踪值，所以过期值在这一层没有落脚点；这条断言钉住的是
    // "排除目标恒等于 conflictDisplayId"这个契约。若有人回归成用过期跟踪值算排除项
    // （exclude=1），displays.find(d => d.id !== 1) 会解出显示器 2——也就是本窗口已经在的、
    // 真正被遮挡的那块屏，跳屏变成 no-op，本窗口永久卡在冲突之上（见 review finding A）
    expect(decideDodge(true, false, 2, 2)).toEqual({ action: 'dodge', excludeDisplayId: 2 })
  })

  it('does not dodge when the conflict is whitelisted or dodging is not needed', () => {
    // 覆盖点 (5)：needsToDodge 为 false，或者前台程序在白名单里——都不该躲避
    expect(decideDodge(false, false, 1, 1)).toEqual({ action: 'none' })
    expect(decideDodge(true, true, 1, 1)).toEqual({ action: 'none' })
  })

  // 以下几条用聊天窗口（handlePinMode，dodge-fullscreen 模式）的场景重新走一遍同一份契约，
  // 对应本轮修的聊天窗口缺陷①②——handlePinMode 此前从未调用过这个函数，是本轮改动新增的
  // 调用点，因此单独用聊天窗口的措辞钉一遍，而不是只依赖上面悬浮窗视角的等价断言
  it('chat window: does not dodge a fullscreen conflict on a different display (defect #2 — chat previously dodged unconditionally)', () => {
    // 聊天窗口在显示器 1，全屏冲突发生在显示器 2——两者不同屏，聊天窗口没有被遮挡。旧
    // handlePinMode 只看 info.isFullscreen && !isWhitelisted，完全不比较显示器，这里会
    // 无差别跳屏；decideDodge 要求 ownDisplayId === conflictDisplayId 才躲，正确判定不需要动
    expect(decideDodge(true, false, 1, 2)).toEqual({ action: 'none' })
  })

  it('chat window: dodges away from the display the conflict is actually on, not the display it dodged to last time (defect #1)', () => {
    // 聊天窗口已经从显示器 1 躲到显示器 2（第一次冲突在显示器 1）。第二次冲突出现在聊天
    // 窗口当前所在的显示器 2——排除目标必须是 2（本次冲突所在），而不是旧代码里那个只在
    // dodgeDisplayId === null 时播下、此后固定不变的显示器 1。若排除目标错误地沿用了 1，
    // displays.find(d => d.id !== 1) 会解出 2——也就是聊天窗口当前正被遮挡的那块屏，
    // 等价于把窗口留在/移回冲突屏上（用户报告的"第二次全屏冲突把聊天窗口移到冲突屏上"）
    expect(decideDodge(true, false, 2, 2)).toEqual({ action: 'dodge', excludeDisplayId: 2 })
  })
})

// decideDodgeClear 覆盖"这一 tick 报告不需要躲避时，该不该结束当前躲避 episode"这个判断。
// 它只看"是否还欠着一次躲避账"，不做任何显示器比较——悬浮窗已删除的 问题1b 门槛
// （info.displayId === overlayDodgeSourceDisplayId）与聊天窗口同形状的旧门槛
// （info.displayId === dodgeDisplayId，本轮缺陷③）在**签名层面**都没有落脚点：函数只收
// 一个参数，要把那道比较加回来必须先给导出函数加参数，那是一次会连带改调用点的签名变更。
// 因此这几条测试不负责拦回归（拦不住也不该由它拦），只钉住这个决策的真值表——两个调用方
// （handleOverlayDodge/handlePinMode）各自传各自的跟踪值，行为完全一致
describe('decideDodgeClear', () => {
  it('clears whenever there is an active dodge to account for', () => {
    expect(decideDodgeClear(1)).toBe(true)
  })

  it('does not clear when there is no active dodge to account for', () => {
    expect(decideDodgeClear(null)).toBe(false)
  })
})
