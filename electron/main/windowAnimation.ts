import { BrowserWindow, screen } from 'electron'

// 跳屏动画：直线划出源屏、瞬移、直线飞入目标屏。全应用只有这一处需要补间，特意不做成
// 通用引擎——目前只有 windowBehavior.ts 的三处跳屏/归位调用点需要它，抽象是投机。
//
// 核心不变式（必须由构造保证，不是约定）：animateTo 保证在任何退出路径上，窗口的最终
// bounds 恰好等于传入的 target，唯一例外是 win.isDestroyed()。这样最坏情况下动画退化成
// 「瞬间跳」（也就是引入本文件之前的行为），永远不会把窗口留在屏幕外。
//
// 已核实的平台约束，直接采用，不在这里重新验证：
// - setBounds(bounds, animate) 的 animate 参数是 macOS 专属，Windows 上 native_window_views.cc
//   的 SetBounds 函数体内从不引用它，只能自己按帧补间。
// - 绝不能读 getBounds() 的输出喂回 setBounds() 做补间（electron#27651）：DIP 取整会让窗口
//   逐次变大。每一帧都必须从本模块调用 animateTo 时存下来的起点/终点矩形算，不再二次读
//   getBounds()（唯一例外是函数入口读一次 start，用于判断源屏与守卫条件）。
// - 移出屏幕外不会被系统修正：MSDN「完全离屏会被自动调整」只针对 SetWindowPlacement，
//   Electron setBounds 实际走的 SetWindowPos 路径没有这条行为。
// - 离屏不会让渲染进程被节流：Page Visibility 的 occlusion 追踪是 macOS 专属，Windows 上
//   visibilityState 只在最小化/hide() 时变 hidden，动画途中窗口仍在正常渲染。

const FRAME_MS = 16
const LEG_MS = 180
// 守卫②（尺寸变化容差）用，定义见 animateTo 内该守卫旁的注释
const SIZE_DRIFT_TOLERANCE_PX = 2

// 单飞：模块内只允许一个进行中的动画。这里存的是「取消当前动画」的函数（即 animateTo
// 返回给调用方的同一个函数），isAnimating() 与新动画抢占旧动画都靠它，不单独维护一份
// timer 引用——避免两份状态不同步。
let activeCancel: (() => void) | null = null

export function isAnimating(): boolean {
  return activeCancel !== null
}

