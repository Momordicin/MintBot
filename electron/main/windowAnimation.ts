import { BrowserWindow, screen } from 'electron'

// 跳屏动画：隐藏、瞬移到目标屏（带一段短偏移）、原地划入+淡入。全应用只有这一处需要补间，
// 特意不做成通用引擎——目前只有 windowBehavior.ts 的三处跳屏/归位调用点需要它，抽象是投机。
//
// 核心不变式（必须由构造保证，不是约定）：animateTo 保证在任何退出路径上，窗口的最终
// bounds 恰好等于传入的 target、且 opacity 恰好等于 1，唯一例外是 win.isDestroyed()。这样
// 最坏情况下动画退化成「瞬间跳」，永远不会把窗口留在半路或半透明状态。
//
// 设计变更（取代此前"划出源屏、瞬移、飞入目标屏"的两段式跨屏补间）：旧设计全程用 setBounds
// 补间窗口矩形，本质是在跟 Windows 抢窗口矩形的所有权——WM_DPICHANGED 可能在补间途中异步
// 改尺寸，这正是前置守卫②（尺寸容差 2px）存在的原因。补间矩形这条路径本身就带着这一整类
// 问题，不管补间过程设计得多小心都甩不掉。新设计把 setBounds 到 target 的动作提到动画*之前*
// 一次性做完（连同一个短偏移，用来留出补间的视觉空间），只在那一刻承受 WM_DPICHANGED 的
// 冲击；之后的补间只动位置（宽高全程 = target 的宽高，不再补间尺寸）+ 淡入透明度，跟窗口
// 矩形的所有权之争彻底脱钩。
//
// 已核实的平台约束，直接采用，不在这里重新验证：
// - setBounds(bounds, animate) 的 animate 参数是 macOS 专属，Windows 上 native_window_views.cc
//   的 SetBounds 函数体内从不引用它，只能自己按帧补间。
// - 绝不能读 getBounds() 的输出喂回 setBounds() 逐帧驱动补间（electron#27651）：DIP 取整会让
//   窗口逐次变大。每一帧的插值都只从「落到偏移位置、稳定之后」读的那一次 settledStart 算，
//   不再二次读 getBounds()（入口读一次 start 只用于判断源屏，供守卫使用）。

const FRAME_MS = 16
const DURATION_MS = 180
// 短偏移距离：起点比 target 沿 y 轴向上偏移这么多像素再落到目标屏，随后原地滑入 + 淡入。
// 24px 足够让"滑入"的动效可见，同时远小于典型显示器的 workArea 高度，正常情况下不会把
// 起点推到相邻显示器或工作区之外；选纵轴而不是横轴单纯是延续旧设计"从上方落下"的方向感，
// 并非平台约束
const OFFSET_PX = 24

// 单飞：模块内只允许一个进行中的动画。这里存的是「取消当前动画」的函数（即 animateTo
// 返回给调用方的同一个函数），isAnimating() 与新动画抢占旧动画都靠它，不单独维护一份
// timer 引用——避免两份状态不同步。
let activeCancel: (() => void) | null = null

export function isAnimating(): boolean {
  return activeCancel !== null
}

// animateTo 的前置守卫，抽成纯函数供单测——本模块其余部分依赖真实 BrowserWindow/screen，
// 不可测；这条守卫只依赖显示器 id，可以独立验证（跟 windowPositions.ts 把
// pickLargestDisplay/clampBoundsToWorkArea 等纯函数从依赖 app.getPath 的部分拆出来单测
// 同一个约定）。
//
// 同屏移动做「飞出去再飞回来」没有意义，且 restoreHomeBoundsIfLeavingDodgeMode 与冲突
// 解除归位都可能是同屏调用——这条守卫是必需的，不是可选优化。
//
// 此前还有第二条守卫（尺寸变化容差 2px），是旧的"补间矩形"设计专用的：那个设计里补间过程
// 会逐帧 setBounds 出中间尺寸，需要用容差区分"调用方真的要 resize"跟"WM_DPICHANGED 的
// 异步漂移"。新设计里宽高全程固定为 target 的宽高、从不补间，这条区分不再有存在的理由，
// 随尺寸补间一起移除（已核实 SIZE_DRIFT_TOLERANCE_PX 在本文件之外没有其它引用点）
export function evaluateAnimationGuards(
  srcDisplayId: number,
  dstDisplayId: number
): { sameDisplay: boolean } {
  return { sameDisplay: srcDisplayId === dstDisplayId }
}

