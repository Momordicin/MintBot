import { BrowserWindow, screen } from 'electron'

// 跳屏动画：三段式——划出源屏（淡出+外移）、瞬移到目标屏（隐身进行，不可见）、划入目标屏
// （淡入+内移）。全应用只有这一处需要补间，特意不做成通用引擎——目前只有 windowBehavior.ts
// 的三处跳屏/归位调用点需要它，抽象是投机。
//
// 核心不变式（必须由构造保证，不是约定）：animateTo 保证在任何退出路径上，窗口的最终
// bounds 恰好等于传入的 target、且 opacity 恰好等于 1，唯一例外是 win.isDestroyed()。这样
// 最坏情况下动画退化成「瞬间跳」，永远不会把窗口留在半路或半透明状态。补上退出段之后这条
// 不变式覆盖的时间窗比之前宽得多（原来只有"瞬移+划入"两步，现在多了一整段"划出"），任何一步
// 抛错都必须走到同一个收尾出口，见下面 snap() 与两段 frame 函数各自的 try/catch。
//
// 设计变更（取代此前"划出源屏、瞬移、飞入目标屏"的两段式跨屏补间）：旧设计全程用 setBounds
// 补间窗口矩形，本质是在跟 Windows 抢窗口矩形的所有权——WM_DPICHANGED 可能在补间途中异步
// 改尺寸，这正是前置守卫②（尺寸容差 2px）存在的原因。补间矩形这条路径本身就带着这一整类
// 问题，不管补间过程设计得多小心都甩不掉。新设计把 setBounds 到 target 的动作提到动画*之前*
// 一次性做完（连同一个短偏移，用来留出补间的视觉空间），只在那一刻承受 WM_DPICHANGED 的
// 冲击；之后的补间只动位置（宽高全程 = target 的宽高，不再补间尺寸）+ 淡入透明度，跟窗口
// 矩形的所有权之争彻底脱钩。划出段同理：宽高全程锁定为窗口进入动画前的实际宽高，不补间。
//
// 已核实的平台约束，直接采用，不在这里重新验证：
// - setBounds(bounds, animate) 的 animate 参数是 macOS 专属，Windows 上 native_window_views.cc
//   的 SetBounds 函数体内从不引用它，只能自己按帧补间。
// - 绝不能读 getBounds() 的输出喂回 setBounds() 逐帧驱动补间（electron#27651）：DIP 取整会让
//   窗口逐次变大。每一帧的插值都只从「落到偏移位置、稳定之后」读的那一次 settledStart 算，
//   不再二次读 getBounds()（入口读一次 start 只用于判断源屏 + 划出段的起点，供守卫使用）。

const FRAME_MS = 16
// 划出（源屏，淡出+外移）与划入（目标屏，淡入+内移）分别计时——用户决定两段现在对称，
// 都是 250ms、都用同一条减速曲线（easeEntrance，cubic-bezier(0, 0, 0, 1)）。此前划出更短
// （200ms）配加速曲线，让"离开"更利落；现在统一成跟划入一致的观感。两个常量仍然分开
// 导出、分开传给 animateTo 内部的两段 frame 函数——两段用同一个时长/曲线是当前选择，
// 不是耦合在一起：日后想再拉开也只需要改数字/换回各自的缓动函数，不需要动 animateTo
// 内部逻辑
export const EXIT_DURATION_MS = 250
export const ENTRANCE_DURATION_MS = 250
// 短偏移距离：划入起点比 target 偏移这么多像素再落到目标屏，随后原地滑入 + 淡入；划出
// 终点同理，比窗口当前位置偏移这么多像素再淡出到透明。24px 足够让"滑入/滑出"的动效可见，
// 同时远小于典型显示器的 workArea 高度，正常情况下不会把偏移推到相邻显示器或工作区之外；
// 选纵轴而不是横轴单纯是延续旧设计"从上方落下"的方向感，并非平台约束
const OFFSET_PX = 24

// 单飞：按窗口分别只允许一个进行中的动画（键是 BrowserWindow 实例本身）。这里存的是
// 「取消该窗口当前动画」的函数（即 animateTo 返回给调用方的同一个函数），isAnimating(win)
// 与新动画抢占同一窗口的旧动画都靠它，不单独维护一份 timer 引用——避免两份状态不同步。
//
// 按窗口而不是模块级单一状态：聊天窗口与悬浮窗现在会在同一个 tick 各自独立判断是否需要
// 跳屏/归位（见 windowBehavior.ts handleActiveWindowChange 不再是 either/or），若仍是模块级
// 单飞，后触发的那个会把先触发的直接 cancel 掉（snap 到目标、动画中断），而不是两个窗口
// 真正并行播放。按窗口分别单飞之后，两个窗口的动画互不干扰，同一窗口内部仍然保留"新动画
// 抢占旧动画"的原有语义——不论旧动画此刻处在划出段还是划入段，抢占路径都是同一个 snap()，
// 见 animateTo 顶部 existingCancel() 调用点注释
const activeCancels = new Map<BrowserWindow, () => void>()

