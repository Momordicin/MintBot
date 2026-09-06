// 悬浮窗立绘状态模型的转场链条部分（docs/MintBot_TDD.md「transitions：转场链条」「悬浮窗立绘
// 状态模型」附「唤醒与转场」「交互锁」）。与 portraitState.ts 同样的纯函数/副作用分离约定：
// 本文件不含任何 DOM / fetch / 定时器副作用，OverlayApp.tsx 只调用本文件的函数、自己维护
// 转场播放进度与交互锁这两项运行期状态（不放进这里，因为"当前播到第几步""现在几点"都是
// 运行期概念，硬塞进纯函数会破坏"纯函数只测输入输出"这个可测性）。

import {
  type OverlayManifest,
  type YState,
  pickRandom,
  resolveDisplayFile,
} from './portraitState.js'

// 四条转场链条（TDD「唤醒与转场」表格 + 「入睡转场 fall-asleep」）。poke-neutral 本批次
// 没有调用入口（仅拖拽可触发，批次 4 范围），但类型与解析逻辑照常支持它——批次任务书明确
// 要求"实现它，只是暂时没有触发它的入口"，不是遗漏。fall-asleep 与另外三条唤醒转场共用
// 同一套解析/播放/锁机制（是否上锁由调用方按 trigger 区分，见 OverlayApp.tsx
// startTransition），这里不需要为它单独开一个类型分支
export type TransitionTrigger = 'wake-from-sleep' | 'wake-from-bored' | 'poke-neutral' | 'fall-asleep'

// 唤醒前的 y → 对应转场链条名（TDD「唤醒与转场」表格）。YState 只有三个取值（睡着/无聊/空），
// 映射是满射，不存在"无对应转场"的第四分支
export function selectTransitionTrigger(previousY: YState): TransitionTrigger {
  if (previousY === 'sleeping') return 'wake-from-sleep'
  if (previousY === 'boredom-idle') return 'wake-from-bored'
  return 'poke-neutral'
}

// 入睡转场的触发判定（TDD「入睡转场 fall-asleep」表格：只有"距上次搭理满 60 分钟（运行期
// 计时）"这一条播，载入期判定与文本检测入睡都不播）。四个条件缺一不可：
//
// 1. calledByThresholdTimer——由调用方显式声明，不能靠其它状态推断。挂载 / preset-switched /
//    转场结束都会重新求值 y，但都不是阈值定时器触发的，不能误播
// 2. previousY !== 'sleeping'——已经是睡着说明这不是一次新的迁移（例如转场刚结束后的那次
//    重新求值），不该重播
// 3. nextY === 'sleeping'——确实迁移到了睡着
// 4. !explicitSleep——**这一条是把"文本检测入睡不播"真正落实的地方**。前三条只说明"是阈值
//    定时器这次轮询发现了睡着"，不说明"睡着是时长走到造成的"：显式睡着标记一旦被 §3.8 的
//    文本检测置上，就会一直挂到下一次 recordAttention 才清，于是**任意一次**后续的阈值定时器
//    轮询都会发现它并判成迁移，把本该静默到来的入睡播成动画。而 deriveY 是先看 explicitSleep
//    再查时长表，因此 "explicitSleep 为假且 nextY 为睡着" 恰好等价于"这次睡着来自 60 分钟
//    时长档"，正是表格里唯一该播的那一行。两者同时成立时也不会漏播：标记先到会让 y 早就
//    变成睡着，等时长真的走到时 previousY 已是 'sleeping'，被第 2 条挡住
export function shouldPlayFallAsleep(params: {
  calledByThresholdTimer: boolean
  previousY: YState
  nextY: YState
  explicitSleep: boolean
}): boolean {
  if (!params.calledByThresholdTimer) return false
  if (params.explicitSleep) return false
  return params.previousY !== 'sleeping' && params.nextY === 'sleeping'
}

// 防御性解析后、尚未做素材解析的单步（TDD「transitions」字段表：from/pick/durationMs）。
// keys 是 from 归一化 + 过滤后的结果——只接受 "emotions.<key>" 形式的条目（本批次任务书：
// "from entries are only accepted in emotions.<key> form"），其余形式（裸标签、
// reservedStates.*/interactionStates.* 等）被丢弃而不是报错：manifest 是手写的、渲染层
// 只做"能不能播"这一种防御性检查，不做"角色包作者是不是拼对了"这种告警（那是后端
// mergeTransitions 的职责，§892 附近架构决定原文）
interface ParsedTransitionStep {
  keys: string[]
  durationMs: number
}

// from 字段可以是单个字符串或字符串数组（TDD「from：可以是单个键……也可以是数组」），先统一
// 归一化成数组，再过滤只保留 "emotions.<key>" 形式的条目
function normalizeFromKeys(from: unknown): string[] {
  const entries: unknown[] = Array.isArray(from) ? from : from !== undefined ? [from] : []
  const prefix = 'emotions.'
  const keys: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.startsWith(prefix) && entry.length > prefix.length) {
      keys.push(entry.slice(prefix.length))
    }
  }
  return keys
}