// 纯函数：给定最终矩形与目标屏工作区，算出动画起点——宽高与 target 相同（全程不变），
// 只沿 y 偏移一个固定短距离。供单测直接验证，不依赖 screen/BrowserWindow。
//
// 偏移方向朝**工作区内部**，不写死向上。旧的两段式设计是故意飞到屏外的，所以方向无所谓；
// 新设计只想小幅滑入，一旦起点落到工作区外，观感就变成「窗口先消失一下再滑回来」，比不做
// 动画更糟。窗口贴着显示器顶端时（用户完全可能把它拖到顶上）向上偏移正好踩中这一点，
// 因此改为：上方放得下就从上方来，放不下就从下方来。两边都放不下（窗口高度已经占满工作区）
// 时退化为零偏移——那一帧只剩淡入，仍然优于滑出屏外
export function computeOffsetStartRect(
  target: Electron.Rectangle,
  workArea: Electron.Rectangle
): Electron.Rectangle {
  const roomAbove = target.y - workArea.y
  const roomBelow = workArea.y + workArea.height - (target.y + target.height)
  const offset =
    roomAbove >= OFFSET_PX ? -OFFSET_PX
    : roomBelow >= OFFSET_PX ? OFFSET_PX
    : 0
  return {
    x: target.x,
    y: target.y + offset,
    width: target.width,
    height: target.height,
  }
}

// 纯函数：给定起点/终点矩形与进度 t（0~1），算出该帧应该写的 x/y/opacity。ease-out
// （1-(1-t)²）——只做"抵达"这一种运动，不再需要旧设计里 leg1 的 ease-in（划出）。
// t=0 时恰好等于 from 的位置、opacity=0；t=1 时恰好等于 to 的位置、opacity=1——
// 这也是"最终状态一定正确"这条不变式在纯函数层面的体现，frame() 的 t>=1 分支不依赖这一点
// （仍然直接写死 target 本身以抵消累积误差），但两者结果一致
export function interpolateFrame(
  from: Electron.Rectangle,
  to: Electron.Rectangle,
  t: number
): { x: number; y: number; opacity: number } {
  const clamped = Math.min(Math.max(t, 0), 1)
  const eased = 1 - (1 - clamped) * (1 - clamped)
  return {
    x: Math.round(from.x + (to.x - from.x) * eased),
    y: Math.round(from.y + (to.y - from.y) * eased),
    opacity: eased,
  }
}

