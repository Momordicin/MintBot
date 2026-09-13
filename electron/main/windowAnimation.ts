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
//
// 用户决定（取代此前"同屏一律瞬间 setBounds"的短路，见 docs/MintBot_TDD.md §3.7 阶段④前置
// 事项第 4 条——原文把这个取舍标记为"待定，等阶段④能亲眼看到效果之后再决定"，现在是那个决定）：
// sameDisplay 不再等价于"不要动画"。`animateTo` 现在总是播放动画，只有调用方通过
// `options.instant` 明确要求瞬移时才会跳过——见该参数定义处注释与各调用点（windowBehavior.ts）
// 的取舍说明。跨屏移动仍走本文件的三段式（划出/瞬移/划入，见上文）；同屏移动改走一段更短的
// 直接插值补间（tweenFrame，定义在 animateTo 内部，时长见 SAME_DISPLAY_TWEEN_DURATION_MS）——
// 不复用三段式：三段式的划出/瞬移是为了把一次跨屏瞬移的接缝藏起来，同屏移动根本没有接缝可藏，
// 硬套三段式会变成"飞出去再飞回来"的荒谬效果（EDGE 的语义是"收进去/探出来"，是一次单程滑动）。

const FRAME_MS = 16
// 划出（源屏，淡出+外移）与划入（目标屏，淡入+内移）分别计时——用户决定两段现在对称，
// 都是 250ms、都用同一条减速曲线（easeEntrance，cubic-bezier(0, 0, 0, 1)）。此前划出更短
// （200ms）配加速曲线，让"离开"更利落；现在统一成跟划入一致的观感。两个常量仍然分开
// 导出、分开传给 animateTo 内部的两段 frame 函数——两段用同一个时长/曲线是当前选择，
// 不是耦合在一起：日后想再拉开也只需要改数字/换回各自的缓动函数，不需要动 animateTo
// 内部逻辑
export const EXIT_DURATION_MS = 250
export const ENTRANCE_DURATION_MS = 250

// 同屏补间（tweenFrame，见 animateTo 内部）的时长——刻意不等于 EXIT_DURATION_MS +
// ENTRANCE_DURATION_MS：那个总时长是为了在"划出→瞬移→划入"之间挤出足够时间遮住一次跨屏
// 瞬移，同屏补间没有瞬移要遮，硬套那个时长只会显得拖沓。EDGE 的位移量级本身很小——贴边
// 收窄/展开只挪 EDGE_VISIBLE_SLIVER_PX 附近的像素（desktopPresence.ts），比整段跨屏搬家的
// 位移小得多——时长应该配得上这个位移量级，因此选比单段划出/划入更短的 160ms，读起来是一次
// 干脆的"收进去/探出来"滑动，不是一次缓慢的漂移
export const SAME_DISPLAY_TWEEN_DURATION_MS = 160
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

// animateTo 的前置守卫，抽成纯函数供单测——只依赖显示器 id，可以独立验证，不需要真实
// BrowserWindow/screen（跟 windowPositions.ts 把 pickLargestDisplay/clampBoundsToWorkArea
// 等纯函数从依赖 app.getPath 的部分拆出来单测同一个约定）。animateTo 本体现在也有单测
// 覆盖了（windowAnimation.test.ts），靠 vi.mock('electron', ...) 换一份假的
// BrowserWindow/screen，不再是"不可测，只测这条守卫"——见该测试文件顶部说明。
//
// 同屏移动做「飞出去再飞回来」（三段式）没有意义，所以这条守卫保留——但它现在决定的是
// "该播放哪种动画形状"，不再决定"要不要播放动画"（后者现在完全由调用方的 options.instant
// 决定，见 animateTo 头部注释与文件顶部关于这次改动的说明）。sameDisplay 为真时 animateTo
// 走同屏补间（tweenFrame），为假时走三段式（划出/瞬移/划入）。
//
// 历史（Stage 1 之前）：这里曾经论证过"按当时的调用链它不可达"——animateTo 唯一的调用点
// moveToNonFullscreenDisplay（windowBehavior.ts）只在 decideDodge 判定需要躲避时调用，而
// decideDodge 的排除项恒等于窗口此刻所在的显示器，源屏与目标屏在构造上永不相同。
//
// Stage 2 起这条论证不再成立，守卫因此变得**真实可达**，不只是防御性保留：调用点改名为
// moveToDisplay，由 evaluatePetPresence/evaluateChatPresence（windowBehavior.ts）在
// resolver 判定"目标显示器与上一次不同"时调用。首次评估时（appliedDisplayId 为 null，
// 例如刚启动）窗口往往已经物理停在 resolver 算出的目标显示器上（构造时已按同一套
// windowPositions.ts 规则摆放），这次调用的源屏与目标屏就会相同——这条守卫过去负责把这次
// 调用短路成瞬间 setBounds；现在负责把它导向同屏补间而不是三段式，同样不会产生一次没有
// 意义的划出/划入动画（三段式的划出/划入是为了遮住一次跨屏瞬移，同屏没有瞬移可遮）。
//
// 更早之前（decideDodge 出现之前）这里还举过 restoreHomeBoundsIfLeavingDodgeMode 与
// "冲突解除归位"两个例子——两者都会把窗口飞回冲突前所在的屏幕，也可能命中同屏，随
// episode 欠债模型整体删除（见 windowBehavior.ts 顶部注释）一并成为历史。
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

