import type { ExternalWindowInfo } from './activeWindowMonitor'

// Stage 1 世界模型（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机（Desktop Presence，四阶段
// 重设计）」表格里的阶段①）：把"谁在前台"
// （Foreground，由 activeWindowMonitor.ts 的 ForegroundObservation
// 表达）与"哪块显示器此刻不宜使用"（Display Blocker，本文件的 DisplayStateMap）拆成两个
// 独立概念。本文件只放纯函数 + 数据类型，不碰任何 Win32/Electron 运行时——保持可测试性，
// 跟 windowAnimation.ts/windowBehavior.ts 里"纯函数单独抽出去测"的既有约定一致。
//
// 本文件建立/维护这个模型，由 electron/main/foregroundWorldModel.ts 驱动。Stage 1 完成时
// 还没有任何决策消费方；Stage 2 起 electron/main/windowBehavior.ts 的
// evaluatePetPresence/evaluateChatPresence 通过 foregroundWorldModel.ts 的
// getDisplayStateMap() 读取这里维护的状态，见 electron/main/desktopPresence.ts 的
// resolvePetDesiredState/resolveChatDesiredState

// 两种触发原因：全屏 与 用户规则。Stage 4（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」
// "用户规则先转换成 Desktop Context（阶段④）"）之前，severity 来自一张固定的"原因 → 档位"表，
// 两个 reason 都硬编码成 hard——这正是 EDGE 此前永远不可达的原因。Stage 4 起 severity 不再是
// reason 的函数：全屏检测器仍然恒定贡献 hard（TDD 原文"全屏检测器同样只负责产生
// reason = fullscreen, severity = hard"），但 user-rule 这个 reason 的 severity 现在由命中的
// 具体规则决定（见下方 AppRule/classify）——同一个 reason 标签可能是 soft 也可能是 hard。
// 一个 blocker 仍然允许同时携带多个 reason（例如既全屏、又命中用户规则），severity 取其中
// 最高档——"max severity wins"这条既有约定不变，只是现在的输入是"这次分类实际贡献了哪些
// (reason, severity) 组合"，不再是"reason 标签集合 + 一张静态表"
export type Reason = 'fullscreen' | 'user-rule'
export type Severity = 'soft' | 'hard'

// Stage 4：fullscreenWhitelist/blacklist 两个平行数组被替换成一张"每个应用一条规则"的表——
// 一个 exe 不再可能同时出现在两份互相矛盾的名单里，这类自相矛盾的配置在新模型下根本不可表达。
//   allow — 不产生任何 blocker（取代 fullscreenWhitelist；即使这个窗口此刻确实全屏，allow 也
//           压住整条判断，跟旧版白名单"命中即返回空 reason 集合"的语义完全一致）
//   soft  — Pet 进 EDGE，Chat 取消置顶
//   hard  — Pet HIDDEN，Chat SUPPRESSED（取代 blacklist）
export type AppRuleEffect = 'allow' | 'soft' | 'hard'

export interface AppRule {
  exeName: string
  effect: AppRuleEffect
}

export type DisplayBlocker = {
  hwnd: bigint
  pid: number
  exeName: string | null
  displayId: number
  reasons: Set<Reason>
  severity: Severity
  // Fix D（second rework pass）：consecutive conservative-mode validation passes in a row where
  // this blocker looked like it should clear (see decideBlockerAfterValidation's conservative
  // branch below). Only meaningful during conservative mode; standard mode always keeps it at 0.
  // Defaults to 0 at establishment (applyExternalObservation).
}

// 每块显示器最多一个 blocker；没有 entry 代表"没有已知阻塞源"，这跟 ForegroundObservation
// 的 unavailable（"这一次采样没拿到前台信息"）是两回事，不要混淆——一个是世界模型本身的
// 记录，一个是某一次采样的成败
export type DisplayStateMap = Map<number, DisplayBlocker>

export type BlockingRules = {
  appRules: AppRule[]
}

// 大小写不敏感匹配 exe → 规则，跟 windowBehavior.ts 的 includesIgnoreCase 同一个理由（Windows
// 文件名本身不区分大小写）。本文件刻意不 import windowBehavior.ts 里那份实现——保持这个纯逻辑
// 模块不依赖任何"薄编排层"，依赖方向只应该是 foregroundWorldModel.ts → 本文件，反过来不成立
function findRule(rules: BlockingRules, exeName: string): AppRule | undefined {
  const lower = exeName.toLowerCase()
  return rules.appRules.find(rule => rule.exeName.toLowerCase() === lower)
}

