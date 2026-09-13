import type { DisplayStateMap } from './displayStateMap'
import type { Bounds } from './windowPositions'

// Stage 2（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机（Desktop Presence，四阶段重设计）」，
// 阶段②）：Pet/Chat 的 Resolver + Desired/Applied diff，取代 windowBehavior.ts 里已删除的
// decideDodge/decideDodgeClear/shouldSkipOverlayDodge/endDodgeEpisodeIfLeavingDodgeMode 那一整套
// episode 欠债模型（见该文件顶部注释）。本文件只放纯函数——不碰 BrowserWindow/screen，
// 跟 displayStateMap.ts 是同一个约定：真正读 getDisplayStateMap()/screen.getAllDisplays() 并
// 把这里的返回值应用到真实窗口的编排逻辑在 windowBehavior.ts。
//
// 核心设计：resolveChatDesiredState 完全不接收"窗口当前实际所在显示器"这个参数——只吃
// preferredDisplayId（home，持久化）+ 当前 blocker 状态 + 显示器列表，不带任何"上一次算出
// 什么"的记忆。这正是 TDD 原文"取消「Episode 欠债」模型"一节的要求：desired 状态永远从 home
// 重新推导，不是从"上次挪到哪"增量调整。它的直接推论就是 TDD 记录的"已确认的推论"——用户在
// 避难期间把小人拖到 D，A 的冲突一旦解除，下一次 resolve 恒定重新算出"home 空了 → 回 home"，
// 与它这一刻实际停在哪无关。见本文件测试里专门验证这条推论的用例。
//
// Stage 3：resolvePetDesiredState 新增了 currentDisplayId 参数，但这条"从 home 重新推导"的
// 不变量在非交互分支下原样保持——currentDisplayId 只在 isInteracting 为真（ACTIVE 分支）时
// 被读取，AMBIENT/EDGE/HIDDEN 三个分支完全不看它，见该函数定义处注释

// Pet Presence（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"Presence 与 Placement 是两条
// 正交的轴"一节）：Stage 3 补齐 ACTIVE（交互中）与 EDGE（贴边）——见 resolvePetDesiredState
// 决策树最前面的"交互中？"分支与"无处可去"分支里按 severity 拆出的 EDGE
export type PetPresence = 'ACTIVE' | 'AMBIENT' | 'EDGE' | 'HIDDEN'
export type ChatPresence = 'SHOWN' | 'NORMAL' | 'SUPPRESSED'

// 贴边方向。只有两个取值——第一版不做窗口避障，只按 Pet 当前位置离哪块屏边更近二选一
// （见 resolveEdgeSide）
export type EdgeSide = 'left' | 'right'

// Resolver 的输出里带上 alwaysOnTop，而不是让 Controller 自己推导——置顶态和 presence/
// displayId 一样是"状态机现在想要什么"的一部分。
//
// Pet 恒定置顶：小人作为桌宠本来就是悬浮在桌面上的，这不是用户需要控制的维度（petAlwaysOnTop
// 刻意不暴露，用户控制的是 petAvoidanceEnabled）。唯一的例外是 HIDDEN——一个隐藏的窗口留在
// topmost 组里没有意义。
//
// edge side 不在这里决定：这个纯函数没有窗口几何，由 Controller 从真实 bounds 现算
// （resolveEdgeSide/resolveStableEdgeSide）。
export interface DesiredPetState {
  presence: PetPresence
  displayId: number
  alwaysOnTop: boolean
}

export interface DesiredChatState {
  presence: ChatPresence
  displayId: number
  alwaysOnTop: boolean
}

// 在 candidateDisplayIds 里找一块 excludeDisplayId 之外、且没有 blocker 的显示器。多个符合
// 条件时取数值最小的 id——纯粹是为了让结果是一个不依赖调用方数组遍历顺序的确定性选择
// （screen.getAllDisplays() 的返回顺序不保证跨调用稳定），不代表 id 数值本身有任何业务
// 含义，跟 displayStateMap.ts 的 pickPrecedentBlocker 用 pid 做 tie-break 是同一个理由。
// 这份确定性也是 resolver "相同输入 → 相同输出"、从而让 diff 能正确判断"desired 没变"的
// 必要条件——如果 tie-break 依赖遍历顺序，同一份 blocker 状态在两次调用里可能选出不同的
// 自由屏，产生假性的"desired 变了"，触发不必要的 Electron 调用
function pickFreeDisplay(allDisplayIds: readonly number[], excludeDisplayId: number, map: DisplayStateMap): number | null {
  let best: number | null = null
  for (const id of allDisplayIds) {
    if (id === excludeDisplayId || map.has(id)) continue
    if (best === null || id < best) best = id
  }
  return best
}