// 同屏补间（tweenFrame）专用的纯函数——与 interpolateFrame 同样的 clamp+easing 写法，区别
// 只在于它补间全部四个字段（x/y/width/height）而不吐出 opacity：同屏补间全程 opacity 恒为 1
// （窗口本身可见，是一次直接的滑动，不是跨屏那两段"淡出再淡入"），没有 opacity 需要返回；
// width/height 需要参与补间是因为同屏移动不像跨屏移动那样保证宽高全程等于 target 的宽高
// （见 moveToDisplay 的调用点：目标显示器的偏好尺寸可能与窗口当前尺寸不同，即便源屏目标屏
// 是同一块）。不复用 interpolateFrame 本身，而是另写一个同形状的函数，是为了不去改
// interpolateFrame 的返回类型/含义——那个函数专为"划出/划入"两段设计，opacity 字段在那两段
// 里有明确语义，硬塞进 width/height 会让调用方（exitFrame/entranceFrame）也要跟着改
export function interpolateRect(
  from: Electron.Rectangle,
  to: Electron.Rectangle,
  t: number,
  easing: (p: number) => number
): Electron.Rectangle {
  const clamped = Math.min(Math.max(t, 0), 1)
  const eased = easing(clamped)
  return {
    x: Math.round(from.x + (to.x - from.x) * eased),
    y: Math.round(from.y + (to.y - from.y) * eased),
    width: Math.round(from.width + (to.width - from.width) * eased),
    height: Math.round(from.height + (to.height - from.height) * eased),
  }
}