// 一次分类的共同实现，供 applyExternalObservation（建立/刷新）与 decideBlockerAfterValidation
// （复查）共用——两处此前各自重复了一遍"先查白名单、再判断全屏/黑名单"的判断，Stage 4 把它
// 收拢成一份，避免两处对同一条规则给出不一致的结论。
//
// allow 命中时返回空 reasons（不建立/不保留任何 blocker），语义与旧版白名单完全一致：即使这
// 一刻确实全屏，allow 也压住整条判断，不只是压住全屏那一半。
//
// severity 的"max severity wins"composition：全屏检测器恒贡献 hard；命中的规则若是 soft/hard，
// 贡献同名的 severity。**一个被标成 soft 的 app 如果这一刻确实进入全屏，仍然会因为全屏这一条
// 独立贡献而收敛成 hard**——"这个 app 应该永远只得到 soft 待遇，即使全屏也一样"在 v1 里无法
// 表达，这是 TDD 的既定取舍，这里如实实现，不悄悄修正
function classify(
  exeName: string | null,
  isFullscreen: boolean,
  rules: BlockingRules
): { reasons: Set<Reason>; severity: Severity } {
  const rule = exeName !== null ? findRule(rules, exeName) : undefined
  if (rule?.effect === 'allow') return { reasons: new Set(), severity: 'soft' }

  const reasons = new Set<Reason>()
  let severity: Severity = 'soft'
  if (isFullscreen) {
    reasons.add('fullscreen')
    severity = 'hard'
  }
  if (rule) {
    reasons.add('user-rule')
    if (rule.effect === 'hard') severity = 'hard'
  }
  return { reasons, severity }
}

// 把一次 external 观察映射成它*应该*携带的阻塞原因集合——只导出 reasons 这一半，供
// 需要"为什么"而不需要 severity 的调用方使用（目前没有这样的调用方，保留是因为 severity 与
// reasons 概念上分开，未来读 reason 做更细规则时不需要再改这个函数的返回形状，见 TDD
// "Pet Resolver 因此不需要知道...只按 severity 做决策；未来需要更细规则时再读 reason"）
export function classifyBlockingReasons(info: ExternalWindowInfo, rules: BlockingRules): Set<Reason> {
  return classify(info.exeName, info.isFullscreen, rules).reasons
}

// 建立/刷新一块显示器的 blocker。这是"结构上不可能清错"的核心：本函数只有两条路径——
// reasons 为空时原样返回传入的 map（no-op），reasons 非空时只 set 本次观察所在的
// displayId 这一个 key。没有任何分支会删除/触碰 map 里的其它 key，因此"一次不满足阻塞
// 条件的观察，不该清掉别的显示器上的 blocker"这条不变量不需要靠调用方小心遵守来维持——
// 这个函数里根本没有能删除其它 key 的代码路径。清除只由 decideBlockerAfterValidation/
// validateBlockers（证据驱动的校验循环）负责，这里永远不做
export function applyExternalObservation(
  map: DisplayStateMap,
  info: ExternalWindowInfo,
  rules: BlockingRules
): DisplayStateMap {
  // Finding B（Stage 1 review）：pid 未知（GetWindowThreadProcessId 瞬时失败）时不建立任何
  // blocker，而不是拿一个不可靠的 pid 去建立一条记录——DisplayBlocker.pid 的存在理由就是
  // 供 probeBlockerWindow 做 HWND 回收的交叉核对（见 activeWindowMonitor.ts），记一个假 pid
  // 只会让那道核对本身失去意义。no-op（原样返回 map）与下面"reasons 为空"是同一种处理，
  // 两者都是"这次观察不该建立/刷新任何东西"
  if (info.pid === null) return map

  const { reasons, severity } = classify(info.exeName, info.isFullscreen, rules)
  if (reasons.size === 0) return map

  const next = new Map(map)
  next.set(info.displayId, {
    hwnd: info.hwnd,
    pid: info.pid,
    exeName: info.exeName,
    displayId: info.displayId,
    reasons,
    severity,
  })
  return next
}