// Pet Resolver（docs/MintBot_TDD.md 同节"Pet Resolver 的决策顺序"一节）。Stage 3 补齐决策树的
// 前后两端：最前面的"交互中？"分支（isInteracting，见下）先于一切其它判断——ACTIVE 是用户的
// 显式动作，不因为任何 severity 的 blocker 被中途降级；"无处可去"分支不再恒定 HIDDEN，改为
// 读 displayStateMap.get(preferredDisplayId)!.severity，'soft' → EDGE，'hard' → HIDDEN。
//
// isInteracting 由调用方传入（当前唯一来源是 windowBehavior.ts 的
// isWindowDragInProgress('overlay')，见该文件调用点）——本函数依旧保持纯，不读取
// electron/main/dragActivity.ts 的任何状态；
// 未来"点击中""主动交互进行中"等来源接入时，调用方只需要把它们一并 OR 进这一个布尔值，这个
// 签名不需要再变。
//
// currentDisplayId 同样由调用方传入，只在 isInteracting 为真时使用——它是"这个窗口这一刻
// 实际所在的显示器"（调用方传入 appliedDisplayIdFor('overlay') ?? preferredDisplayId，理由
// 见调用点），不是 preferredDisplayId、也不是任何 relocate 目标。ACTIVE 分支报告它而不是
// 别的值，是为了让 diffPetState 算出的 desired.displayId 恒等于它同时读到的 appliedDisplayId，
// 从结构上产生不出一次 move——移动一个用户正抓着的窗口正是 Stage 2 拖拽守卫本来就要挡住的
// 事，让 resolver 自己就报告"不需要动"，比只指望调用方那道守卫兜底更彻底
export function resolvePetDesiredState(
  isInteracting: boolean,
  currentDisplayId: number,
  preferredDisplayId: number,
  displayStateMap: DisplayStateMap,
  allDisplayIds: readonly number[],
  avoidanceEnabled: boolean = true
): DesiredPetState {
  // 决策树最前一档：交互中 → ACTIVE，不看任何 blocker。用户正在直接操作角色（TDD 原文：
  // "不因为一个 soft blocker 在交互过程中突然缩进边缘"），这条判断必须排在"当前屏是否空闲"
  // 之前，且不允许被后面任何分支覆盖——avoidanceEnabled 同样不影响这一档：拖拽是否要移动
  // 窗口与"要不要智能避让"是两个正交维度，用户此刻正抓着窗口，不该被后面任何一档覆盖
  if (isInteracting) {
    return { presence: 'ACTIVE', displayId: currentDisplayId, alwaysOnTop: true }
  }

  // petAvoidanceEnabled 语义（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"petAvoidanceEnabled
  // 的语义：先退出托管，再停止策略（阶段④）"）：关闭后 Pet 完全忽略 fullscreen/blocker，恒定
  // 停留在 home、按用户手动位置存在——这里提前返回，从头到尾不读 displayStateMap 的任何字段。
  // 这正是"从此忽略 fullscreen/blocker 对 Pet 的自动行为"这条不变量在纯函数层的落地：调用方
  // （windowBehavior.ts）不需要、也不能绕过这里另外实现一条命令式恢复路径——只要这里老老实实
  // 返回 AMBIENT@home，diff（diffPetState）与 EDGE 收敛（runPetEdgeController）就会按照
  // Resolver/Controller 模型自然产生"取消隐藏 / 取消贴边 / 搬回家"这些副作用，见该文件测试里
  // "关闭 petAvoidanceEnabled 时退出所有 avoidance 状态"一组用例
  if (!avoidanceEnabled) {
    return { presence: 'AMBIENT', displayId: preferredDisplayId, alwaysOnTop: true }
  }

  if (!displayStateMap.has(preferredDisplayId)) {
    return { presence: 'AMBIENT', displayId: preferredDisplayId, alwaysOnTop: true }
  }

  const free = pickFreeDisplay(allDisplayIds, preferredDisplayId, displayStateMap)
  if (free !== null) {
    return { presence: 'AMBIENT', displayId: free, alwaysOnTop: true }
  }

  // "无处可去"：home 被挡、也没有别的空闲屏。读 home 这个 blocker 的 severity——soft 时降级为
  // EDGE（贴边露一角，陪伴感继续存在），hard 时才是 HIDDEN（彻底退出）。displayStateMap.has
  // (preferredDisplayId) 在上面已经确认为真，这里的 get(...)! 安全
  const severity = displayStateMap.get(preferredDisplayId)!.severity
  if (severity === 'soft') {
    return { presence: 'EDGE', displayId: preferredDisplayId, alwaysOnTop: true }
  }
  return { presence: 'HIDDEN', displayId: preferredDisplayId, alwaysOnTop: false }
}