// 返回的 CancelFn 无参数，语义单一：停表并立刻把窗口收尾到 target/opacity 1，调用方永远
// 不必考虑「取消后窗口在哪、是不是还半透明、此刻处在哪一段」。多次调用是安全的
// no-op（第二次起直接返回）——Fix B（second rework pass）之前这个 no-op 保证只由 snap() 内部
// 的 cancelled 标志维护，instant 分支与划入段/同屏补间正常收尾都没有参与，onComplete 因此
// 可能在"调用方保留并重复调用返回值"时被多触发一次；现在这个标志在这个窗口本次调用的所有
// 终态路径上都会置位（instant、同屏补间收尾、跨屏划入段收尾、snap()），见下方声明处注释
//
// onComplete（Fix 4，ts-backend-reviewer/integration-reviewer rework）：在这个窗口的
// setBounds 序列真正跑到终点的那一刻再调用一次——即 instant 分支、同屏补间正常收尾、跨屏
// 划入段正常收尾、以及 snap()（覆盖中断/被新动画抢占/异常收尾这几类提前终止）——而不只是
// 调用方在动画*开始*时记的那一个时间戳。调用方（windowBehavior.ts 的 moveToDisplay/
// persistBoundsNow 回滚路径）用它清掉"程序化移动 in-flight"标记、并开启一段短暂的回声尾巴
// （PROGRAMMATIC_ECHO_TAIL_MS，见 windowBehavior.ts），把冷却期锚定在动画真正结束的这一刻，
// 而不是开始的那一刻
//
// options.instant（取代此前的 sameDisplay 短路，见文件头部关于这次改动的说明）：调用方
// 明确知道这次移动不需要动效时传 true，animateTo 跳过下面所有补间逻辑、同步瞬移到 target。
// 选项对象而不是第四个位置参数的裸 boolean：这个函数的调用点已经不少（windowBehavior.ts
// 四处），裸 boolean 在调用点读起来是"animateTo(win, target, cb, true)"——true 指代什么
// 完全要靠翻这份签名才知道；选项对象在调用点自解释成"animateTo(win, target, cb,
// { instant: true })"，且为将来如果还需要加别的调用方可选项（目前没有，不预先设计）留了
// 自然的扩展位置，不需要再挪动 onComplete 的位置或改调用点的参数个数
export function animateTo(
  win: BrowserWindow,
  target: Electron.Rectangle,
  onComplete?: () => void,
  options?: { instant?: boolean }
): () => void {
  // 新动画先取消同一窗口的旧动画（snap 到旧动画的 target，opacity 收回 1），再从当前位置
  // 起算，这样不需要关心两个动画之间的位置/透明度关系——只取消这一个窗口自己的记录，不影响
  // 另一个窗口可能正在进行的动画（见上面 activeCancels 的注释）。旧动画不论处在哪一段，
  // 取消路径都是同一个 snap()，见下方定义——不存在"某一段的定时器没被清掉"这类遗漏，因为
  // timer 变量与 snap() 是同一组闭包共享的，每一段都写回同一个 timer
  const existingCancel = activeCancels.get(win)
  if (existingCancel) {
    existingCancel()
  }

  // cancelled 必须在下面 isDestroyed 早返回之前声明——那条路径现在也要走 onComplete，见其注释
  let cancelled = false

  // 入口就挡掉已销毁的窗口：下面 getBounds() 对已销毁窗口会同步抛错，而本模块声明的不变式
  // 是「除 isDestroyed() 外，任何退出路径都不让调用方收到异常」。当前调用图下不可达
  // （index.ts 的 closed 监听与置空同步、调用前都有非空判断），但那依赖的是调用方纪律；
  // 这一行让不变式由本模块自己保证，不外包给调用点。
  //
  // 这条路径**也必须调用 onComplete**：它是一条终结路径——这次移动不会发生，之后也不会再有
  // 任何事情发生——而本模块声明的契约是「onComplete 在每一条终结路径上恰好触发一次」。此前
  // 这里直接 return，等于自己违反了自己写下的契约，后果是调用方
  // （windowBehavior.ts beginProgrammaticMove）的「程序化移动进行中」括号**永远不会释放**，
  // 该 windowKey 的 persistBoundsNow 从此被永久压制。这正是上一轮刚修掉的那一类卡死，
  // 只是入口不同。⚠️ 本模块一共有**五处** isDestroyed 检查（本入口、snap()、以及
  // tweenFrame/exitFrame/entranceFrame 三个逐帧检查），每一处都是终结路径、都必须触发
  // onComplete。这里曾经只修了一两处就被声称「已收口」，是错的——改动任意一处时请五处同看
  if (win.isDestroyed()) {
    cancelled = true
    onComplete?.()
    return () => {}
  }

  // Fix B（second rework pass）：this flag now has two jobs, not one. It always guarded snap()
  // itself against firing twice (the module header's "calling the returned cancel function twice
  // is a safe no-op" contract). It now ALSO guards onComplete specifically — onComplete carries a
  // real side effect for callers (windowBehavior.ts clears its "programmatic move in flight"
  // marker and re-arms the echo-tail quiet window in it), so every terminal path must set this
  // flag before calling onComplete, not just snap(). Declared up here (rather than where it used
  // to live, after the sameDisplay branch) so the instant short-circuit below can participate
  // too. Currently latent, not live: both call sites in windowBehavior.ts discard the returned
  // cancel function, so nothing retains it to re-invoke after normal completion — fixed as a
  // contract for the day something does.

  // 调用方明确要求瞬移：不经过下面任何补间路径，是本函数唯一还会产生"没有动画"效果的分支
  // ——取代此前的 sameDisplay 短路（那条短路由 animateTo 自己按显示器 id 推断，调用方无法
  // 覆盖；现在是否瞬移完全是调用方的显式决定，见各调用点在 windowBehavior.ts 里的取舍）。
  // 这里不建立 activeCancels/中断守卫：整个过程在这次调用栈内同步完成，没有什么可中断的，
  // 也没有 timer 需要 stopAndUntrack 清理
  if (options?.instant) {
    const start = win.getBounds()
    // 永久诊断日志（取代此前提交又删除的 DIAG TEMP 调试块，原先挂在 sameDisplay 短路上）：
    // 跳屏/归位/EDGE 事件本身很稀疏，这一行不构成日志噪音，换来的是下一次有人报告"这里
    // 该有动画却是瞬间跳"时能直接从日志里看到是哪次调用传了 instant、start/target 矩形
    // 具体是什么，不用再临时加埋点复现
    console.log(
      `[WindowAnimation] Instant move (caller-requested): ` +
        `start=${start.width}x${start.height}@${start.x},${start.y} -> ` +
        `target=${target.width}x${target.height}@${target.x},${target.y}`
    )
    win.setBounds(target)
    win.setOpacity(1)
    cancelled = true
    onComplete?.()
    return () => {}
  }

  const start = win.getBounds() // 划出段/同屏补间的起点 + 用于判断源屏，供守卫使用
  const srcDisplay = screen.getDisplayMatching(start)
  // ⚠️ 已知限制，不在本次改动范围内修复：dstDisplay 只在调用这一刻读一次，之后整段补间
  // 都无条件收敛到字面意义上的 target 矩形（见文件头的核心不变式）。如果目标显示器在
  // 补间进行中途被拔掉，target 早已不落在任何仍连接的显示器范围内，窗口最终会停在一块
  // 不存在的显示器坐标上——不变式本身仍然成立（bounds 恰好等于 target），只是 target
  // 这时已经失去意义。调用方目前也没有对"目标显示器消失"做特殊处理，这属于更大范围的
  // 显示器热插拔支持，只记录，不在这里处理
  const dstDisplay = screen.getDisplayMatching(target)

  const { sameDisplay } = evaluateAnimationGuards(srcDisplay.id, dstDisplay.id)

  let timer: ReturnType<typeof setTimeout> | null = null

  function removeGuards(): void {
    win.off('minimize', onInterrupt)
    win.off('hide', onInterrupt)
    win.off('close', onInterrupt)
    win.off('closed', onInterrupt)
  }

  // 四类中断里的「最小化/隐藏/关闭」：注册一次性监听，命中即 snap，不论此刻处在同屏补间、
  // 跨屏的划出段、还是划入段——interrupt 监听在整个 animateTo 调用期间只注册一次（覆盖所有
  // 路径/段），而不是每段各注册一次，这样中断处理与"现在走的是哪条路径/哪一段"完全解耦。
  // 动画正常结束时也要调用 removeGuards，否则每次跳屏泄漏 4 个监听器，迟早撞
  // MaxListenersExceededWarning。
  // 用户拖拽不特殊处理：move/moved 事件层面无法区分是用户拖拽还是本模块自己的 setBounds
  // 触发的。三段式跨屏动画总时长从旧版 180ms 涨到 EXIT_DURATION_MS + ENTRANCE_DURATION_MS =
  // 500ms，补间途中真实拖拽窗口标题栏的概率相应变大，不再是"几乎不可能"；同屏补间时长更短
  // （SAME_DISPLAY_TWEEN_DURATION_MS），但同样不做特殊处理——这里仍然刻意不做拖拽中断处理，
  // 那是更大的设计改动，本轮不做。
  //
  // Fix 2（third rework pass，ts-backend-reviewer/integration-reviewer rework）：上一版这里止步于
  // "后果是每帧的 setBounds 会把手动拖出去的位置拉回补间路径上，是可感知的 UX 瑕疵，但动画结束
  // 时位置仍收敛到 target，不是正确性 bug"——这低估了后果，只承认了视觉上的"打架"，没有承认这次
  // 拖拽的*结果*本身会被吞掉：只要这个模块仍持有 activeCancels 里这个窗口的记录，
  // windowBehavior.ts 的 programmaticMoveInFlight 就仍然为真，拖拽期间乃至松手落盘那一下的每一个
  // 'moved' 都会被 isProgrammaticMoveEcho 误判成动画自己的回声而被静默丢弃——不是拉锯之后收敛，
  // 是这次用户放置从未被记录。
  //
  // 修法不在这个模块内部（依然刻意不做拖拽中断处理，理由不变——move/moved 事件层面确实分不清是
  // 谁在动 setBounds），而在调用方：windowBehavior.ts 现在持有每个窗口最近一次 animateTo 返回的
  // 取消函数（activeAnimationCancelFor），electron/main/windowDragMonitor.ts 的
  // WM_ENTERSIZEMOVE 一触发（index.ts 接线）就调用 cancelProgrammaticMoveOnDragStart，在真实
  // 拖拽产生任何 'moved' 之前就把这次程序化动画整个取消、经由本函数的 snap() 收尾并释放
  // in-flight 标记。这条修法在编排层，不改变本函数自身对拖拽的无感知——它只是保证一次真实拖拽
  // 极少会在这里"撞上"一个仍在飞的动画；万一确实撞上（例如两者之间的竞态、或静默尾巴仍在生效），
  // windowBehavior.ts 的 handleWindowMoved 还有第二道独立守卫（isWindowDragInProgress 优先于
  // isProgrammaticMoveEcho），见该函数注释
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
    // 窗口已销毁：不再碰任何原生方法（setBounds/setOpacity 对已销毁窗口会抛错），但**仍然要
    // 调用 onComplete**——这同样是一条终结路径，契约要求每条终结路径恰好触发一次。此前这里
    // 直接 return，与函数入口那条 isDestroyed 早返回是同一个缺陷的两个入口：漏掉 onComplete
    // 会让调用方（windowBehavior.ts beginProgrammaticMove）的括号永不释放，该窗口的
    // persistBoundsNow 从此被永久压制。当前调用图下不可达（生产代码里没有任何地方直接调
    // win.destroy()，销毁一律先经过 'close'，而那时 isDestroyed() 仍为 false、已被中断监听
    // 接走），但同一个文件里留着同一个缺陷的第二个实例，是以后改动窗口销毁策略时必踩的坑
    if (win.isDestroyed()) {
      onComplete?.()
      return
    }
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
    // 不论上面 try 是否抛错都调用：snap() 是这个窗口本次 animateTo 调用的最终收尾，不管是
    // 正常被新动画抢占、四类中断之一、还是异常兜底，都是"这次程序化移动到此为止"的确定时刻
    onComplete?.()
  }

  win.once('minimize', onInterrupt)
  win.once('hide', onInterrupt)
  win.once('close', onInterrupt)
  win.once('closed', onInterrupt)
  // 中断监听注册完成、activeCancels 记录建立完成之后，才开始跑任何有副作用的补间步骤——
  // 划出段本身现在也会改 opacity（1→0），必须在它开始之前就具备"出事能收尾"的能力，
  // 不能像旧设计那样只在瞬移阶段之后才建立这条安全网
  activeCancels.set(win, snap)

  if (sameDisplay) {
    // 同屏补间：一段直接从 start 插值到 target 的滑动，不经过三段式的划出/瞬移——见文件
    // 头部与 evaluateAnimationGuards 定义处关于这次改动的说明。全程 opacity 恒为 1（窗口
    // 从未消失），只用 interpolateRect 补间 x/y/width/height，复用与划出/划入同一条
    // easeEntrance 缓动曲线（本文件唯一的缓动约定，不为这条路径另开一条）
    const tweenStart = Date.now()

    function tweenFrame(): void {
      try {
        // 窗口销毁：同两段跨屏 frame 函数一样的检查。停表之后**必须**走 onComplete——
        // 这是一条终结路径，契约要求每条终结路径恰好触发一次；漏掉它会让调用方
        // （windowBehavior.ts beginProgrammaticMove）的括号永不释放
        if (win.isDestroyed()) {
          stopAndUntrack()
          cancelled = true
          onComplete?.()
          return
        }

        const t = Math.min((Date.now() - tweenStart) / SAME_DISPLAY_TWEEN_DURATION_MS, 1)

        if (t >= 1) {
          // 动画结束：最后一帧写死 target 本身、opacity 恰好为 1，不写插值结果，抵消
          // 累积误差——与跨屏路径的划入段收尾同一个不变式（见该函数同一处注释）
          win.setBounds(target)
          win.setOpacity(1)
          stopAndUntrack()
          cancelled = true
          onComplete?.()
          return
        }

        win.setBounds(interpolateRect(start, target, t, easeEntrance))
        timer = setTimeout(tweenFrame, FRAME_MS)
      } catch (err) {
        // 异常兜底：帧函数整体包 try/catch，任何抛错都不能把窗口留在半路
        console.error('[WindowAnimation] same-display tween frame failed, snapping to target:', err)
        snap()
      }
    }

    timer = setTimeout(tweenFrame, 0)
    return snap
  }

  // 划出段的终点：不是 target，而是窗口当前位置（start）沿"有空间的一侧"外移
  // OFFSET_PX——与划入段共用同一个 computeOffsetStartRect，见该函数注释里"镜像"的含义。
  // 只有跨屏路径需要这个偏移终点，上面的同屏补间路径已经在其分支内 return，不会执行到这里
  const exitEnd = computeOffsetStartRect(start, srcDisplay.workArea)

  const exitStart = Date.now()

  function exitFrame(): void {
    try {
      // 窗口销毁：每帧首先检查，命中不做任何 setBounds/setOpacity（销毁的窗口调用会抛错），
      // 但仍然是一条终结路径，停表之后必须触发 onComplete——理由见函数入口那条 isDestroyed
      // 检查的注释
      if (win.isDestroyed()) {
        stopAndUntrack()
        cancelled = true
        onComplete?.()
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
        // 终结路径，必须触发 onComplete——理由同 exitFrame 里的同款检查
        if (win.isDestroyed()) {
          stopAndUntrack()
          cancelled = true
          onComplete?.()
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
          cancelled = true
          onComplete?.()
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
