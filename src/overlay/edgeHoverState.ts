// 悬浮窗 EDGE hover 展开的渲染层纯状态机（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机
// （Desktop Presence，四阶段重设计）」"鼠标 hover Edge 可让角色临时展开，但 EDGE_HOVERED
// 不进入桌面呈现状态机，只是悬浮窗内部 UI 的 transient state，鼠标移开即收起"）。与
// portraitState.ts/transitionState.ts 同一约定：本文件不含任何 DOM/定时器副作用，
// OverlayApp.tsx 只调用这里的纯函数、自己持有 setTimeout 本身（跟已有的
// transitionTimerRef/handleHideTimerRef 同一套写法）——这个仓库没有渲染层测试基础设施，
// 把决策收在纯函数模块里是唯一可测的办法。
//
// 渲染层只负责"现在算不算 hover"这一件事，真正决定窗口该摆在哪、要不要真的移动，是主进程
// electron/main/windowBehavior.ts 的 requestOverlayEdgeHover（含"不是 EDGE 时忽略"这条守卫）
// ——本文件的输出只是"逻辑上的展开态"与"要不要据此向主进程发一次请求"，不直接操纵任何
// 窗口几何。

export interface EdgeHoverState {
  // 逻辑上的展开态：true 表示"当前应该展开"。进入后立即为 true；离开后不立即变 false，
  // 而是等 pendingCollapseAt 到期才变——见下方 onEdgeHoverLeave/onEdgeHoverDebounceElapsed
  expanded: boolean
  // 排队中的收起绝对时刻；null 表示当前没有排队中的收起。存绝对时刻而不是剩余 ms，跟
  // transitionState.ts isTransitionLocked 的 lockedUntil 同一个理由：判断"是否已到期"只
  // 依赖这个值与调用时传入的 now，不依赖 setTimeout 回调是否已经先一步把这次判断作废
  pendingCollapseAt: number | null
}

export const INITIAL_EDGE_HOVER_STATE: EdgeHoverState = { expanded: false, pendingCollapseAt: null }

// 离开后延迟多久才真正收起。
//
// 再次更正（第三次 rework，integration-reviewer 指出上一版注释的前提又被这一轮改动推翻了）：
// 上一版这里论证"EDGE/hover 之间的每一次迁移都是同屏，animateTo 的 sameDisplay 守卫会把它变成
// 一次没有任何插值帧的**瞬间** setBounds，不存在"逐渐"这回事"，并据此把"命中区跟着漂移"这条
// 理由整个否定掉。这个前提现在不成立了：windowAnimation.ts 不再把 sameDisplay 短路成瞬间跳变，
// EDGE 进入/退出/hover 展开收起这三种过渡（全部同屏，见 runPetEdgeController 调用点注释）现在都走
// 新增的同屏补间（tweenFrame），播放 SAME_DISPLAY_TWEEN_DURATION_MS（160ms）的插值动画——窗口
// 真的会在这段时间里逐帧滑动。
//
// 于是"命中区漂移"这条理由重新成立，而且现在是真实机制的一部分：光标在 mouseleave 触发的那一刻
// 是静止的，但窗口本身在接下来的 160ms 里持续移动，原本固定在窗口某个偏移量上的拖拽手柄/贴边
// 命中区跟着一起挪动，光标底下的可交互区域因此在这段时间内确实会漂移，不是这里的旧注释以为的
// 那种从一开始就不存在的中间态。
//
// 但这不是这个 400ms 存在的唯一理由，甚至不是主要理由——真正驱动它的仍然是 mouseleave 本身的
// 语义问题：它不代表"光标已经真的离开、不会再回来"，在相邻 DOM 元素之间的正常指针移动中就会
// 触发（光标从立绘移到旁边的拖拽手柄，途中必然先经过立绘的 mouseleave；与 OverlayApp.tsx 现有
// 的 scheduleHandleHide 400ms 是同一类问题，见该函数定义处"离开立绘后延迟隐藏，否则光标从立绘
// 移到手柄的途中手柄会在指针底下消失"）。若不做防抖，这一次转瞬即逝的 leave 会立刻让主进程把
// 窗口收回贴边位置（现在还会连带播放一次收起动画）；若光标随即又移回来，下一次 enter 会让它
// 立刻再展开，制造一次可见的展开→收起→展开来回抖动。防抖吸收的正是这种"短暂离开"：只要离开
// 时长不超过 400ms，expanded 就保持不变，只有光标确实离开够久，才真正提交收起。
//
// 400ms 必须舒适地盖过 SAME_DISPLAY_TWEEN_DURATION_MS（160ms）——这是"命中区漂移"这条理由重新
// 成立之后带来的新约束：收起动画本身要跑满 160ms，如果防抖时长逼近甚至短于这个数字，一次
// "离开又很快移回"的正常指针轨迹可能在收起动画播放到一半时就被打断，制造观感更差的"收一半又
// 展开回去"。400ms 相对 160ms 有充足余量（2.5 倍），同时仍然复用 OverlayApp.tsx
// scheduleHandleHide 已经校准过的同一个值，而不是另起一个未经验证的新常量——两处要挡的都是
// "给光标在相邻可交互元素之间转移留出余地"这同一类问题，没有理由认为这里需要一个不同的时长
export const EDGE_HOVER_LEAVE_DEBOUNCE_MS = 400