// Chat Resolver（同上引用，"Chat Window 不使用 Pet 的状态机"一节）。与 Pet 共用同一份
// DisplayStateMap，但决策不同——Chat 没有 EDGE，且"无处可去"时按 severity 区分 NORMAL/
// SUPPRESSED（Pet 在 Stage 2 collapse 掉的这一档，Chat 从一开始就要区分：TDD 原文明确写了
// "无空闲屏 + soft → 取消置顶...无空闲屏 + hard → SUPPRESSED"，不是 Stage 3 才加的区分）。
//
// severity 目前恒为 'hard'（displayStateMap.ts 的 REASON_SEVERITY 表，Stage 4 才会引入真正
// 的 soft reason），所以下面的 'soft' 分支在完整流水线里今天走不到，只能像
// displayStateMap.ts 的 pickPrecedentBlocker 那样直接单测——见该文件同类注释
export function resolveChatDesiredState(
  preferredDisplayId: number,
  displayStateMap: DisplayStateMap,
  allDisplayIds: readonly number[]
): DesiredChatState {
  const blocker = displayStateMap.get(preferredDisplayId)
  if (!blocker) {
    return { presence: 'SHOWN', displayId: preferredDisplayId, alwaysOnTop: true }
  }

  const free = pickFreeDisplay(allDisplayIds, preferredDisplayId, displayStateMap)
  if (free !== null) {
    return { presence: 'SHOWN', displayId: free, alwaysOnTop: true }
  }

  // 无空闲屏 + soft：留在原地但取消置顶，给被挡的应用让出 z-order（§28）
  if (blocker.severity === 'soft') {
    return { presence: 'NORMAL', displayId: preferredDisplayId, alwaysOnTop: false }
  }
  return { presence: 'SUPPRESSED', displayId: preferredDisplayId, alwaysOnTop: false }
}

export interface PetTransition {
  move: number | null
  visibility: 'show' | 'hide' | null
}

// Desired vs Applied 的 diff（TDD 同节"取消「Episode 欠债」模型，改为 Desired / Applied
// diff"）。appliedDisplayId 是"上一次真正执行过移动的目标显示器"（null = 从未执行过，例如
// 刚启动）；isCurrentlyVisible/chatFocused 直接查真实窗口状态，不用记忆值——查询
// BrowserWindow.isVisible()/isFocused() 本身是廉价的同步调用，没有理由为它们单独维护一份
// 可能跟真实状态脱节的缓存（这正是旧模型"欠一次 show()"这类记账容易漂移的根源）。
//
// move 与 visibility 各自独立判断。move 的例外分支——"现在可见、接下来要隐藏"——是刻意的：
// 移动一个即将消失的窗口只会制造一次可见的"先飞过去、再消失"的瑕疵，没有任何用户能感知到
// 的好处。其余三种组合（隐藏中改变目标 / 隐藏→显示 / 显示中改变目标）都正常移动：前两者
// 移动时窗口本就不可见或即将变为可见，不存在这个瑕疵；第三种就是"关联显示器之间可见迁移"
// 本身，移动动画正是它的呈现方式。跳过移动的那一支里，调用方不应该更新 appliedDisplayId——
// 窗口物理上仍在原来的显示器，下一次它需要重新出现时，diff 会正确地发现目标仍然不同,
// 从而正确移动过去；如果错误地把 appliedDisplayId 更新成"跳过的那个目标"，会产生"以为已经
// 在对的位置"的假象，导致它下次显示时其实还停在旧显示器上

// Presence 决定可见性：只有 HIDDEN 不可见，其余全部可见（ACTIVE/AMBIENT 早已如此，Stage 3
// 新增的 EDGE 同样可见——"贴边露一角"本身就是"仍然可见，只是收窄"，见 TDD 原文"减少遮挡但
// 仍让用户感知角色存在"）。用集合而不是逐个 === 比较：旧版本这里写的是
// `desired.presence === 'AMBIENT'`，Stage 2 时唯一的可见 Presence 恰好只有 AMBIENT 所以没
// 暴露问题，但那个写法对"新增一个同样可见的 Presence"没有任何防御——加 EDGE 时如果继续沿用
// `=== 'AMBIENT'`，EDGE 会被静默判成不可见，这里改成"只有 HIDDEN 除外"，未来再新增可见
// Presence 时这里不需要跟着改
const HIDDEN_PET_PRESENCES: ReadonlySet<PetPresence> = new Set(['HIDDEN'])