// 低频校验循环（foregroundWorldModel.ts）对单个已知 blocker 重新探测后的结果。四态而不是
// 布尔值：'gone'（窗口已经不存在）与 'pid-mismatch'（这个 hwnd 数值已经被 Windows 回收、
// 分配给了别的进程）都是"确认这个 blocker 不再成立"的证据，会导致清除；'probe-error' 是
// 第三种、证据强度完全不同的情况——探测本身失败了（异常，或 resolvePid 未能查到 pid），
// 没有查到任何东西，既不是"确认还在"也不是"确认不见了"。见 docs/MintBot_TDD.md §3.7 附
// 「桌面呈现状态机」"消失：由证据清除，不由焦点转移清除"一节："探测失败（无法判定）→
// keep，不得当作 clear"，以及紧随其后 "「探测失败」与「窗口确实没了」必须是两个不同的状态"
// 一段。把它跟前两者分开，是因为 decideBlockerAfterValidation 对它的处理必须不同：
// 'probe-error' 保留 blocker 原样，不清除
export type BlockerProbe =
  | { status: 'gone' }
  | { status: 'pid-mismatch' }
  | { status: 'probe-error' }
  | { status: 'ok'; displayId: number; isFullscreen: boolean }

// 校验模式（新增，供拖拽期间的合法性校验使用，见 electron/main/dragActivity.ts 与
// electron/main/desktopPresence.ts 的 B1 分支）。'standard' 是原有行为；'conservative' 只在
// 用户正在拖拽窗口的这一小段时间内使用——见 decideBlockerAfterValidation 对它的处理
export type ValidationMode = 'standard' | 'conservative'

// Fix D（second rework pass）：how many consecutive conservative-mode passes must agree "this
// blocker should clear" before it actually clears. Conservative mode used to mean "soft evidence
// never clears" — while MintBot itself held the foreground (or a drag was in progress), a blocker
/// conservative 模式的语义：**拖拽期间，软证据永远不清除 blocker，与轮数无关。**
//
// 曾经在这里实现过一版「软证据需要连续 N 轮确认后才清除」（N = 3，约 4.5 秒），当时的论证是
// 「我们抢焦点造成的假读数是亚秒级的，撑不过三轮」。那个论证是错的，用户指出了漏洞：
// **连续三轮同样可能只是因为用户把小人拖了 4.5 秒、被挡的游戏自始至终处于失焦状态。**
// 计数器区分不了「真的切成窗口化了」和「还在被拖着」——也就是说，它恰好会在它本该生效的那个
// 场景里失效。一个在需要它时失效的防线不是更宽松的防线，是无效的防线。
//
// 因此这里不设阈值常量：不是「把 SOFT_CLEAR_CONFIRMATIONS 调到无穷大」，而是根本没有这个旋钮。
// 留一个数字会让后来者以为 3 是可以调成 5 的经验参数，而真实语义里不存在任何可调余地。
//
// 规则本身：
//   拖拽进行中
//     窗口已不存在 / 进程已退出（'gone' / 'pid-mismatch'）→ 清除（硬证据，两种模式一致）
//     isFullscreen 读到 false / 规则重新匹配（软证据）    → **不清除**
//   拖拽结束后
//     下一次正常 validator 恢复 standard 规则，此时软证据照常立即清除

// 校验结果 → 下一个状态，null 代表清除。这是"清除只由证据驱动，不由焦点移开驱动"的落地点：
// - 窗口不存在了 / hwnd 被回收给别的进程 ⇒ 清除（两种模式下都一样——这是用户点名的"硬
//   证据"：窗口不存在了/进程退出了）
// - 仍然存在，但重新核对后已经不再满足任何阻塞条件（比如退出了全屏，且也不在黑名单里，
//   或者规则本身变了、现在命中白名单）⇒ standard 模式立即清除；conservative 模式一律不清除，
//   见上方注释
// - 仍然满足 ⇒ 保留，displayId/reasons/severity 按本次探测结果刷新（这一步顺带处理"窗口被
//   拖到了另一块显示器"——按新的 displayId 重新归属）
// 不存在"这一刻它是不是前台"这个输入，因为 BlockerProbe 根本不携带这个信息——探针只回答
// "这个 hwnd 现在还成立吗"，焦点在哪与此无关，这正是本次重设计要解决的问题
export function decideBlockerAfterValidation(
  blocker: DisplayBlocker,
  probe: BlockerProbe,
  rules: BlockingRules,
  mode: ValidationMode = 'standard'
): DisplayBlocker | null {
  if (probe.status === 'gone' || probe.status === 'pid-mismatch') return null

  // docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」："探测失败（无法判定）→ keep，不得当作
  // clear"：探测失败（异常/pid 解析失败）不是"确认不存在"的证据，因此保留 blocker 原样，
  // 不清除、也不按无法核实的数据重新派生 reasons/severity——跟 'gone'/'pid-mismatch' 那两条
  // "确认消失"的路径必须分开处理，这正是这个状态存在的意义。两种模式下行为一致
  if (probe.status === 'probe-error') return blocker

  // conservative 模式（拖拽进行中，或 MintBot 自己持有前台）下唯一与 standard 分歧的一支。
  // 这里刻意**不重新核对**是否仍满足阻塞条件：核对的唯一输入是 probe.isFullscreen，而这一刻
  // 它正是不可信的那个值——我们自己可能就是它变成 false 的原因。保留 blocker 的 reasons /
  // severity 原样，只刷新 displayId：窗口此刻落在哪块显示器上是探针直接观测到的几何事实，
  // 与焦点无关，刷新它是安全的（这一支也顺带处理「挡路的窗口被拖到了另一块屏」）
  if (mode === 'conservative' && probe.status === 'ok') {
    return { ...blocker, displayId: probe.displayId }
  }

  const { reasons, severity } = classify(blocker.exeName, probe.isFullscreen, rules)
  if (reasons.size === 0) return null

  return { ...blocker, displayId: probe.displayId, reasons, severity }
}