// 光标进入可视贴边区域：立即展开，取消任何排队中的收起。理由跟 OverlayApp.tsx 现有的
// handlePortraitMouseEnter（立即 setIsHandleVisible(true) + 清掉隐藏定时器）一致——进入是
// 即时反馈，不需要防抖；防抖只发生在离开这一侧（见下方 onEdgeHoverLeave）。参数里的
// previous 目前用不到（无论之前是什么状态，结果都一样），仍然接收它是为了让这一组四个
// 函数的签名风格一致，调用方不需要记住"哪几个要传 previous、哪几个不用"
export function onEdgeHoverEnter(_previous: EdgeHoverState): EdgeHoverState {
  return { expanded: true, pendingCollapseAt: null }
}

// 光标离开：不立即收起，而是排一个 now + debounceMs 之后的收起时刻——expanded 本身在到期
// 之前保持不变，真正翻转要等 onEdgeHoverDebounceElapsed 判定"确实到期了"才发生
export function onEdgeHoverLeave(previous: EdgeHoverState, now: number, debounceMs: number): EdgeHoverState {
  return { ...previous, pendingCollapseAt: now + debounceMs }
}

// 供调用方的一次性定时器到点时调用（同 scheduleHandleHide 到点时的检查写法）。只有排队的
// 收起时刻确实到期、且没有被之后一次 onEdgeHoverEnter 取消（pendingCollapseAt 已被那次
// 调用清成 null）时才真正收起；否则原样返回原状态——调用方不需要在设置下一个 setTimeout
// 之前反查"这次到点是不是还作数"，被抢占的到点调用在这里是安全的 no-op
export function onEdgeHoverDebounceElapsed(state: EdgeHoverState, now: number): EdgeHoverState {
  if (state.pendingCollapseAt === null) return state
  if (now < state.pendingCollapseAt) return state
  return { expanded: false, pendingCollapseAt: null }
}

// presence 离开 EDGE 时的强制复位（TDD 原文"鼠标移开即收起"，隐含的另一半是：presence
// 本身不再是 EDGE 时，这份 transient 状态更不能继续存在——它绝不能在下一次重新进入 EDGE
// 时带着上一个 episode 的展开状态）。不管调用前处于什么状态，一律回到初始值；调用方
// （OverlayApp.tsx）还需要自己清掉对应的 setTimeout，这里只负责状态本身，不做副作用
export function resetEdgeHoverOnPresenceLeftEdge(): EdgeHoverState {
  return INITIAL_EDGE_HOVER_STATE
}