// 返回的 CancelFn 无参数，语义单一：停表并立刻 setBounds(target)，调用方永远不必考虑
// 「取消后窗口在哪」。多次调用是安全的 no-op（第二次起直接返回）。
export function animateTo(win: BrowserWindow, target: Electron.Rectangle): () => void {
  // 新动画先取消旧的（snap 到旧动画的 target），再从当前位置（即刚 snap 到的位置）起算，
  // 这样不需要关心两个动画之间的位置关系
  if (activeCancel) {
    activeCancel()
  }

  // 入口就挡掉已销毁的窗口：下面 getBounds() 对已销毁窗口会同步抛错，而本模块声明的不变式
  // 是「除 isDestroyed() 外，任何退出路径都不让调用方收到异常」。当前调用图下不可达
  // （index.ts 的 closed 监听与置空同步、调用前都有非空判断），但那依赖的是调用方纪律；
  // 这一行让不变式由本模块自己保证，不外包给调用点
  if (win.isDestroyed()) return () => {}

  const start = win.getBounds() // 全程只读这一次
  const srcDisplay = screen.getDisplayMatching(start)
  const dstDisplay = screen.getDisplayMatching(target)

  // 前置守卫①：同屏移动做「飞出去再飞回来」没有意义，且 restoreHomeBoundsIfLeavingDodgeMode
  // 与冲突解除归位都可能是同屏调用——这条守卫是必需的，不是可选优化
  const sameDisplay = srcDisplay.id === dstDisplay.id
  // 前置守卫②：本动画只处理平移，调用方主动要求的真尺寸变化不做补间——但要留出容差，
  // 不能用逐像素相等。根因（已定位，非猜测）：跳屏在两块缩放比例不同的显示器间来回时，
  // Windows 会在目标屏对窗口发一次 WM_DPICHANGED 强改尺寸（本文件顶部注释、leg2 末尾注释
  // 都已记录这个平台行为）；这次改动发生在 setBounds 调用链之外、异步触发，哪怕 leg2
  // 末帧已经把尺寸写死成 target，只要 WM_DPICHANGED 在动画结束之后才到达，窗口的真实尺寸
  // 仍会在动画返回之后被悄悄带偏——而 DIP 取整（screenToDipRect 单次换算即可能有 1px
  // 误差，activeWindowMonitor.ts 里 1920/1.4=1371.43→1372 是同一机制的实测案例）决定了
  // 这个偏移通常只有 1px 量级。homeBounds 归位正是会撞上这个偏移的调用点：它的 target 是
  // 冲突前记下的旧尺寸，start 却是窗口刚在另一块屏幕上待过一段时间、可能已被上述异步事件
  // 带偏的当前尺寸，两者只差 1px 就会被逐像素比较误判成「调用方真的要 resize」，退化成
  // 瞬间 setBounds、动画消失——恰是"归位没有动画"这个 bug 的根因。2px 留了一次跨屏来回的
  // 双倍余量，仍然远小于真实 resize（通常以十/百像素为单位），不会掩盖真正的守卫场景
  const sizeChanged =
    Math.abs(target.width - start.width) > SIZE_DRIFT_TOLERANCE_PX ||
    Math.abs(target.height - start.height) > SIZE_DRIFT_TOLERANCE_PX


  if (sameDisplay || sizeChanged) {
    win.setBounds(target)
    return () => {}
  }

  // leg1：源屏正上方划出屏幕；leg2：目标屏正上方飞入。两段的 x 恒等于各自端点的 x
  // （viaOut.x === start.x，viaIn.x === target.x），实际只有 y 在动
  const viaOut: Electron.Rectangle = {
    x: start.x,
    y: srcDisplay.bounds.y - start.height,
    width: start.width,
    height: start.height,
  }
  const viaIn: Electron.Rectangle = {
    x: target.x,
    y: dstDisplay.bounds.y - target.height,
    width: target.width,
    height: target.height,
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false
  let leg: 1 | 2 = 1
  let legStart = Date.now()
  let legFrom = start
  let legTo = viaOut

  function removeGuards(): void {
    win.off('minimize', onInterrupt)
    win.off('hide', onInterrupt)
    win.off('close', onInterrupt)
    win.off('closed', onInterrupt)
  }

  // 四类中断里的「最小化/隐藏/关闭」：注册一次性监听，命中即 snap。动画正常结束时也要
  // 调用 removeGuards，否则每次跳屏泄漏 4 个监听器，迟早撞 MaxListenersExceededWarning。
  // 用户拖拽不特殊处理：move/moved 事件层面无法区分是用户拖拽还是本模块自己的 setBounds
  // 触发的，而动画期间窗口大半时间在屏外高速移动，真实拖拽几乎不可能发生
  function onInterrupt(): void {
    snap()
  }

  function snap(): void {
    if (cancelled) return
    cancelled = true
    if (timer) clearTimeout(timer)
    removeGuards()
    if (activeCancel === snap) activeCancel = null
    if (!win.isDestroyed()) {
      win.setBounds(target)
    }
  }

  win.once('minimize', onInterrupt)
  win.once('hide', onInterrupt)
  win.once('close', onInterrupt)
  win.once('closed', onInterrupt)

  function frame(): void {
    try {
      // 窗口销毁：每帧首先检查，命中直接停表返回，不做任何 setBounds（销毁的窗口调用会抛错）
      if (win.isDestroyed()) {
        if (timer) clearTimeout(timer)
        removeGuards()
        if (activeCancel === snap) activeCancel = null
        return
      }

      // 按时间算进度，不按帧计数——setTimeout 的实际间隔不保证精确等于 FRAME_MS
      const t = Math.min((Date.now() - legStart) / LEG_MS, 1)

      if (t >= 1) {
        if (leg === 1) {
          // leg1 结束：落到 viaOut，然后瞬移到 viaIn，开始 leg2。不写插值结果，直接用
          // 端点值，避免跨帧累积误差
          win.setBounds(viaOut)
          win.setBounds(viaIn)
          leg = 2
          legStart = Date.now()
          legFrom = viaIn
          legTo = target
          timer = setTimeout(frame, FRAME_MS)
          return
        }
        // leg2 结束：最后一帧写死 target 本身，不写插值结果，抵消累积误差。这也是本模块
        // 唯一真正的保险——不论前面补间过程发生了什么，最终 bounds 恒等于 target。
        //
        // 已知风险（保留，不消除）：目标屏与源屏缩放比例不同时，窗口进入目标屏 Windows
        // 会发 WM_DPICHANGED 并可能强改尺寸；这里写死 target 会把尺寸改回来，结果正确但
        // 可能出现一次可见的尺寸跳变。TDD §3.7 已声明不支持不同缩放的多显示器，这属于该
        // 未支持场景在动画下的表现形式，不是本次改动引入的新缺陷
        win.setBounds(target)
        if (timer) clearTimeout(timer)
        removeGuards()
        if (activeCancel === snap) activeCancel = null
        return
      }

      const eased = leg === 1 ? t * t : 1 - (1 - t) * (1 - t)
      win.setBounds({
        x: Math.round(legFrom.x + (legTo.x - legFrom.x) * eased),
        y: Math.round(legFrom.y + (legTo.y - legFrom.y) * eased),
        width: target.width,
        height: target.height,
      })
      timer = setTimeout(frame, FRAME_MS)
    } catch (err) {
      // 异常兜底：帧函数整体包 try/catch，任何抛错都不能把窗口留在半路
      console.error('[WindowAnimation] frame failed, snapping to target:', err)
      if (timer) clearTimeout(timer)
      removeGuards()
      if (activeCancel === snap) activeCancel = null
      if (!win.isDestroyed()) {
        win.setBounds(target)
      }
    }
  }

  activeCancel = snap
  timer = setTimeout(frame, 0)
  return snap
}