export function diffPetState(
  desired: DesiredPetState,
  appliedDisplayId: number | null,
  isCurrentlyVisible: boolean,
  chatFocused: boolean
): PetTransition {
  const desiredVisible = !HIDDEN_PET_PRESENCES.has(desired.presence)
  const skipMoveBecauseHiding = isCurrentlyVisible && !desiredVisible
  const move = !skipMoveBecauseHiding && desired.displayId !== appliedDisplayId ? desired.displayId : null

  let visibility: 'show' | 'hide' | null = null
  // chatFocused 只抑制"显示"这一侧，不抑制"隐藏"那一侧——聊天窗口持有焦点时不能把悬浮窗
  // 显示出来（既有约定：焦点回到聊天窗口时收起悬浮窗），但如果这一刻 desired 已经变成
  // HIDDEN，该隐藏还是要隐藏，不受 chatFocused 影响
  if (desiredVisible && !isCurrentlyVisible && !chatFocused) visibility = 'show'
  else if (!desiredVisible && isCurrentlyVisible) visibility = 'hide'

  return { move, visibility }
}

// ---------------------------------------------------------------------------------------------
// EDGE placement（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"Edge Placement：贴边，不做窗口
// 避障"一节）：第一版不做避障算法，也不找"IDE 哪边没有内容"，只按 Pet 当前位置离哪块屏边更近
// 二选一，尽量保留原 Y、只改 X。三个纯函数——离哪边近、side 的稳定性规则、算出贴边后的
// bounds——都不知道"上一次算出的 side 是什么"这类历史；那份记忆由调用方
// （windowBehavior.ts）持有，见 resolveStableEdgeSide 定义处注释。
// ---------------------------------------------------------------------------------------------

// 贴边可视宽度：TDD 原文给出的第一版范围是"15%~30% 可视宽度，具体由素材与 hitbox 决定"。
// 悬浮窗默认尺寸是 132×132（windowPositions.ts DEFAULT_WINDOW_SIZE.overlay），区间上限
// 30% ≈ 40px——取上限而不是区间中段，是因为这条尾巴还要在后续任务里充当 hover 展开的命中
// 目标（本任务书明确要求"必须保留足够大，可以作为后续任务的 hover 命中目标"），命中区偏
// 宽松比偏窄更安全。这不是钉死的架构结论，日后素材尺寸/hitbox 有实测数据时应回来重新校准
export const EDGE_VISIBLE_SLIVER_PX = 40

// 离哪块屏边更近，纯按几何位置判断（TDD 原文："resolveEdgeSide() 第一版直接按 Pet 当前位置
// 决定（离左边近 → left，离右边近 → right）"）。用 Pet 的水平中点而不是左边缘/右边缘本身
// 跟显示器水平中点比较——两者代数等价（中点比中点 <=> 到左边距离比到右边距离），但这个写法
// 不必分别算两段距离再比大小，也天然对称。
//
// 精确落在正中间（两侧距离相等）时约定固定选 'left'——EdgeSide 联合类型按字面量顺序把 'left'
// 排在前面，除此之外没有任何别的业务含义；只是必须选一个、且必须在两次调用间保持确定（同一份
// 输入不能有时候吐 left、有时候吐 right），选哪个都对，这里选的是"看起来更符合直觉的默认值"，
// 不是推导出来的结论
export function resolveEdgeSide(petBounds: Bounds, displayBounds: Bounds): EdgeSide {
  const petCenterX = petBounds.x + petBounds.width / 2
  const displayCenterX = displayBounds.x + displayBounds.width / 2
  return petCenterX <= displayCenterX ? 'left' : 'right'
}