// 是否需要把这次状态变化上报给主进程：只在"逻辑上的展开态"真的翻转时才需要——这正是任务书
// 原文"光标掠过贴边条带不应该产生一连串展开/收起请求"要挡的事：enter 在已经展开时重复
// 调用（例如短暂离开又立刻回来，pendingCollapseAt 被取消但 expanded 本来就还是 true）不
// 应该被当成一次新的变化上报出去，因为对主进程而言目标 bounds 完全没变
export function edgeHoverExpandedChanged(previous: EdgeHoverState, next: EdgeHoverState): boolean {
  return previous.expanded !== next.expanded
}

// 贴边手柄抑制（第二次 rework，electron-renderer-reviewer NEEDS REWORK 项 FIX 1，docs/
// MintBot_TDD.md 约 1325 行「拖拽的实现方式」附「已确认发生，已处置」两条 + Stage 3「Edge
// Placement」一节；第三次 rework，Resolver/Controller 边界修正，「安全门可以同时看 intent 与
// fact」一节）。
//
// 已核实的几何：computeEdgeBounds（electron/main/desktopPresence.ts）对 edgeSide === 'left' 算出
// x = displayBounds.x - (width - EDGE_VISIBLE_SLIVER_PX)——以默认尺寸 132×132、sliver 40px 为例，
// 可视条带是窗口最右侧的 40px。而拖拽手柄固定在 `top: 2px; right: 2px; width/height: 20px`
// （overlay.css），正好落在窗口右上角——即可视条带内。手柄是 `-webkit-app-region: drag`，
// 这类区域在 WM_NCHITTEST 层面就把指针事件吞掉（electron#13534，overlay.css/本文件头注释已经
// 反复引用的同一条平台限制），用户从贴边条带的自然方向（顶部，正是手柄占据的方向）靠近时，
// onMouseEnter/onMouseLeave 根本不会派发到 DOM——hover 展开这个功能被它自己的手柄堵死。
//
// 第三次 rework：第一个参数从"渲染层自己按 presence === 'EDGE' 推导"改为直接消费主进程算好的
// `handleSuppressed`（`desktop-presence:changed` 广播新增字段，见
// electron/main/desktopPresence.ts computeHandleSuppressed 定义处注释）——安全门现在同时读
// latestDesired 与 applied（intent ∪ fact），只有主进程同时持有这两份状态，渲染层不再自己用
// presence 猜。但 EDGE_HOVERED 本身仍然是"不进入桌面呈现状态机"的纯渲染层 transient
// state（TDD 原文），主进程的 handleSuppressed 天生不知道、也不该知道它——因此这里仍然需要
// 本地的 edgeExpanded 去解除主进程那条更宽的安全门：hover 展开、窗口确实已经在完整可见的
// bounds 上时，抓着它拖走不构成安全问题，即便 handleSuppressed 因为 presence 仍是 EDGE 而
// 继续为 true。两个条件用 AND 连接（handleSuppressed && !edgeExpanded）：主进程说"不安全"是
// 必要条件，本地展开态只是在那基础上的一个例外豁免，不能反过来靠本地状态覆盖主进程的判断。
//
// 与既有的"交互锁生效时手柄转 no-drag"规则（OverlayApp.tsx isLocked、overlay.css
// .overlay-root--locked .overlay-drag-handle）不冲突、不互相覆盖：两条规则各自独立成立，
// OverlayApp.tsx 用各自独立的 class 表达，isLocked 与这里的抑制结果谁为真都不需要另一个也为真，
// 都只是让手柄多一条"必须 no-drag"的理由，不存在谁覆盖谁的问题
export function isDragHandleSuppressedByEdge(mainHandleSuppressed: boolean, edgeExpanded: boolean): boolean {
  return mainHandleSuppressed && !edgeExpanded
}