export function isAnimating(win: BrowserWindow): boolean {
  return activeCancels.has(win)
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

// 纯函数：给定一个矩形与它所在（或将要落在）那块屏的工作区，算出偏移后的矩形——宽高与
// 输入矩形相同（全程不变），只沿 y 偏移一个固定短距离，方向朝**工作区内部**（上方放得下
// 就从上方来，放不下就从下方来，两边都放不下时退化为零偏移）。供单测直接验证，不依赖
// screen/BrowserWindow。
//
// 两段动画共用同一个函数，只是传入的矩形与工作区不同：
// - 划入段：传入 target（最终落点）与目标屏 workArea，算出的是"划入起点"——因为函数总是
//   在有空间的一侧偏移，这个起点相对 target 天然就是"从外侧靠近"的方向，即"内移"的起点。
// - 划出段：传入窗口当前实际位置（而不是 target）与源屏 workArea，算出的是"划出终点"——
//   同一套"往有空间的一侧偏移"逻辑，落在当前位置的外侧，即"外移"的终点。这就是划出偏移
//   方向"镜像"划入选择逻辑的含义：不是把符号反过来，而是把这套逻辑套在当前位置而不是
//   目标位置上，天然得到远离当前位置的偏移，不需要另写一份方向判断
//
// 偏移方向不写死向上：旧的两段式设计是故意飞到屏外的，所以方向无所谓；现在两段都只想小幅
// 划入/划出，一旦偏移落到工作区外，观感就变成"窗口先消失一下再滑回来"，比不做动画更糟。
// 窗口贴着显示器顶端时（用户完全可能把它拖到顶上）向上偏移正好踩中这一点
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

// 划入/划出共用的曲线：cubic-bezier(0, 0, 0, 1)（减速）——两段现在时长、曲线都对称，
// 划出段（下方 exitFrame）与划入段（entranceFrame）都调用这同一个函数。P1=(0,0)、
// P2=(0,1) 时贝塞尔曲线的 x(s) 恰好
// 退化成 x(s) = s³（P1x=P2x=0，只剩 s³ 那一项），因此有精确闭式解：给定时间进度 p，直接
// s = cbrt(p)，不需要数值迭代。y(s) = 3(1-s)²s·P1y + 3(1-s)s²·P2y + s³，P1y=0 时前一项
// 消失，故 y(s) = 3(1-s)s² + s³ = 3s² - 2s³。
//
// 之所以要在这里重新推导、而不是直接抄一个通用三次贝塞尔求值库：这条曲线的两个控制点都是
// 边界值（0 或 1），刻意选用是为了拿到这个闭式解，避免为一条曲线引入数值迭代的开销/误差。
// 下方专门加了一条测试，用数值反解的参考实现核对这个闭式解，防止日后有人改动这里却忘了
// 曲线本身也变了
export function easeEntrance(p: number): number {
  const clamped = Math.min(Math.max(p, 0), 1)
  const s = Math.cbrt(clamped)
  return s * s * (3 - 2 * s)
}

// 划出段现在与划入段共用同一条曲线（easeEntrance，见上）——不再需要一条单独的加速曲线，
// 此前这里的 easeExit/exitBezierX/solveExitBezierParam（cubic-bezier(0.3, 0, 1, 1) 的数值
// 反解）已随划出曲线一起移除，划出段下方直接调用 easeEntrance

// 纯函数：给定起点/终点矩形、进度 t（0~1）与一条缓动函数，算出该帧应该写的 x/y 与"缓动
// 进度"（不直接叫 opacity——划入段里进度本身就是 0→1 的透明度，但划出段的透明度是
// 1-进度，方向相反，opacity 的换算交给调用方，这里只负责位置插值 + 吐出缓动后的 [0,1] 值）。
// t=0 时恰好等于 from 的位置、progress=0；t=1 时恰好等于 to 的位置、progress=1——这也是
// "最终状态一定正确"这条不变式在纯函数层面的体现，两段 frame 函数的 t>=1 分支不依赖这一点
// （仍然直接写死各自的终态以抵消累积误差），但两者结果一致
export function interpolateFrame(
  from: Electron.Rectangle,
  to: Electron.Rectangle,
  t: number,
  easing: (p: number) => number
): { x: number; y: number; opacity: number } {
  const clamped = Math.min(Math.max(t, 0), 1)
  const eased = easing(clamped)
  return {
    x: Math.round(from.x + (to.x - from.x) * eased),
    y: Math.round(from.y + (to.y - from.y) * eased),
    opacity: eased,
  }
}

// 返回的 CancelFn 无参数，语义单一：停表并立刻把窗口收尾到 target/opacity 1，调用方永远
// 不必考虑「取消后窗口在哪、是不是还半透明、此刻处在划出段还是划入段」。多次调用是安全的
// no-op（第二次起直接返回）。
export function animateTo(win: BrowserWindow, target: Electron.Rectangle): () => void {
  // 新动画先取消同一窗口的旧动画（snap 到旧动画的 target，opacity 收回 1），再从当前位置
  // 起算，这样不需要关心两个动画之间的位置/透明度关系——只取消这一个窗口自己的记录，不影响
  // 另一个窗口可能正在进行的动画（见上面 activeCancels 的注释）。旧动画不论处在划出段还是
  // 划入段，取消路径都是同一个 snap()，见下方定义——不存在"划出段的定时器没被清掉"这类
  // 遗漏，因为 timer 变量与 snap() 是同一组闭包共享的，两段都写回同一个 timer
  const existingCancel = activeCancels.get(win)
  if (existingCancel) {
    existingCancel()
  }

  // 入口就挡掉已销毁的窗口：下面 getBounds() 对已销毁窗口会同步抛错，而本模块声明的不变式
  // 是「除 isDestroyed() 外，任何退出路径都不让调用方收到异常」。当前调用图下不可达
  // （index.ts 的 closed 监听与置空同步、调用前都有非空判断），但那依赖的是调用方纪律；
  // 这一行让不变式由本模块自己保证，不外包给调用点
  if (win.isDestroyed()) return () => {}

  const start = win.getBounds() // 划出段起点 + 用于判断源屏，供守卫使用
  const srcDisplay = screen.getDisplayMatching(start)
  // ⚠️ 已知限制，不在本次改动范围内修复：dstDisplay 只在调用这一刻读一次，之后整段补间
  // 都无条件收敛到字面意义上的 target 矩形（见文件头的核心不变式）。如果目标显示器在
  // 补间进行中途被拔掉，target 早已不落在任何仍连接的显示器范围内，窗口最终会停在一块
  // 不存在的显示器坐标上——不变式本身仍然成立（bounds 恰好等于 target），只是 target
  // 这时已经失去意义。调用方目前也没有对"目标显示器消失"做特殊处理，这属于更大范围的
  // 显示器热插拔支持，只记录，不在这里处理
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

  // 划出段的终点：不是 target，而是窗口当前位置（start）沿"有空间的一侧"外移
  // OFFSET_PX——与划入段共用同一个 computeOffsetStartRect，见该函数注释里"镜像"的含义
  const exitEnd = computeOffsetStartRect(start, srcDisplay.workArea)

  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  function removeGuards(): void {
    win.off('minimize', onInterrupt)
    win.off('hide', onInterrupt)
    win.off('close', onInterrupt)
    win.off('closed', onInterrupt)
  }

  // 四类中断里的「最小化/隐藏/关闭」：注册一次性监听，命中即 snap，不论此刻处在划出段
  // 还是划入段——interrupt 监听在整个 animateTo 调用期间只注册一次（覆盖两段），而不是
  // 每段各注册一次，这样中断处理与"现在是哪一段"完全解耦。动画正常结束时也要调用
  // removeGuards，否则每次跳屏泄漏 4 个监听器，迟早撞 MaxListenersExceededWarning。
  // 用户拖拽不特殊处理：move/moved 事件层面无法区分是用户拖拽还是本模块自己的 setBounds
  // 触发的。三段式改造后总时长从旧版 180ms 涨到 EXIT_DURATION_MS + ENTRANCE_DURATION_MS =
  // 500ms，补间途中真实拖拽窗口标题栏的概率相应变大，不再是"几乎不可能"；这里仍然刻意
  // 不做拖拽中断处理——那是更大的设计改动，本轮不做。后果是每帧的 setBounds 会把手动
  // 拖出去的位置拉回补间路径上，是可感知的 UX 瑕疵，但动画结束时位置仍收敛到 target，
  // 不是正确性 bug
  function onInterrupt(): void {
    snap()
  }

  function stopAndUntrack(): void {
    if (timer) clearTimeout(timer)
    removeGuards()
    if (activeCancels.get(win) === snap) activeCancels.delete(win)
  }

  function snap(): void {
    if (cancelled) return
    cancelled = true
    stopAndUntrack()
    if (win.isDestroyed()) return
    // 与两段 frame 函数里同款的兜底：snap() 是四个中断事件、跨调用取消、以及"划出/瞬移
    // 阶段本身抛错"的共同出口，而它调的是同一类原生方法。这里抛出去的话，窗口就停在当时
    // 的状态——很可能正是划出段淡出到一半、或瞬移阶段 setOpacity(0) 之后的全透明，那比
    // 不做动画糟得多，也直接违反本模块唯一的硬不变式
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
  // 中断监听注册完成、activeCancels 记录建立完成之后，才开始跑任何有副作用的补间步骤——
  // 划出段本身现在也会改 opacity（1→0），必须在它开始之前就具备"出事能收尾"的能力，
  // 不能像旧设计那样只在瞬移阶段之后才建立这条安全网
  activeCancels.set(win, snap)

  const exitStart = Date.now()

  function exitFrame(): void {
    try {
      // 窗口销毁：每帧首先检查，命中直接停表返回，不做任何 setBounds/setOpacity（销毁的
      // 窗口调用会抛错）
      if (win.isDestroyed()) {
        stopAndUntrack()
        return
      }

      // 按时间算进度，不按帧计数——setTimeout 的实际间隔不保证精确等于 FRAME_MS
      const t = Math.min((Date.now() - exitStart) / EXIT_DURATION_MS, 1)

      if (t >= 1) {
        // 划出段结束，零死帧地衔接瞬移 + 划入段——不经过下一次 setTimeout，同一个调用栈
        // 里继续跑，避免出现"划出完成之后停一拍才开始瞬移"的可感知空档
        beginTeleportAndEntrance()
        return
      }

      // 宽高全程等于 start 的宽高，只补间 x/y + opacity（1→0，与 progress 相反方向）。
      // 划出段现在与划入段共用 easeEntrance 这条曲线（见该函数定义处注释）
      const { x, y, opacity } = interpolateFrame(start, exitEnd, t, easeEntrance)
      win.setBounds({ x, y, width: start.width, height: start.height })
      win.setOpacity(1 - opacity)
      timer = setTimeout(exitFrame, FRAME_MS)
    } catch (err) {
      // 异常兜底：帧函数整体包 try/catch，任何抛错都不能把窗口留在半路或半透明
      console.error('[WindowAnimation] exit frame failed, snapping to target:', err)
      snap()
    }
  }

  // 瞬移到目标屏 + 启动划入段。这一步只在划出段淡出到 opacity 0 之后才会跑到，因此瞬移
  // 本身不可见——这正是让接缝不可察觉的关键。整段包 try/catch：此时 activeCancels 记录
  // 与中断守卫都已建立，出错时直接调用 snap() 收尾，不再需要旧设计里那份独立的兜底分支
  function beginTeleportAndEntrance(): void {
    let offsetStart: Electron.Rectangle
    let settledStart: Electron.Rectangle
    try {
      // 第 1 步：确保窗口视觉隐藏（划出段结束时理应已经是 0，这里再写一次抵消累积误差）
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
      snap()
      return
    }

    const entranceStart = Date.now()

    function entranceFrame(): void {
      try {
        if (win.isDestroyed()) {
          stopAndUntrack()
          return
        }

        const t = Math.min((Date.now() - entranceStart) / ENTRANCE_DURATION_MS, 1)

        if (t >= 1) {
          // 动画结束：最后一帧写死 target 本身、opacity 恰好为 1，不写插值结果，抵消
          // 累积误差。这是本模块唯一真正的保险——不论前面补间过程发生了什么，最终
          // bounds/opacity 恒等于 target/1
          win.setBounds(target)
          win.setOpacity(1)
          stopAndUntrack()
          return
        }

        // 宽高全程等于 target 的宽高，只补间 x/y + opacity——若第 2 步之后仍有迟到的
        // WM_DPICHANGED 试图改尺寸，这里每一帧都会把宽高重新写回 target，覆盖掉那次改动
        const { x, y, opacity } = interpolateFrame(settledStart, target, t, easeEntrance)
        win.setBounds({ x, y, width: target.width, height: target.height })
        win.setOpacity(opacity)
        timer = setTimeout(entranceFrame, FRAME_MS)
      } catch (err) {
        // 异常兜底：帧函数整体包 try/catch，任何抛错都不能把窗口留在半路或半透明
        console.error('[WindowAnimation] entrance frame failed, snapping to target:', err)
        snap()
      }
    }

    timer = setTimeout(entranceFrame, 0)
  }

  timer = setTimeout(exitFrame, 0)
  return snap
}