// EDGE SIDE 稳定性（TDD 原文明确点名的一条）："Edge side 在一次连续 Edge 状态内保持稳定，
// 除非显示器拓扑变化或用户主动移动——否则角色会因为前台窗口频繁切换而左右横跳"。
//
// 这是本阶段唯一需要"记忆"的地方，但记忆本身（上一次算出的 side）不放在这个纯函数里——
// 持有它是 windowBehavior.ts（编排层）的职责，这个函数只回答"给定这三样东西，这一次该用
// 哪个 side"：
//   previousSide         编排层记的上一次 EDGE 求值用的 side；null 表示这是这次进入 EDGE
//                        以来的第一次求值（或者从未有过上一次）
//   freshlyComputedSide  这一次 resolveEdgeSide() 现算出来的值
//   episodeStillActive   上一次 evaluate 的 presence 是否也是 EDGE——由编排层判断（它知道
//                        上一次的 presence 是什么），这个函数本身不持有任何跨调用的历史
//
// episode 仍在继续、且有一个非 null 的 previousSide 时，原样返回 previousSide，忽略这一次
// 现算的结果——这正是"稳定"的含义。显示器拓扑变化或用户主动把窗口移动到别处之后，编排层会把
// previousSide 清成 null 或判定 episodeStillActive 为假（例如离开过 EDGE 又重新进入），
// 才会落到下面重新采纳 freshlyComputedSide 的分支
export function resolveStableEdgeSide(
  previousSide: EdgeSide | null,
  freshlyComputedSide: EdgeSide,
  episodeStillActive: boolean
): EdgeSide {
  if (episodeStillActive && previousSide !== null) return previousSide
  return freshlyComputedSide
}

// 贴边后的 bounds：只改 X，Y 与宽高全部保留 currentBounds 原值（TDD 原文："进入 Edge 时尽量
// 保留原 Y 坐标、只改 X"）。displayBounds 必须是这块显示器的物理 bounds（不是 workArea）——
// 贴边本身就是让窗口大部分移出显示器物理边界，任务栏厚度这类 workArea 概念在这里不适用。
//
// 不假设 displayBounds.x === 0：次屏的物理坐标原点通常不在 (0,0)，只在主屏上开发/测试才会
// 恰好看不出这类 off-by-origin 的错误——因此这里全程用 displayBounds.x 做基准，不写死 0
export function computeEdgeBounds(
  currentBounds: Bounds,
  displayBounds: Bounds,
  side: EdgeSide,
  visibleSliverPx: number
): Bounds {
  const x =
    side === 'left'
      ? displayBounds.x - (currentBounds.width - visibleSliverPx)
      : displayBounds.x + displayBounds.width - visibleSliverPx
  return { x, y: currentBounds.y, width: currentBounds.width, height: currentBounds.height }
}

// ---------------------------------------------------------------------------------------------
// EDGE 悬停展开（Stage 3 part 2 任务书 Task 2，docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」
// "鼠标 hover Edge 可让角色临时展开，但 EDGE_HOVERED 不进入桌面呈现状态机……鼠标移开即收起"）。
// 渲染层只负责判断"现在算不算 hover"（见 src/overlay/edgeHoverState.ts），真正决定窗口该摆
// 在哪的仍然是主进程——这个函数就是那个决定：hovered 为真时展开到 fullBounds（没有被 EDGE
// 收窄前的正常可视位置），否则收起到 edgeBounds（贴边位置）。函数本身极薄，但仍然抽出来
// 单测——它是"该不该移动窗口"这条判断链的最后一环，被 runPetEdgeController（常规 evaluate
// 路径）与 requestOverlayEdgeHover（hover IPC 路径，均见 windowBehavior.ts）两个调用点共用，
// 两者必须对"当前该展示成什么样"给出完全一致的答案——唯一让它们一致的办法就是让它们调
// 同一个函数，而不是各自实现一遍同样的三元判断
// ---------------------------------------------------------------------------------------------
export function resolveEdgeHoverBounds(edgeBounds: Bounds, fullBounds: Bounds, hovered: boolean): Bounds {
  return hovered ? fullBounds : edgeBounds
}