// 返回的 CancelFn 无参数，语义单一：停表并立刻把窗口收尾到 target/opacity 1，调用方永远
// 不必考虑「取消后窗口在哪、是不是还半透明」。多次调用是安全的 no-op（第二次起直接返回）。
export function animateTo(win: BrowserWindow, target: Electron.Rectangle): () => void {
  // 新动画先取消旧的（snap 到旧动画的 target，opacity 收回 1），再从当前位置起算，这样
  // 不需要关心两个动画之间的位置/透明度关系
  if (activeCancel) {
    activeCancel()
  }

  // 入口就挡掉已销毁的窗口：下面 getBounds() 对已销毁窗口会同步抛错，而本模块声明的不变式
  // 是「除 isDestroyed() 外，任何退出路径都不让调用方收到异常」。当前调用图下不可达
  // （index.ts 的 closed 监听与置空同步、调用前都有非空判断），但那依赖的是调用方纪律；
  // 这一行让不变式由本模块自己保证，不外包给调用点
  if (win.isDestroyed()) return () => {}

  const start = win.getBounds() // 只用于判断源屏，供守卫使用
  const srcDisplay = screen.getDisplayMatching(start)
  const dstDisplay = screen.getDisplayMatching(target)

  const { sameDisplay } = evaluateAnimationGuards(srcDisplay.id, dstDisplay.id)

  if (sameDisplay) {
    // 永久诊断日志（取代此前提交又删除的 DIAG TEMP 调试块）：跳屏/归位事件本身很稀疏
    // （全屏冲突进入/解除才触发一次），这一行不构成日志噪音，换来的是下一次有人报告
    // "没有动画"时能直接从日志里看到是哪条守卫命中、start/target 矩形具体是什么，
    // 不用再临时加埋点复现
    console.log(
      `[WindowAnimation] Skipped animation (sameDisplay=true): ` +
        `start=${start.width}x${start.height}@${start.x},${start.y} -> ` +
        `target=${target.width}x${target.height}@${target.x},${target.y}`
    )
    win.setBounds(target)
    win.setOpacity(1)
    return () => {}
  }

  // 第 1~3 步整段包在 try 里：它跑在 activeCancel 赋值和中断守卫建立**之前**，此时还没有
  // 任何回收手段。一旦这里抛出，异常会一路冒到调用方，而窗口已经被置成全透明、且没有任何
  // 人会把它改回来。当前调用链是同步的、中间没有让出点，所以大概率不可达；但这段代码的
  // 失败后果（窗口永久隐形）远重于它的可能性，值得一个兜底
  let offsetStart: Electron.Rectangle
  let settledStart: Electron.Rectangle
  try {
    // 第 1 步：先把窗口视觉隐藏，瞬移永远不会被看见
    win.setOpacity(0)

    // 第 2 步：一次性 setBounds 到"最终尺寸 + 目标屏上的偏移位置"——这一刻窗口已经落在
    // 目标屏，任何 WM_DPICHANGED 尺寸校正在这里触发，而不是在补间过程中触发
    offsetStart = computeOffsetStartRect(target, dstDisplay.workArea)
    win.setBounds(offsetStart)

    // 第 3 步：稳定之后只读一次实际落点（可能因为上面那次 WM_DPICHANGED 而与 offsetStart
    // 有细微出入），后面补间全程只用这一次读数算起点，不再二次读 getBounds()
    settledStart = win.isDestroyed() ? offsetStart : win.getBounds()
  } catch (err) {
    console.error('[WindowAnimation] Failed to stage the slide-in, falling back to an instant jump:', err)
    if (!win.isDestroyed()) {
      try {
        win.setBounds(target)
        win.setOpacity(1)
      } catch { /* 窗口已经不可用，没有别的补救手段 */ }
    }
    return () => {}
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false
  const animStart = Date.now()

  function removeGuards(): void {
    win.off('minimize', onInterrupt)
    win.off('hide', onInterrupt)
    win.off('close', onInterrupt)
    win.off('closed', onInterrupt)
  }

  // 四类中断里的「最小化/隐藏/关闭」：注册一次性监听，命中即 snap。动画正常结束时也要
  // 调用 removeGuards，否则每次跳屏泄漏 4 个监听器，迟早撞 MaxListenersExceededWarning。
  // 用户拖拽不特殊处理：move/moved 事件层面无法区分是用户拖拽还是本模块自己的 setBounds
  // 触发的，而动画期间窗口大半时间在补间途中，真实拖拽几乎不可能发生
  function onInterrupt(): void {
    snap()
  }

  function snap(): void {
    if (cancelled) return
    cancelled = true
    if (timer) clearTimeout(timer)
    removeGuards()
    if (activeCancel === snap) activeCancel = null
    if (win.isDestroyed()) return
    // 与 frame() 里同款的兜底：snap() 是四个中断事件与跨调用取消的共同出口，而它调的是
    // 同一类原生方法。这里抛出去的话，窗口就停在当时的状态——很可能正是第 1 步
    // setOpacity(0) 之后的全透明，那比不做动画糟得多，也直接违反本模块唯一的硬不变式
    try {
      win.setBounds(target)
      win.setOpacity(1)
    } catch (err) {
      console.error('[WindowAnimation] Failed to snap to target:', err)
    }
  }

  win.once('minimize', onInterrupt)
  win.once('hide', onInterrupt)
  win.once('close', onInterrupt)
  win.once('closed', onInterrupt)

  function frame(): void {
    try {
      // 窗口销毁：每帧首先检查，命中直接停表返回，不做任何 setBounds/setOpacity（销毁的
      // 窗口调用会抛错）
      if (win.isDestroyed()) {
        if (timer) clearTimeout(timer)
        removeGuards()
        if (activeCancel === snap) activeCancel = null
        return
      }

      // 按时间算进度，不按帧计数——setTimeout 的实际间隔不保证精确等于 FRAME_MS
      const t = Math.min((Date.now() - animStart) / DURATION_MS, 1)

      if (t >= 1) {
        // 动画结束：最后一帧写死 target 本身、opacity 恰好为 1，不写插值结果，抵消累积
        // 误差。这是本模块唯一真正的保险——不论前面补间过程发生了什么，最终 bounds/opacity
        // 恒等于 target/1
        win.setBounds(target)
        win.setOpacity(1)
        if (timer) clearTimeout(timer)
        removeGuards()
        if (activeCancel === snap) activeCancel = null
        return
      }

      // 宽高全程等于 target 的宽高，只补间 x/y + opacity——若第 2 步之后仍有迟到的
      // WM_DPICHANGED 试图改尺寸，这里每一帧都会把宽高重新写回 target，覆盖掉那次改动
      const { x, y, opacity } = interpolateFrame(settledStart, target, t)
      win.setBounds({ x, y, width: target.width, height: target.height })
      win.setOpacity(opacity)
      timer = setTimeout(frame, FRAME_MS)
    } catch (err) {
      // 异常兜底：帧函数整体包 try/catch，任何抛错都不能把窗口留在半路或半透明
      console.error('[WindowAnimation] frame failed, snapping to target:', err)
      if (timer) clearTimeout(timer)
      removeGuards()
      if (activeCancel === snap) activeCancel = null
      if (!win.isDestroyed()) {
        win.setBounds(target)
        win.setOpacity(1)
      }
    }
  }

  activeCancel = snap
  timer = setTimeout(frame, 0)
  return snap
}