// 逐步防御性解析一条转场链条的原始（未经素材解析的）声明。manifest.transitions 的类型是
// unknown（见 portraitState.ts OverlayManifest 注释），因此这里的每一层结构都要先判断再读，
// 不能假定手写 manifest 一定符合 schema。durationMs 必须是正的有限数，否则整步跳过
// （本批次任务书："durationMs must be a positive finite number or the step is skipped"）；
// from 归一化后一个可用键都没有，同样整步跳过——这一步在结构层面就"不可能播"，不需要留到
// 素材解析阶段才发现
function parseTransitionSteps(manifest: OverlayManifest, trigger: TransitionTrigger): ParsedTransitionStep[] {
  const raw = manifest.transitions?.[trigger]
  if (!Array.isArray(raw)) return []

  const steps: ParsedTransitionStep[] = []
  for (const rawStep of raw) {
    if (typeof rawStep !== 'object' || rawStep === null) continue
    const durationMs = (rawStep as Record<string, unknown>).durationMs
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) continue

    const keys = normalizeFromKeys((rawStep as Record<string, unknown>).from)
    if (keys.length === 0) continue

    steps.push({ keys, durationMs })
  }
  return steps
}

// 解析完成、可以直接播放的一步：具体文件 + 时长
export interface ResolvedTransitionStep {
  file: string
  durationMs: number
}

// 单步的素材解析（TDD「from 可以是数组（先在多个来源间随机挑一个）」+「pick：来源内的
// 选取方式，当前只有 random」）：先在 keys 里随机挑一个来源，再从
// portraits.pixel.emotions[key] 里随机挑一个文件。
// 随机之前先把"在本角色包里确实有素材"的来源筛出来，再在筛剩的里面挑：TDD 那句「先在多个
// 来源间随机挑一个」要表达的是同一步在不同回合呈现不同素材（变化感），不是"有几分之一的
// 概率什么都不播"。若不先筛，一条 from 数组里只要有一个键没素材，这一步能不能出现就变成
// 掷硬币——链条只有一步时整条转场都可能静默消失，用户看到的是"点了没反应"，多半会再点一下。
// 筛完仍然为空才判定该步解析不出，由调用方（resolveTransitionChain）跳过
function resolveStepFile(manifest: OverlayManifest, keys: string[]): string | null {
  const emotions = manifest.portraits?.pixel?.emotions ?? {}
  const usableKeys = keys.filter(key => (emotions[key]?.length ?? 0) > 0)
  if (usableKeys.length === 0) return null
  return pickRandom(emotions[pickRandom(usableKeys)])
}

// 完整解析一条转场链条：防御性解析 + 逐步素材解析，返回的是"确定能播"的步骤序列。
// 某一步素材解析不出则整步跳过（不占用播放时间——跳过的步骤既不显示也不计入总时长），
// 全部步骤都解析不出时返回空数组，调用方据此判定"当作没有转场，直接完成状态切换"
// （TDD「回落规则」"未声明 transitions 时不播转场，直接完成状态切换"；本批次任务书把
// "声明了但全部解析失败"归为同一种等价情况处理，理由相同：转场绝不能把立绘卡住）
export function resolveTransitionChain(
  manifest: OverlayManifest | undefined,
  trigger: TransitionTrigger,
): ResolvedTransitionStep[] {
  if (!manifest) return []

  const parsedSteps = parseTransitionSteps(manifest, trigger)
  const resolved: ResolvedTransitionStep[] = []
  for (const step of parsedSteps) {
    const file = resolveStepFile(manifest, step.keys)
    if (file === null) continue
    resolved.push({ file, durationMs: step.durationMs })
  }
  return resolved
}

// 转场的绝对结束时刻 = 播放开始时刻 + 全部已解析步骤的时长之和。交互锁的持续时间与这个
// 值直接绑定（TDD「交互锁」："转场开始的那一刻上锁……持续到转场的绝对结束时刻"）
export function transitionEndInstant(steps: ResolvedTransitionStep[], startedAt: number): number {
  const totalMs = steps.reduce((sum, step) => sum + step.durationMs, 0)
  return startedAt + totalMs
}

// 交互锁是否仍然锁着，只依赖时钟（本批次任务书："release depends only on the clock, never on
// whether material played"；TDD「交互锁」必须由构造保证的性质第一条）。lockedUntil 为 null
// 表示当前没有转场在播放，视为未锁——这让"现在锁着吗"在任意时刻都能独立判定，不依赖
// 播放定时器是否已经触发过回调
export function isTransitionLocked(lockedUntil: number | null, now: number): boolean {
  return lockedUntil !== null && now < lockedUntil
}

// 展示优先级新增转场这一层，且优先级最高（本批次任务书"Display priority becomes: transition
// (if playing) → y → x → declared fallback → blank"；对应 TDD「y 的求值顺序」"转场进行中 →
// y = 该转场"——转场是维护在接线层、凌驾于 y 之上的覆盖层，不是 YState 本身的第四个取值，
// 因此这里的类型签名里没有出现 YState 之外的新状态，只是多加一个前置分支）。转场播放期间
// 展示的文件由调用方（OverlayApp）在开始播放/切换到下一步时直接给出，不需要再走一遍
// y/x 回落链；转场不在播放时才回落到既有的 resolveDisplayFile
export function resolveOverlayDisplayFile(
  manifest: OverlayManifest | undefined,
  transitionFile: string | null,
  y: YState,
  x: string | undefined,
): string | null {
  if (transitionFile !== null) return transitionFile
  return resolveDisplayFile(manifest, y, x)
}