// ---------------------------------------------------------------------------------------------
// Presence 广播给渲染层（Stage 3 part 2 任务书 Task 1）：主进程需要把当前 presence（+
// edgeSide）发给悬浮窗渲染层，供渲染层判断"现在是不是 EDGE、能不能响应 hover 展开"。这是
// 一条新增的、单向的 main → renderer 信息通道，不反向影响 resolver 的任何决策——TDD 原文
// 特别强调 EDGE_HOVERED 本身不进入桌面呈现状态机（见"Presence 与 Placement 是两条正交的
// 轴"一节），渲染层只是这条通道的读者，不能反过来驱动它。
//
// "只在变化时广播"的判断本身抽成这个纯函数——持有"上一次广播了什么"这份记忆的是
// windowBehavior.ts 的一个模块级变量（跟 lastAppliedOnTop/appliedChatPresence 那一类幂等
// 缓存同一套写法），这里只回答"这一次该不该广播"。previous 为 null 表示"从未广播过"（例如
// 应用刚启动），此时无条件判定为"变了"——第一次求值出的 presence 永远值得广播一次，不存在
// "上一次和这一次相同所以不用发"这种起点
// ---------------------------------------------------------------------------------------------
export interface PetPresencePayload {
  presence: PetPresence
  // presence 不是 EDGE 时恒为 null——edgeSide 只在贴边状态下才有意义，见
  // windowBehavior.ts 里持有 appliedPetPresence/appliedPetEdgeSide 那份 applied 记忆的既有约定
  edgeSide: EdgeSide | null
  // Resolver/Controller 边界修正（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"安全门可以
  // 同时看 intent 与 fact"一节）：贴边手柄的抑制是安全门，不是"这一刻实际是什么"的描述，因此
  // 不能跟 presence/edgeSide 一样只广播 applied——它必须同时读 latestDesired 与 applied，见
  // computeHandleSuppressed。只有 main 同时持有这两份状态，渲染层不再自己用 presence === 'EDGE'
  // 推导抑制与否，只原样服从这个字段
  handleSuppressed: boolean
}

// 贴边手柄抑制的安全门公式（TDD 原文，逐字照抄）：
//
//   handleSuppressed := latestDesired.presence == EDGE || applied.presence == EDGE
//
// 前沿跟 desired（进入 EDGE 时立即抑制，fail-closed——即使这一刻窗口还没开始收边，也不能让
// 用户抓着一个即将收边的窗口）；后沿跟 applied（退出 EDGE 时，直到窗口真正展开落定才解除
// 抑制，不能提前于窗口实际达到的样子）。两个条件用 OR 连接：任一边为真都要抑制，只有两边
// 都不是 EDGE 时才释放。
//
// 必须传 latestDesired（不是"当前正在 apply 的那个 desired"）：一次跨屏 relocate 或 EDGE
// 归位动画仍在飞的期间，一个新的 EDGE 意图可能已经到达并被存进 latestDesired，若这里读的是
// 更早、可能已经过期的"正在执行中"的那个值，会漏掉这次新意图——这是一个安全门，漏掉就是
// fail-open
export function computeHandleSuppressed(latestDesiredPresence: PetPresence, appliedPresence: PetPresence): boolean {
  return latestDesiredPresence === 'EDGE' || appliedPresence === 'EDGE'
}

export function presencePayloadChanged(previous: PetPresencePayload | null, next: PetPresencePayload): boolean {
  if (previous === null) return true
  return (
    previous.presence !== next.presence ||
    previous.edgeSide !== next.edgeSide ||
    previous.handleSuppressed !== next.handleSuppressed
  )
}

export interface ChatTransition {
  move: number | null
  alwaysOnTop: boolean
  visibility: 'show' | 'hide' | null
}

// 跟 diffPetState 同一套 move/visibility 判断，理由逐字相同（见上方注释），只是 Chat 没有
// chatFocused 这类外部抑制条件，多带一个 alwaysOnTop 位。这个位现在直接来自 desired——它是
// Resolver 的决策（见 DesiredChatState 定义处注释），这里只负责原样转交，不再自己从 presence
// 重新推一遍。两处各推一次是典型的漂移来源：日后新增一档 presence 时，必须同时记得改 Resolver
// 和这里，漏一处就会出现"Resolver 说不置顶、diff 说置顶"
export function diffChatState(
  desired: DesiredChatState,
  appliedDisplayId: number | null,
  isCurrentlyVisible: boolean
): ChatTransition {
  const desiredVisible = desired.presence !== 'SUPPRESSED'
  const skipMoveBecauseHiding = isCurrentlyVisible && !desiredVisible
  const move = !skipMoveBecauseHiding && desired.displayId !== appliedDisplayId ? desired.displayId : null

  let visibility: 'show' | 'hide' | null = null
  if (desiredVisible && !isCurrentlyVisible) visibility = 'show'
  else if (!desiredVisible && isCurrentlyVisible) visibility = 'hide'

  return { move, alwaysOnTop: desired.alwaysOnTop, visibility }
}