// Finding C（Stage 1 review）：两个不同的已知 blocker 在同一轮校验里都可能被重新归属到
// 同一块显示器（例如各自所在的窗口都被拖到了同一块屏）。DisplayStateMap 的不变量是"每块
// 显示器至多一个 blocker"，塌缩成一个是对的，但选哪一个必须是一条写明的规则，不能任由
// map.values() 的遍历顺序（本质是原 Map 的插入顺序）替我们决定。
// 优先级（与 classify() 里"一个 blocker 内多个 reason 取最严重一档"同一个精神的
// 跨 blocker 版本，但这个跨 blocker 场景本身 docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」
// 未展开讨论，是本次实现补的细节）：
//   1) severity 更高者胜（hard > soft）——更严重的阻塞理由是这块显示器此刻更要紧的事实
//   2) severity 相同则 reasons 更多者胜——同一严重度下，被更多条独立规则命中的证据更充分
//   3) 仍然相同则 pid 更小者胜——纯粹为了让结果不依赖 Map 遍历顺序而选的确定性 tie-break，
//      不代表 pid 数值本身有任何业务含义
const SEVERITY_RANK: Record<Severity, number> = { soft: 0, hard: 1 }

// Stage 4 之前，Reason → Severity 是一张固定表，两个 reason 都映射到 'hard'，意味着
// decideBlockerAfterValidation 的真实产出永远不会是 'soft'——"severity 更高者胜"这一档当时
// 无法通过完整的 validateBlockers 流水线触发到，只能直接单测这个函数本身。Stage 4 引入真正的
// soft 规则（AppRule.effect === 'soft'）之后，这一档终于可以在端到端流程里被走到：两块屏各自
// 命中不同规则、被重新归属到同一块显示器时，soft/hard 之间的优先级现在是一条真实可达的路径
export function pickPrecedentBlocker(a: DisplayBlocker, b: DisplayBlocker): DisplayBlocker {
  if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
    return SEVERITY_RANK[a.severity] > SEVERITY_RANK[b.severity] ? a : b
  }
  if (a.reasons.size !== b.reasons.size) {
    return a.reasons.size > b.reasons.size ? a : b
  }
  return a.pid <= b.pid ? a : b
}

// 对整份 DisplayStateMap 做一轮校验。只遍历已知 blocker（map 自身的 key 集合），不枚举任何
// 顶层窗口——已知 blocker 数量以显示器数为上限，天然很小，这是 docs/MintBot_TDD.md §3.7 附
// 「桌面呈现状态机」"不 EnumWindows() 扫描桌面"一节的落地点。probe 以参数注入而不是在这里
// 直接调 Win32，让这个编排函数除了调用方传入的 probe 回调本身之外保持纯——可以在不启动真实
// koffi/Win32 的情况下用一个假的 probe 函数单测
export function validateBlockers(
  map: DisplayStateMap,
  rules: BlockingRules,
  probe: (hwnd: bigint, pid: number) => BlockerProbe,
  mode: ValidationMode = 'standard'
): DisplayStateMap {
  const next: DisplayStateMap = new Map()
  for (const blocker of map.values()) {
    const decided = decideBlockerAfterValidation(blocker, probe(blocker.hwnd, blocker.pid), rules, mode)
    if (decided === null) continue
    const collidingWith = next.get(decided.displayId)
    next.set(decided.displayId, collidingWith ? pickPrecedentBlocker(collidingWith, decided) : decided)
  }
  return next
}