// 判断某块显示器此刻能否被"完整摆放"地占据。命名成一个独立概念，而不是在调用点内联
// `!map.has(id)`：Stage 2 里它恰好就是"没有 blocker"，但 Stage 3 引入 soft blocker 后，
// Pet 在 soft blocker 上的答案会变成 EDGE（贴边的一小条），那已经不算"完整摆放"了——到那
// 时只需要改这一个函数本身，调用方（下面 resolveDragOutcome 里所有的合法性判断点）不需要
// 跟着变。它只查已经建好的 DisplayStateMap 里有没有记录，不重新去问"这块屏现在是不是全屏"：
// 探测/校验是 foregroundWorldModel.ts/displayStateMap.ts 的职责，这里只读已经沉淀好的结论
export function canAcceptFullPlacement(displayId: number, map: DisplayStateMap): boolean {
  return !map.has(displayId)
}

// Fix 1（ts-backend-reviewer/integration-reviewer rework）：拖拽落盘（windowBehavior.ts 的
// persistBoundsNow）与 evaluatePetPresence/evaluateChatPresence 必须用同一个"家"的定义，否则
// 会出现"resolver 认为家是 A（含首启从未提交过 home 时的回退大屏），落盘逻辑却因为原始
// preferredDisplayId 是 null 而认为家就是当前落点"这类分歧——具体后果见下面
// deriveDragContext 与本文件测试里"新档案"一组用例。effectiveHomeDisplayId 由调用方统一算好
// 传入（resolveStartupDisplay(screen.getAllDisplays(), getPreferredDisplayId(key)).id，
// 依赖真实 screen，不在这个纯函数模块里算），本函数只负责从它 + appliedDisplayId 推出拖拽
// 判断需要的两个值。appliedDisplayId 为 null（还没有任何 evaluate/拖拽跑过，例如启动后的
// 第一次拖拽）时按"就在家"处理——这是没有更好默认值时唯一站得住的选择，且与
// evaluatePetPresence 首次调用时的 falsy-coalesce 语义一致
export function deriveDragContext(
  appliedDisplayId: number | null,
  effectiveHomeDisplayId: number
): { currentDisplayId: number; temporaryRelocation: boolean } {
  const currentDisplayId = appliedDisplayId ?? effectiveHomeDisplayId
  return { currentDisplayId, temporaryRelocation: currentDisplayId !== effectiveHomeDisplayId }
}

// 静默窗口的延长规则：取「已有到期时刻」与「now + ms」中更晚的一个，只延长、绝不缩短。
// 必要性来自同时存在两种长度截然不同的静默来源——拓扑变化后的 TOPOLOGY_SETTLE_MS（长）与
// 动画完成后的 PROGRAMMATIC_ECHO_TAIL_MS（短）。若写入端无条件覆盖，一次恰好落在拓扑静默
// 窗口内的动画完成，会把剩余的长窗口直接截短成 150ms，于是系统在拔掉显示器后强制重摆窗口
// 发出的 'moved' 又会漏进落盘路径——那正是这个静默窗口要挡的事
export function extendQuietUntil(existingQuietUntil: number, now: number, ms: number): number {
  return Math.max(existingQuietUntil, now + ms)
}

// Fix A（second rework pass）：a single 'moved' event is a programmatic echo — our own
// setBounds, not a user drag — under exactly two, deliberately different, conditions:
//
//   inFlight   an animateTo() call for this window is still running (windowBehavior.ts adds the
//              windowKey to programmaticMoveInFlight before calling animateTo, and removes it in
//              onComplete). While true, we KNOW every 'moved' this window fires is our own —
//              there is no timing guess involved.
//   quietUntil an absolute expiry timestamp (windowBehavior.ts's programmaticQuietUntil map,
//              written by the single markProgrammaticQuiet() writer). Covers the two cases where
//              there is no "animation finished" signal to key off of: ① markProgrammaticWindowPlacement
//              at window construction, where Windows can deliver a late asynchronous
//              WM_DPICHANGED correction with no completion callback (see windowAnimation.ts's
//              electron#27651 note) — PROGRAMMATIC_MOVE_COOLDOWN_MS; ② the short delivery-latency
//              tail after animateTo's onComplete already fired — PROGRAMMATIC_ECHO_TAIL_MS.
//
// Extracted as a pure function (rather than inlined at the two call sites) so the classification
// itself is pinned by unit tests instead of only being exercised indirectly by reading timers —
// same "pure logic lives here, stateful Maps live in windowBehavior.ts" split as deriveDragContext.
export function isProgrammaticMoveEcho(inFlight: boolean, quietUntil: number, now: number): boolean {
  return inFlight || now < quietUntil
}

// Fix 5（ts-backend-reviewer rework）：notePlacement（windowBehavior.ts）"记为可回滚的临时
// 摆放，还是删除记录"这个判断本身是纯逻辑，抽出来单测——真正持有 lastValidPlacement 这个
// Map（有状态）留在 windowBehavior.ts，这里只回答"这块屏是不是家"。跟 deriveDragContext 一样
// 拿 effectiveHomeDisplayId 做参照，不是原始可空的 preferredDisplayId，理由同上
export function isTemporaryPlacement(displayId: number, effectiveHomeDisplayId: number): boolean {
  return displayId !== effectiveHomeDisplayId
}

export type DragOutcome =
  | { kind: 'accept'; newPreferredDisplayId: number | null; boundsWriteDisplayId: number | null }
  | { kind: 'reject' }

// 拖拽终点的合法性校验 + 四行拖拽规则表（docs/MintBot_TDD.md 同节「Placement：用户的「家」与
// 自动避让的位置彻底分离」表格）的落地。在原有四行规则之上新增的要求：临时避难期间，拖拽
// 终点必须先经过一次"这块屏此刻能不能被完整摆放地占据"（canAcceptFullPlacement）的校验，
// 校验不通过就整体拒绝这次拖拽——不写任何偏好，也不写任何 bounds，调用方把窗口原样弹回去。
//
// currentDisplayId 是"这次拖拽开始前，本文件的编排逻辑认为窗口在哪块显示器上"（即上一次
// resolver/拖拽落定的位置，不是这次拖拽的终点）；temporaryRelocation 由调用方按
// currentDisplayId !== preferredDisplayId 算出，不在这里重新推导。
//
// 一块屏此刻能不能落点，唯一依据是它当下有没有 blocker，与这次避难最初从哪块屏逃出来无关。
export function resolveDragOutcome(
  temporaryRelocation: boolean,
  currentDisplayId: number,
  dropDisplayId: number,
  displayStateMap: DisplayStateMap
): DragOutcome {
  if (!temporaryRelocation) {
    // 待在家时的拖拽。不做任何合法性校验——把家搬到一块此刻被挡住的显示器是用户的正当选择
    // （resolver 随后自己会把它挪开），不是这个函数该拦的事，不要在这里"修好"它。
    // 落在原地（家）只更新该屏的 preferredPosition；落到另一块屏 D 则连 preferredDisplayId
    // 本身也一起搬过去——这是唯一会改写"家"的路径
    const droppedOnCurrentDisplay = dropDisplayId === currentDisplayId
    return {
      kind: 'accept',
      newPreferredDisplayId: droppedOnCurrentDisplay ? null : dropDisplayId,
      boundsWriteDisplayId: dropDisplayId,
    }
  }

  // 避难中的拖拽，一条规则覆盖全部落点：先读最新的 DisplayStateMap，目标屏此刻仍被挡就整体
  // 拒绝（调用方把窗口弹回最近一次合法摆放），否则接受。
  //
  // 敢在拖拽这一刻就信任 map，是因为拖拽期间 blocker 的清除已经被收紧成"只认硬证据"
  // （见 displayStateMap.ts 的 conservative 校验模式）——拖拽本身可能因为抢焦点让某块屏上的
  // 全屏程序 isFullscreen 瞬间读成 false，产生一次虚假的"blocker 已清除"，若不收紧，这里会被
  // 这个假信号骗过去，产生一次不该发生的落点。
  if (!canAcceptFullPlacement(dropDisplayId, displayStateMap)) {
    return { kind: 'reject' }
  }

  // 接受。避难期间的任何一次合法落点都只回答一个问题——"如果我暂时待在这块屏，我希望它待在
  // 哪里"，因此一律写这块屏的 preferredPosition，但绝不改写"家"：
  //   拖回已经空出来的 A  →  写 A 的位置。home 本来就是 A，没有字段需要改；避难状态也不需要
  //                         一个独立的"结束"标志——调用方把 appliedDisplayId 设成 A 之后，
  //                         下一次 currentDisplayId !== preferredDisplayId 自然为假。
  //   在避难屏 B 上原地调整 →  写 B 的位置。B 是系统选的落脚点，用户在上面调整过的坐标仍然是
  //                         用户偏好，下次再避难到 B 应该回到这个位置。
  //   拖到第三块屏 C       →  写 C 的位置。只是换了个临时落脚点，不是搬家。
  return { kind: 'accept', newPreferredDisplayId: null, boundsWriteDisplayId: dropDisplayId }
}
